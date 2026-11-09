'use strict';
// Royal Mail Click & Drop: eBay/Vinted-style postage. When an order is recorded as paid it is
// pushed to Click & Drop (POST /orders), the admin prints the Tracked 48 label (GET
// /orders/{ids}/label — OBA accounts only) and the tracking number comes back (GET /orders/{ids}).
// Docs: https://api.parcel.royalmail.com (Swagger 2.0, base https://api.parcel.royalmail.com/api/v1).
// The key (ROYALMAIL_API_KEY, from Click & Drop > Settings > Integrations > Click & Drop API) is
// only ever sent in the Authorization header: it is never logged, stored or returned to the browser.
const crypto = require('crypto');
const express = require('express');
const ordersStore = require('./orders-store');
const postage = require('./postage');

const API_BASE = 'https://api.parcel.royalmail.com/api/v1';
const CLICK_AND_DROP_URL = 'https://business.parcel.royalmail.com/';
const DEFAULT_SERVICE_CODE = 'TPS48'; // Royal Mail Tracked 48 (Click & Drop OBA code); override with ROYALMAIL_SERVICE_CODE
// Click & Drop packageFormatIdentifier for each of the shop's Tracked 48 size bands.
const PACKAGE_FORMAT = { 'Large Letter': 'largeLetter', 'Small Parcel': 'smallParcel' };
// Estimated weight per item when a product has no weight_g, and the Royal Mail max for the band.
const ITEM_WEIGHT_G = { 'Large Letter': 40, 'Small Parcel': 300 };
const PACKAGING_G = { 'Large Letter': 20, 'Small Parcel': 60 };
const MAX_WEIGHT_G = { 'Large Letter': 1000, 'Small Parcel': 2000 };
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000]; // automatic retries after a failed push
const trackingUrl = (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`;

function apiKey() { return String(process.env.ROYALMAIL_API_KEY || '').trim(); }
function configured() { return Boolean(apiKey()); }
function serviceCode() { return String(process.env.ROYALMAIL_SERVICE_CODE || DEFAULT_SERVICE_CODE).trim().toUpperCase().slice(0, 10); }

// ---------------- HTTP client (replaceable in tests: royalmail.getClient = () => fake) ----------------
class RoyalMailError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

/** Never let the key end up in an error message or log. */
function scrub(text) {
  const k = apiKey();
  let s = String(text == null ? '' : text);
  if (k) s = s.split(k).join('[key]');
  return s.slice(0, 500);
}

function errorText(status, body) {
  if (status === 401) return 'Royal Mail rejected the API key (401). Check ROYALMAIL_API_KEY on Render.';
  if (status === 403) return 'Royal Mail says this account cannot do that (403). Label printing through the API needs an Online Business Account (OBA).';
  if (status === 429) return 'Royal Mail rate limit hit (429). Try again in a moment.';
  let msg = '';
  if (body && typeof body === 'object') {
    if (Array.isArray(body)) msg = body.map((e) => e.message || e.errorMessage || '').filter(Boolean).join('; ');
    else msg = [body.message, body.details].filter(Boolean).join(' — ');
  } else if (body) msg = String(body);
  return `Royal Mail error ${status}${msg ? ': ' + msg : ''}`;
}

function makeClient({ key = apiKey(), fetchImpl = globalThis.fetch, base = API_BASE } = {}) {
  async function call(method, path, body, { pdf = false } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: pdf ? 'application/pdf, application/json' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
      });
    } catch (err) {
      throw new RoyalMailError(`Could not reach Royal Mail: ${scrub(err.message)}`, 0);
    }
    const type = res.headers.get('content-type') || '';
    if (res.ok && pdf && /pdf/.test(type)) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new RoyalMailError(scrub(errorText(res.status, data)), res.status, data);
    return data;
  }
  return {
    createOrders: (items) => call('POST', '/orders', { items }),
    getOrders: (identifiers) => call('GET', `/orders/${identifiers}`),
    getLabel: (identifiers) => call('GET', `/orders/${identifiers}/label?documentType=postageLabel&includeReturnsLabel=false&includeCN=false`, null, { pdf: true }),
    getServices: () => call('GET', '/services'),
  };
}

const api = { getClient: () => makeClient() };

/** Order identifiers for the URL: integer ids as-is, references "quoted" + percent-encoded; max 100. */
function identifierList(list) {
  return list.slice(0, 100).map((x) => (Number.isInteger(x) ? String(x) : `"${encodeURIComponent(String(x))}"`)).join(';');
}

// ---------------- Building the Click & Drop order ----------------
/** Click & Drop order reference (max 40 chars): short, stable and unique per shop order. */
function referenceFor(order) {
  const id = String(order.id);
  if (id.length <= 32) return `PMF-${id}`;
  return `PMF-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16).toUpperCase()}`;
}

function bandOf(order) {
  return postage.parseBand(order.postage && order.postage.band) || 'Large Letter';
}

/** Estimated parcel weight in grams: product weight_g (if set) else a per-band estimate, plus packaging, capped at the band max. */
function weightFor(order) {
  const band = bandOf(order);
  const items = order.items || [];
  const itemWeight = (l) => (Number(l.weight_g) > 0 ? Number(l.weight_g) : ITEM_WEIGHT_G[postage.bandForProduct(l)] || ITEM_WEIGHT_G[band]);
  const sum = items.reduce((g, l) => g + (Number(l.qty) || 1) * itemWeight(l), 0);
  return Math.max(1, Math.min(MAX_WEIGHT_G[band], Math.round(sum + PACKAGING_G[band])));
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cut = (s, n) => String(s == null ? '' : s).trim().slice(0, n) || undefined;

/** CreateOrderRequest for one shop order. */
function buildOrderRequest(order) {
  const a = order.shipping_address || {};
  const band = bandOf(order);
  const shipping = money(order.postage && order.postage.amount);
  const subtotal = money(order.subtotal);
  const contents = (order.items || []).map((l) => ({
    name: cut(l.title || l.productId, 800),
    quantity: Math.max(1, Number(l.qty) || 1),
    unitValue: money(l.price_gbp),
    unitWeightInGrams: Math.round(Number(l.weight_g) > 0 ? Number(l.weight_g) : ITEM_WEIGHT_G[postage.bandForProduct(l)] || ITEM_WEIGHT_G[band]),
  }));
  return {
    orderReference: referenceFor(order),
    recipient: {
      address: {
        fullName: cut(a.name, 210),
        addressLine1: cut(a.line1, 100),
        addressLine2: cut(a.line2, 100),
        city: cut(a.town, 100),
        county: cut(a.county, 100),
        postcode: cut(a.postcode, 20),
        countryCode: 'GB',
      },
      phoneNumber: cut(a.phone, 25),
      emailAddress: cut(order.email, 254),
    },
    packages: [{ weightInGrams: weightFor(order), packageFormatIdentifier: PACKAGE_FORMAT[band] || 'largeLetter', contents }],
    orderDate: new Date(order.createdAt || Date.now()).toISOString(),
    subtotal,
    shippingCostCharged: shipping,
    total: money(order.total != null ? order.total : subtotal + shipping),
    currencyCode: 'GBP',
    postageDetails: {
      serviceCode: serviceCode(),
      sendNotificationsTo: 'recipient',
      receiveEmailNotification: Boolean(order.email),
      receiveSmsNotification: false,
    },
  };
}

// ---------------- Order tracker: stage, problems, history ----------------
function historyEntry(event, note) { return { at: new Date().toISOString(), event, ...(note ? { note: String(note).slice(0, 300) } : {}) }; }

/** Patch helper: appends a history entry to the order (inside ordersStore.update, so no lost updates). */
function withHistory(fields, event, note) {
  return (cur) => ({ ...(typeof fields === 'function' ? fields(cur) : fields), history: [...(cur.history || []), historyEntry(event, note)] });
}

/** Should this order go to Click & Drop at all? */
function eligible(o) {
  return Boolean(o && !o.demo && o.status === 'paid' && o.shipping_address && o.shipping_address.line1);
}

/** Fulfilment stage shown in the admin tracker. */
function stageOf(o) {
  if (o.status === 'posted') return 'shipped';
  if (o.status === 'refunded' || o.status === 'cancelled') return o.status;
  const rm = o.royalmail || {};
  if (rm.labelPrintedAt || o.label_printed_at) return 'label_printed';
  if (rm.orderIdentifier) return 'sent';
  return 'paid';
}

function problemsOf(o) {
  const p = [];
  const open = o.status === 'paid';
  const rm = o.royalmail || {};
  if (open && rm.state === 'error') p.push(`Royal Mail: ${rm.lastError || 'could not send'}`);
  if (o.stock_conflict) p.push('Stock clash — check before posting');
  if (open && (!o.shipping_address || !o.shipping_address.line1)) p.push('No delivery address');
  if (o.address_problem) p.push(`Address: ${o.address_problem}`);
  return p;
}

/** Status history with timestamps: stored entries, plus ones worked out for older orders. */
function historyOf(o) {
  const h = Array.isArray(o.history) ? o.history.slice() : [];
  const has = (ev) => h.some((x) => x.event === ev);
  if (!has('Paid') && o.createdAt) h.push({ at: o.createdAt, event: 'Paid', note: o.demo ? 'demo order' : o.method || undefined });
  if (o.posted_at && !has('Shipped')) h.push({ at: o.posted_at, event: 'Shipped', note: o.tracking_number || undefined });
  if (o.refunded_at && !has('Refunded')) h.push({ at: o.refunded_at, event: 'Refunded' });
  if (o.cancelled_at && !has('Cancelled')) h.push({ at: o.cancelled_at, event: 'Cancelled' });
  return h.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Extra fields the admin order list needs. */
function trackerInfo(o) {
  const rm = o.royalmail || {};
  return {
    stage: stageOf(o),
    problems: problemsOf(o),
    history: historyOf(o),
    tracking_url: o.tracking_number ? trackingUrl(o.tracking_number) : null,
    royalmail: {
      state: rm.state || (o.demo ? 'demo' : eligible(o) ? (configured() ? 'pending' : 'not_connected') : 'none'),
      orderIdentifier: rm.orderIdentifier || null,
      orderReference: rm.orderReference || null,
      lastError: rm.lastError || null,
      attempts: rm.attempts || 0,
      sentAt: rm.sentAt || null,
      labelPrintedAt: rm.labelPrintedAt || null,
    },
  };
}

// ---------------- Push to Click & Drop (idempotent) ----------------
const INFLIGHT = new Map(); // order id -> promise
const TIMERS = new Map(); // order id -> retry timer
const state = { labelsApi: null, lastSyncAt: 0, lastCheck: null };

function scheduleRetry(id, attempts) {
  if (TIMERS.has(id) || attempts > RETRY_DELAYS_MS.length) return;
  const t = setTimeout(() => { TIMERS.delete(id); pushOrder(id, { auto: true }).catch(() => {}); }, RETRY_DELAYS_MS[attempts - 1]);
  if (t.unref) t.unref();
  TIMERS.set(id, t);
}

/** Look for an order already in Click & Drop with this reference (after a timeout we can't tell if it was created). */
async function findExisting(client, ref) {
  try {
    const found = await client.getOrders(identifierList([ref]));
    const hit = Array.isArray(found) ? found.find((x) => x && x.orderIdentifier) : null;
    return hit || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Send one paid order to Click & Drop. Safe to call any number of times: an order that already has a
 * Click & Drop orderIdentifier is never sent again, concurrent calls share one request, and a retry
 * after an unclear failure first looks the order up by its reference.
 * Returns { sent, skipped?, error?, order }.
 */
function pushOrder(id, { auto = false } = {}) {
  if (INFLIGHT.has(id)) return INFLIGHT.get(id);
  const work = (async () => {
    const o = ordersStore.find(id);
    if (!o) return { sent: false, skipped: 'not found' };
    if (o.royalmail && o.royalmail.orderIdentifier) return { sent: false, skipped: 'already sent', order: o };
    if (!eligible(o)) return { sent: false, skipped: o.demo ? 'demo order' : 'not a paid order with an address', order: o };
    if (!configured()) return { sent: false, skipped: 'not connected', order: o };
    const ref = (o.royalmail && o.royalmail.orderReference) || referenceFor(o);
    const attempts = ((o.royalmail && o.royalmail.attempts) || 0) + 1;
    const client = api.getClient();
    try {
      let created = attempts > 1 ? await findExisting(client, ref) : null;
      if (!created) {
        const r = await client.createOrders([{ ...buildOrderRequest(o), orderReference: ref }]);
        created = r && Array.isArray(r.createdOrders) ? r.createdOrders[0] : null;
        if (!created) {
          const f = r && Array.isArray(r.failedOrders) ? r.failedOrders[0] : null;
          const msg = f && f.errors ? f.errors.map((e) => e.errorMessage + (e.fields && e.fields.length ? ` (${e.fields.map((x) => x.fieldName).join(', ')})` : '')).join('; ') : 'no order returned';
          const e = new Error(`Click & Drop did not accept the order: ${msg}`);
          e.permanent = true; // bad data: retrying the same thing won't help
          throw e;
        }
      }
      const tracking = created.trackingNumber && !/_CON$/.test(created.trackingNumber) ? created.trackingNumber
        : created.packages && created.packages[0] && created.packages[0].trackingNumber;
      const r = await ordersStore.update(id, withHistory((cur) => ({
        royalmail: { ...(cur.royalmail || {}), state: 'sent', orderIdentifier: created.orderIdentifier, orderReference: created.orderReference || ref, attempts, lastError: null, sentAt: new Date().toISOString(), serviceCode: serviceCode() },
        ...(tracking && !cur.tracking_number ? { tracking_number: tracking, tracking_source: 'royalmail' } : {}),
      }), 'Sent to Royal Mail', `Click & Drop order ${created.orderIdentifier}`));
      return { sent: true, order: r.order };
    } catch (err) {
      const msg = scrub(err.message);
      console.error(`Royal Mail: order ${id} not sent (attempt ${attempts}): ${msg}`);
      const r = await ordersStore.update(id, withHistory((cur) => ({
        royalmail: { ...(cur.royalmail || {}), state: 'error', orderReference: ref, attempts, lastError: msg, lastTriedAt: new Date().toISOString() },
      }), 'Royal Mail error', msg));
      if (!err.permanent && err.status !== 401 && err.status !== 400 && err.status !== 403) scheduleRetry(id, attempts);
      return { sent: false, error: msg, order: r.order };
    }
  })();
  INFLIGHT.set(id, work);
  const done = () => INFLIGHT.delete(id);
  work.then(done, done);
  return work;
}

/** Called after an order is saved: push it in the background (never blocks or breaks checkout). */
function onOrderPaid(order) {
  if (!order || !eligible(order) || !configured()) return null;
  return pushOrder(order.id).catch((err) => console.error('Royal Mail push failed:', scrub(err.message)));
}

/** Startup / admin: send every paid order that hasn't reached Click & Drop yet. */
async function pushUnsent() {
  if (!configured()) return { tried: 0, sent: 0 };
  const list = ordersStore.all().filter((o) => eligible(o) && !(o.royalmail && o.royalmail.orderIdentifier));
  let sent = 0;
  for (const o of list) if ((await pushOrder(o.id)).sent) sent++;
  return { tried: list.length, sent };
}

/** Wait for background pushes (tests). */
async function flush() { while (INFLIGHT.size) await Promise.all([...INFLIGHT.values()]); }

// ---------------- Labels ----------------
function labelTargets(ids) {
  const all = ordersStore.all();
  const pick = ids && ids.length ? ids.map((id) => all.find((o) => o.id === id)).filter(Boolean)
    : all.filter((o) => o.status === 'paid' && !o.demo); // bulk: every unshipped order
  return pick.filter((o) => o.status === 'paid' && o.royalmail && o.royalmail.orderIdentifier);
}

/** One PDF with the Tracked 48 labels for these orders (max 100). Marks them Label printed. */
async function labelsPdf(ids) {
  if (!configured()) { const e = new Error('Royal Mail is not connected (add ROYALMAIL_API_KEY on Render).'); e.status = 503; throw e; }
  const targets = labelTargets(ids).slice(0, 100);
  if (!targets.length) { const e = new Error('No orders with a Click & Drop order to print. Send them to Royal Mail first.'); e.status = 400; throw e; }
  let pdf;
  try {
    pdf = await api.getClient().getLabel(identifierList(targets.map((o) => o.royalmail.orderIdentifier)));
    state.labelsApi = true;
  } catch (err) {
    if (err.status === 403) {
      state.labelsApi = false;
      const e = new Error('Your Click & Drop account can\'t print labels through the API (Royal Mail only allows this for Online Business Accounts). Open Click & Drop and print the label there — the tracking number will still come back here.');
      e.status = 403; e.fallback = CLICK_AND_DROP_URL;
      throw e;
    }
    throw err;
  }
  if (!Buffer.isBuffer(pdf) || pdf.slice(0, 4).toString() !== '%PDF') { const e = new Error('Royal Mail did not return a PDF label'); e.status = 502; throw e; }
  for (const o of targets) {
    const first = !(o.royalmail && o.royalmail.labelPrintedAt);
    await ordersStore.update(o.id, (cur) => ({
      royalmail: { ...(cur.royalmail || {}), labelPrintedAt: (cur.royalmail && cur.royalmail.labelPrintedAt) || new Date().toISOString(), lastLabelAt: new Date().toISOString() },
      history: first ? [...(cur.history || []), historyEntry('Label printed')] : cur.history || [],
    }));
  }
  syncTracking(targets.map((o) => o.id)).catch((err) => console.error('Royal Mail tracking sync failed:', scrub(err.message)));
  return { pdf, count: targets.length, ids: targets.map((o) => o.id) };
}

// ---------------- Tracking sync ----------------
/** Pull tracking numbers / printed / shipped dates back from Click & Drop for open orders. */
async function syncTracking(ids) {
  if (!configured()) return { checked: 0, updated: 0, skipped: 'not connected' };
  const all = ordersStore.all();
  const open = all.filter((o) => (!ids || ids.includes(o.id)) && o.royalmail && o.royalmail.orderIdentifier && o.status === 'paid');
  let updated = 0;
  const client = api.getClient();
  for (let i = 0; i < open.length; i += 100) {
    const chunk = open.slice(i, i + 100);
    const info = await client.getOrders(identifierList(chunk.map((o) => o.royalmail.orderIdentifier)));
    for (const r of Array.isArray(info) ? info : []) {
      const o = chunk.find((x) => x.royalmail.orderIdentifier === r.orderIdentifier);
      if (!o) continue;
      const pkg = r.packages && r.packages[0] && r.packages[0].trackingNumber;
      const tracking = r.trackingNumber && !/_CON$/.test(r.trackingNumber) ? r.trackingNumber : pkg || null;
      const before = JSON.stringify(o);
      await ordersStore.update(o.id, (cur) => {
        const rm = { ...(cur.royalmail || {}), lastSyncAt: new Date().toISOString() };
        const history = [...(cur.history || [])];
        const patch = { royalmail: rm };
        if (r.printedOn && !rm.labelPrintedAt) { rm.labelPrintedAt = r.printedOn; history.push({ at: r.printedOn, event: 'Label printed', note: 'in Click & Drop' }); }
        if (tracking && cur.tracking_source !== 'manual' && cur.tracking_number !== tracking) {
          patch.tracking_number = String(tracking).toUpperCase().replace(/\s+/g, '').slice(0, 40);
          patch.tracking_source = 'royalmail';
          history.push(historyEntry('Tracking number from Royal Mail', patch.tracking_number));
        }
        if (r.shippedOn && cur.status === 'paid' && (patch.tracking_number || cur.tracking_number)) {
          patch.status = 'posted';
          patch.posted_at = r.shippedOn;
          history.push({ at: r.shippedOn, event: 'Shipped', note: 'despatched in Click & Drop' });
        }
        patch.history = history;
        return patch;
      });
      // only count real changes (lastSyncAt alone doesn't count)
      const after = ordersStore.find(o.id);
      const strip = (x) => JSON.stringify({ ...x, updatedAt: 0, royalmail: { ...x.royalmail, lastSyncAt: 0 } });
      if (strip(after) !== strip(JSON.parse(before))) updated++;
    }
  }
  state.lastSyncAt = Date.now();
  return { checked: open.length, updated };
}

function status() {
  return {
    connected: configured(),
    serviceCode: serviceCode(),
    labelsApi: state.labelsApi, // null = not tried yet, false = account can't (not OBA)
    clickAndDropUrl: CLICK_AND_DROP_URL,
    lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
    lastCheck: state.lastCheck,
  };
}

// ---------------- Admin routes (mounted at /api/admin/royalmail, behind the admin login) ----------------
const adminRouter = express.Router();

adminRouter.get('/status', (_req, res) => res.json(status()));

// Test the key and list the Tracked services on the account (to check the service code).
adminRouter.post('/check', async (_req, res) => {
  if (!configured()) return res.json({ ...status(), ok: false, error: 'Not connected: add ROYALMAIL_API_KEY on Render.' });
  try {
    const groups = await api.getClient().getServices();
    const services = (Array.isArray(groups) ? groups : []).flatMap((g) => (g.services || []).map((s) => ({ carrier: g.carrierName, code: s.serviceCode, name: s.serviceName })));
    const tracked = services.filter((s) => /tracked/i.test(s.name || ''));
    const hasCode = services.some((s) => s.code === serviceCode());
    state.lastCheck = { at: new Date().toISOString(), ok: true, hasCode };
    res.json({ ...status(), ok: true, hasServiceCode: hasCode, tracked: tracked.slice(0, 30) });
  } catch (err) {
    state.lastCheck = { at: new Date().toISOString(), ok: false, error: err.message };
    res.status(err.status === 401 ? 401 : 502).json({ ...status(), ok: false, error: err.message });
  }
});

adminRouter.post('/orders/:id/push', async (req, res) => {
  const o = ordersStore.find(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!configured()) return res.status(503).json({ error: 'Royal Mail is not connected (add ROYALMAIL_API_KEY on Render).' });
  const r = await pushOrder(o.id);
  if (r.error) return res.status(502).json({ error: r.error, order: r.order });
  res.json(r);
});

adminRouter.post('/push-unsent', async (_req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Royal Mail is not connected (add ROYALMAIL_API_KEY on Render).' });
  res.json(await pushUnsent());
});

adminRouter.post('/sync', async (_req, res) => {
  try { res.json({ ...(await syncTracking()), status: status() }); } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /labels?ids=a,b  (no ids = every unshipped order already in Click & Drop) -> one PDF
adminRouter.get('/labels', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const r = await labelsPdf(ids);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="royal-mail-labels-${r.count}.pdf"`);
    res.setHeader('X-Label-Count', String(r.count));
    res.setHeader('Cache-Control', 'no-store');
    res.send(r.pdf);
  } catch (err) {
    res.status(err.status && err.status >= 400 ? err.status : 502).json({ error: err.message, fallback: err.fallback || null });
  }
});

module.exports = {
  api, makeClient, RoyalMailError, configured, serviceCode, status, buildOrderRequest, referenceFor, weightFor, identifierList,
  pushOrder, onOrderPaid, pushUnsent, flush, labelsPdf, syncTracking, stageOf, problemsOf, historyOf, trackerInfo,
  withHistory, historyEntry, eligible, trackingUrl, adminRouter, scrub, CLICK_AND_DROP_URL, DEFAULT_SERVICE_CODE, PACKAGE_FORMAT,
  _state: state,
  _reset() { for (const t of TIMERS.values()) clearTimeout(t); TIMERS.clear(); INFLIGHT.clear(); state.labelsApi = null; state.lastSyncAt = 0; state.lastCheck = null; },
};
