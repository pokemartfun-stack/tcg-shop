'use strict';
// Royal Mail Click & Drop: building the order, idempotent push from the paid-order paths (Stripe
// webhook + success page, PayPal), retries + error state, labels (OBA PDF / non-OBA fallback),
// tracking sync, admin order tracker, packing slips, persistence in the private orders repo.
// Uses a FAKE Royal Mail client and a mocked GitHub — no network.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-royalmail-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'card', title: 'Charizard <b>holo</b>', price_gbp: 4, stock: 100, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'box', title: 'Booster box', price_gbp: 12, stock: 100, condition: 'New (sealed)', category: 'Sealed products', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.REVIEWS_FILE = P('reviews.json');
process.env.ADMIN_PASSWORD = 'rm-test-owner';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'owner/shop';
process.env.GITHUB_WRITE_GAP_MS = '0';
process.env.ORDERS_GITHUB_REPO = 'owner/orders';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake_for_tests';
const WHSEC = 'whsec_rm_tests';
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
process.env.PAYPAL_CLIENT_ID = 'paypal-client-test';
const RM_KEY = 'rm-secret-key-1234567890';
delete process.env.ROYALMAIL_API_KEY;
delete process.env.ROYALMAIL_SERVICE_CODE;

// ---- mocked GitHub: private orders repo ----
const files = new Map();
const realFetch = global.fetch;
const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^https:\/\/api\.github\.com\/repos\/owner\/orders$/.test(u)) return json({ full_name: 'owner/orders', private: true });
  const m = u.match(/^https:\/\/api\.github\.com\/repos\/owner\/(orders|shop)\/contents\/([^?]*)/);
  if (!m) {
    if (/api\.github\.com/.test(u)) return json({ message: 'Not Found' }, 404);
    if (/parcel\.royalmail\.com/.test(u)) throw new Error('tests must never call the real Royal Mail API');
    return realFetch(url, opts);
  }
  const file = `${m[1]}:${decodeURIComponent(m[2])}`;
  if ((opts.method || 'GET') === 'GET') return files.has(file) ? json({ type: 'file', sha: 's' + files.get(file).v, content: files.get(file).buf.toString('base64') }) : json({ message: 'Not Found' }, 404);
  const body = JSON.parse(opts.body);
  const cur = files.get(file);
  files.set(file, { buf: Buffer.from(body.content, 'base64'), v: cur ? cur.v + 1 : 1 });
  return json({ content: { sha: 'x' } }, 201);
};
const repoOrder = (o) => {
  const f = [...files.keys()].find((k) => k.startsWith('orders:orders/') && k.endsWith(`/${o}.json`));
  return f ? JSON.parse(files.get(f).buf.toString('utf8')) : null;
};

// ---- fake Royal Mail Click & Drop client ----
const PDF = Buffer.from('%PDF-1.4\n% fake label\n');
const rmFake = {
  orders: new Map(), // orderIdentifier -> { ref, trackingNumber, printedOn, shippedOn }
  calls: [], failCreate: null, labelStatus: 200, nextId: 5001,
  reset() { this.orders.clear(); this.calls = []; this.failCreate = null; this.labelStatus = 200; },
};
const royalmail = require('../server/royalmail');
royalmail.api.getClient = () => ({
  async createOrders(items) {
    rmFake.calls.push({ op: 'create', items });
    if (rmFake.failCreate) {
      const f = rmFake.failCreate; rmFake.failCreate = f.once ? null : f;
      if (f.timeoutButCreated) { rmFake.orders.set(rmFake.nextId++, { ref: items[0].orderReference }); }
      throw new royalmail.RoyalMailError(f.message || 'Could not reach Royal Mail: timeout', f.status || 0);
    }
    if (!items[0].recipient.address.postcode) return { successCount: 0, errorsCount: 1, createdOrders: [], failedOrders: [{ errors: [{ errorCode: 1, errorMessage: 'Postcode is required', fields: [{ fieldName: 'postcode' }] }] }] };
    const id = rmFake.nextId++;
    rmFake.orders.set(id, { ref: items[0].orderReference });
    return { successCount: 1, errorsCount: 0, createdOrders: [{ orderIdentifier: id, orderReference: items[0].orderReference, createdOn: new Date().toISOString() }], failedOrders: [] };
  },
  async getOrders(ids) {
    rmFake.calls.push({ op: 'get', ids });
    const out = [];
    for (const part of ids.split(';')) {
      const ref = /^"(.*)"$/.exec(part);
      for (const [id, o] of rmFake.orders) if (ref ? o.ref === decodeURIComponent(ref[1]) : String(id) === part) out.push({ orderIdentifier: id, orderReference: o.ref, createdOn: '2026-11-01T10:00:00Z', trackingNumber: o.trackingNumber, printedOn: o.printedOn, shippedOn: o.shippedOn });
    }
    if (!out.length) throw new royalmail.RoyalMailError('Royal Mail error 404', 404);
    return out;
  },
  async getLabel(ids) {
    rmFake.calls.push({ op: 'label', ids });
    if (rmFake.labelStatus !== 200) throw new royalmail.RoyalMailError('Royal Mail says this account cannot do that (403).', rmFake.labelStatus);
    for (const part of ids.split(';')) { const o = rmFake.orders.get(Number(part)); if (o) { o.printedOn = o.printedOn || new Date().toISOString(); o.trackingNumber = o.trackingNumber || `TT${part}0000GB`; } }
    return PDF;
  },
  async getServices() {
    rmFake.calls.push({ op: 'services' });
    return [{ carrierGuid: 'c', carrierName: 'Royal Mail', services: [{ carrierServiceGuid: 's1', serviceName: 'Royal Mail Tracked 48', serviceCode: 'TPS48' }, { carrierServiceGuid: 's2', serviceName: 'Royal Mail Tracked 24', serviceCode: 'TPN24' }] }];
  },
});

// ---- fake Stripe (real signature helper) ----
const payments = require('../server/payments');
const realStripe = new Stripe('sk_test_fake_for_tests');
const SESSIONS = new Map();
let nextSession = 1;
payments.getStripe = () => ({
  webhooks: realStripe.webhooks,
  checkout: { sessions: {
    create: async (params) => {
      const id = `cs_test_${String(nextSession++).padStart(4, '0')}_a_rather_long_stripe_session_identifier_xyz`;
      SESSIONS.set(id, { id, object: 'checkout.session', payment_status: 'unpaid', amount_total: 1000, currency: 'gbp', customer_email: params.customer_email, metadata: params.metadata });
      return { id, url: `https://checkout.stripe.test/${id}` };
    },
    retrieve: async (id) => SESSIONS.get(id),
  } },
});

const ordersStore = require('../server/orders-store');
const app = require('../server/index');
const BUYER = { email: 'brock@example.com', address: { name: 'Brock Harrison', line1: '1 Pewter Gym', line2: '', town: 'Leeds', county: 'West Yorkshire', postcode: 'ls1 4ap', phone: '07700 900456' } };

let server, base, adminToken;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'rm-test-owner' }) });
  adminToken = (await r.json()).token;
});
after(() => {
  server.close();
  royalmail._reset();
  global.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => { rmFake.reset(); royalmail._reset(); process.env.ROYALMAIL_API_KEY = RM_KEY; });

async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.shopper) headers['x-session-token'] = opts.shopper;
  if (opts.admin) headers.Authorization = 'Bearer ' + adminToken;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  const data = /json/.test(type) ? await res.json() : /pdf/.test(type) ? Buffer.from(await res.arrayBuffer()) : await res.text();
  const m = (res.headers.get('set-cookie') || '').match(/session=([^;]+)/);
  return { status: res.status, data, type, headers: res.headers, session: m && decodeURIComponent(m[1]) };
}
const admin = (method, url, body) => call(method, '/api/admin' + url, body, { admin: true });

async function basket(lines) {
  const shopper = (await call('GET', '/api/cart')).session;
  for (const [productId, qty] of lines) assert.equal((await call('POST', '/api/cart/add', { productId, qty }, { shopper })).status, 200);
  return shopper;
}
async function paypalOrder(lines, paypalOrderId, buyer = BUYER) {
  const shopper = await basket(lines);
  const r = await call('POST', '/api/checkout/paypal/record', { ...buyer, paypalOrderId }, { shopper });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await royalmail.flush();
  return ordersStore.find(r.data.order.id);
}
function sendWebhook(session) {
  const payload = JSON.stringify({ id: 'evt_' + session.id, object: 'event', type: 'checkout.session.completed', data: { object: session } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  return fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload }).then((r) => r.json());
}
const creates = () => rmFake.calls.filter((c) => c.op === 'create');

describe('Royal Mail order request', () => {
  const order = {
    id: 'cs_live_' + 'x'.repeat(60), email: 'a@b.com', createdAt: '2026-11-01T10:00:00Z', subtotal: 16, total: 19.75,
    postage: { band: 'Small Parcel', amount: 3.75 },
    items: [{ productId: 'card', title: 'Card', price_gbp: 4, qty: 1, postage_band: 'Large Letter' }, { productId: 'box', title: 'Box', price_gbp: 12, qty: 1, postage_band: 'Small Parcel', weight_g: 450 }],
    shipping_address: { name: 'Ash K', line1: '1 Road', line2: 'Flat 2', town: 'Pallet', county: '', postcode: 'SW1A 1AA', phone: '07700 900000' },
  };
  it('maps the shop order to a Click & Drop CreateOrderRequest (Tracked 48, band → package format, weight, reference ≤ 40)', () => {
    delete process.env.ROYALMAIL_SERVICE_CODE;
    const r = royalmail.buildOrderRequest(order);
    assert.ok(r.orderReference.length <= 40 && r.orderReference.startsWith('PMF-'));
    assert.equal(r.orderReference, royalmail.referenceFor(order), 'stable reference');
    assert.equal(royalmail.referenceFor({ id: 'pp_abc123' }), 'PMF-pp_abc123');
    assert.deepEqual(r.recipient.address, { fullName: 'Ash K', addressLine1: '1 Road', addressLine2: 'Flat 2', city: 'Pallet', county: undefined, postcode: 'SW1A 1AA', countryCode: 'GB' });
    assert.equal(r.recipient.phoneNumber, '07700 900000');
    assert.equal(r.recipient.emailAddress, 'a@b.com');
    assert.equal(r.packages[0].packageFormatIdentifier, 'smallParcel');
    assert.equal(r.packages[0].weightInGrams, 40 + 450 + 60);
    assert.equal(r.packages[0].contents.length, 2);
    assert.equal(r.postageDetails.serviceCode, 'TPS48');
    assert.deepEqual([r.subtotal, r.shippingCostCharged, r.total, r.currencyCode], [16, 3.75, 19.75, 'GBP']);
    process.env.ROYALMAIL_SERVICE_CODE = 'tpl48hv';
    assert.equal(royalmail.buildOrderRequest(order).postageDetails.serviceCode, 'TPL48HV');
    delete process.env.ROYALMAIL_SERVICE_CODE;
  });
  it('Large Letter orders are largeLetter and never heavier than 1 kg', () => {
    const r = royalmail.buildOrderRequest({ ...order, postage: { band: 'large_letter', amount: 2.9 }, items: [{ title: 'Lot', price_gbp: 1, qty: 99, postage_band: 'Large Letter' }] });
    assert.equal(r.packages[0].packageFormatIdentifier, 'largeLetter');
    assert.equal(r.packages[0].weightInGrams, 1000);
  });
  it('identifier list: integers as-is, references quoted + encoded, max 100', () => {
    assert.equal(royalmail.identifierList([12, 'PMF-a;b']), '12;"PMF-a%3Bb"');
    assert.equal(royalmail.identifierList(Array.from({ length: 150 }, (_, i) => i)).split(';').length, 100);
  });
  it('the HTTP client sends the key only in the Authorization header and scrubs it from errors', async () => {
    const seen = [];
    const fakeFetch = async (url, opts) => { seen.push({ url, opts }); return new Response(JSON.stringify({ message: `bad key ${RM_KEY}` }), { status: 400, headers: { 'content-type': 'application/json' } }); };
    const c = royalmail.makeClient({ key: RM_KEY, fetchImpl: fakeFetch });
    await assert.rejects(c.createOrders([{}]), (err) => { assert.ok(!err.message.includes(RM_KEY)); assert.equal(err.status, 400); return true; });
    assert.equal(seen[0].url, 'https://api.parcel.royalmail.com/api/v1/orders');
    assert.equal(seen[0].opts.headers.Authorization, `Bearer ${RM_KEY}`);
    assert.ok(!seen[0].opts.body.includes(RM_KEY));
  });
});

describe('Not connected (no ROYALMAIL_API_KEY)', () => {
  it('shop and orders work as before; nothing is pushed; admin shows not connected; labels 503; packing slip still works', async () => {
    delete process.env.ROYALMAIL_API_KEY;
    const o = await paypalOrder([['card', 1]], 'PAYPAL-NOKEY-1');
    assert.equal(creates().length, 0);
    assert.equal(o.royalmail, undefined);
    const st = await admin('GET', '/royalmail/status');
    assert.equal(st.data.connected, false);
    assert.ok(!JSON.stringify(st.data).includes(RM_KEY));
    const list = await admin('GET', '/orders?all=1');
    const row = list.data.orders.find((x) => x.id === o.id);
    assert.equal(row.stage, 'paid');
    assert.equal(row.royalmail.state, 'not_connected');
    assert.equal(list.data.royalmail.connected, false);
    assert.equal((await admin('GET', '/royalmail/labels')).status, 503);
    assert.equal((await admin('POST', `/royalmail/orders/${o.id}/push`)).status, 503);
    const slip = await admin('GET', `/orders/${o.id}/packing-slip`);
    assert.equal(slip.status, 200);
    assert.match(slip.data, /Brock Harrison/);
  });
});

describe('Push to Click & Drop when an order is paid', () => {
  it('PayPal order: pushed once, Click & Drop id stored, history Paid → Sent to Royal Mail', async () => {
    const o = await paypalOrder([['card', 2]], 'PAYPAL-OK-1');
    assert.equal(creates().length, 1);
    const sent = creates()[0].items[0];
    assert.equal(sent.recipient.address.fullName, 'Brock Harrison');
    assert.equal(sent.recipient.address.postcode, 'LS1 4AP');
    assert.equal(sent.recipient.phoneNumber, '07700 900456');
    assert.equal(sent.packages[0].packageFormatIdentifier, 'largeLetter');
    assert.equal(sent.orderReference, 'PMF-PAYPAL-OK-1');
    assert.equal(o.royalmail.state, 'sent');
    assert.ok(Number.isInteger(o.royalmail.orderIdentifier));
    assert.deepEqual(o.history.map((h) => h.event), ['Paid', 'Sent to Royal Mail']);
    // pushing again does nothing
    const again = await royalmail.pushOrder(o.id);
    assert.equal(again.skipped, 'already sent');
    assert.equal(creates().length, 1);
  });

  it('Stripe: webhook + success page + resent webhook → ONE Click & Drop order (idempotent)', async () => {
    const shopper = await basket([['box', 1]]);
    const r = await call('POST', '/api/checkout/stripe', BUYER, { shopper });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = SESSIONS.get(r.data.id);
    s.payment_status = 'paid';
    await Promise.all([sendWebhook(s), call('GET', `/api/checkout/stripe/session/${s.id}`, null, { shopper }), sendWebhook(s)]);
    await royalmail.flush();
    await sendWebhook(s);
    await royalmail.flush();
    assert.equal(creates().length, 1);
    const o = ordersStore.find(s.id);
    assert.equal(o.royalmail.state, 'sent');
    assert.ok(o.royalmail.orderReference.length <= 40);
    assert.equal(creates()[0].items[0].packages[0].packageFormatIdentifier, 'smallParcel');
  });

  it('demo orders are never pushed, even when connected', async () => {
    const shopper = await basket([['card', 1]]);
    const r = await call('POST', '/api/checkout/demo', BUYER, { shopper });
    assert.equal(r.status, 200);
    await royalmail.flush();
    assert.equal(creates().length, 0);
    const pushed = await royalmail.pushOrder(r.data.order.id);
    assert.equal(pushed.skipped, 'demo order');
    const row = (await admin('GET', '/orders?all=1&demo=1')).data.orders.find((x) => x.id === r.data.order.id);
    assert.equal(row.royalmail.state, 'demo');
  });

  it('failure → error state shown in admin (key never in the message), then retry adopts the order already in Click & Drop (no duplicate)', async () => {
    const errors = [];
    const origErr = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      rmFake.failCreate = { once: true, timeoutButCreated: true, message: `Could not reach Royal Mail: timeout ${RM_KEY}` };
      const o = await paypalOrder([['card', 1]], 'PAYPAL-RETRY-1');
      assert.equal(o.royalmail.state, 'error');
      assert.equal(o.royalmail.attempts, 1);
      assert.ok(!o.royalmail.lastError.includes(RM_KEY));
      assert.ok(errors.every((e) => !e.includes(RM_KEY)), 'key not logged');
      const row = (await admin('GET', '/orders?all=1')).data.orders.find((x) => x.id === o.id);
      assert.ok(row.problems.some((p) => /Royal Mail/.test(p)));
      // admin presses Retry: looks up by reference first, finds the one that was created during the timeout
      const r = await admin('POST', `/royalmail/orders/${o.id}/push`);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(creates().length, 1, 'no second create');
      assert.ok(rmFake.calls.some((c) => c.op === 'get' && c.ids === '"PMF-PAYPAL-RETRY-1"'));
      const after = ordersStore.find(o.id);
      assert.equal(after.royalmail.state, 'sent');
      assert.equal(after.royalmail.lastError, null);
      assert.deepEqual(after.history.map((h) => h.event), ['Paid', 'Royal Mail error', 'Sent to Royal Mail']);
    } finally { console.error = origErr; }
  });

  it('rejected order data → error with the field name, no automatic retry; push-unsent sends waiting orders', async () => {
    const origErr = console.error; console.error = () => {};
    try {
      const o = await paypalOrder([['card', 1]], 'PAYPAL-BAD-1');
      // simulate an order whose postcode got lost
      await ordersStore.update(o.id, { shipping_address: { ...o.shipping_address, postcode: '' }, royalmail: undefined });
      const r = await royalmail.pushOrder(o.id);
      assert.match(r.error, /Postcode is required \(postcode\)/);
      await ordersStore.update(o.id, { shipping_address: o.shipping_address });
      const p = await admin('POST', '/royalmail/push-unsent');
      assert.equal(p.status, 200);
      assert.ok(p.data.sent >= 1);
      assert.equal(ordersStore.find(o.id).royalmail.state, 'sent');
    } finally { console.error = origErr; }
  });
});

describe('Labels, tracking and shipping', () => {
  it('Print label: one PDF, order becomes Label printed, tracking number synced back with a Royal Mail link', async () => {
    const o = await paypalOrder([['card', 1]], 'PAYPAL-LABEL-1');
    const r = await admin('GET', `/royalmail/labels?ids=${o.id}`);
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/pdf/);
    assert.equal(r.data.slice(0, 4).toString(), '%PDF');
    await new Promise((res) => setTimeout(res, 50)); // background tracking sync
    const row = (await admin('GET', '/orders?all=1')).data.orders.find((x) => x.id === o.id);
    assert.equal(row.stage, 'label_printed');
    assert.equal(row.tracking_number, `TT${o.royalmail.orderIdentifier}0000GB`);
    assert.equal(row.tracking_url, `https://www.royalmail.com/track-your-item#/tracking-results/${row.tracking_number}`);
    assert.ok(row.history.some((h) => h.event === 'Label printed'));
    assert.ok(row.history.some((h) => h.event === 'Tracking number from Royal Mail'));
  });

  it('bulk: all labels for unshipped orders in one call (demo and shipped orders left out)', async () => {
    const a = await paypalOrder([['card', 1]], 'PAYPAL-BULK-A');
    const b = await paypalOrder([['box', 1]], 'PAYPAL-BULK-B');
    const r = await admin('GET', '/royalmail/labels');
    assert.equal(r.status, 200);
    const call1 = rmFake.calls.find((c) => c.op === 'label');
    const ids = call1.ids.split(';');
    assert.ok(ids.includes(String(a.royalmail.orderIdentifier)) && ids.includes(String(b.royalmail.orderIdentifier)));
    assert.ok(Number(r.headers.get('x-label-count')) >= 2);
  });

  it('account without API labels (403, not OBA) → clear message + Open in Click & Drop fallback', async () => {
    const o = await paypalOrder([['card', 1]], 'PAYPAL-OLP-1');
    rmFake.labelStatus = 403;
    const r = await admin('GET', `/royalmail/labels?ids=${o.id}`);
    assert.equal(r.status, 403);
    assert.match(r.data.error, /Online Business Account/);
    assert.equal(r.data.fallback, royalmail.CLICK_AND_DROP_URL);
    assert.equal((await admin('GET', '/royalmail/status')).data.labelsApi, false);
    // label printed in Click & Drop by hand → sync picks up printed + tracking + despatched
    const rmo = rmFake.orders.get(o.royalmail.orderIdentifier);
    Object.assign(rmo, { printedOn: '2026-11-01T11:00:00Z', trackingNumber: 'QQ123456785GB', shippedOn: '2026-11-01T16:00:00Z' });
    const s = await admin('POST', '/royalmail/sync');
    assert.equal(s.status, 200);
    const after = ordersStore.find(o.id);
    assert.equal(after.tracking_number, 'QQ123456785GB');
    assert.equal(after.status, 'posted');
    assert.equal(royalmail.stageOf(after), 'shipped');
  });

  it('owner-typed tracking number wins over sync; Mark as shipped needs a tracking number and is logged', async () => {
    const o = await paypalOrder([['card', 1]], 'PAYPAL-MANUAL-1');
    assert.equal((await admin('PATCH', `/orders/${o.id}`, { status: 'posted', tracking_number: '' })).status, 400);
    const r = await admin('PATCH', `/orders/${o.id}`, { tracking_number: 'ab 123 456 789 gb' });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.tracking_source, 'manual');
    rmFake.orders.get(o.royalmail.orderIdentifier).trackingNumber = 'ZZ999999999GB';
    await admin('POST', '/royalmail/sync');
    assert.equal(ordersStore.find(o.id).tracking_number, 'AB123456789GB');
    const s = await admin('PATCH', `/orders/${o.id}`, { status: 'posted' });
    assert.equal(s.status, 200);
    const h = ordersStore.find(o.id).history.map((x) => x.event);
    assert.deepEqual(h.slice(-2), ['Tracking number set', 'Shipped']);
  });

  it('check connection lists the account\'s Tracked services and says if the service code is there', async () => {
    const r = await admin('POST', '/royalmail/check');
    assert.equal(r.status, 200);
    assert.equal(r.data.hasServiceCode, true);
    assert.ok(r.data.tracked.some((s) => s.code === 'TPS48'));
  });
});

describe('Order tracker + packing slips + persistence', () => {
  it('order list: stage, problems, full history; ?all=1 ignores the date range', async () => {
    const o = await paypalOrder([['card', 1]], 'PAYPAL-TRACK-1');
    await ordersStore.update(o.id, { createdAt: '2025-01-05T10:00:00Z' }); // long ago
    const inRange = await admin('GET', '/orders');
    assert.ok(!inRange.data.orders.some((x) => x.id === o.id));
    const all = await admin('GET', '/orders?all=1');
    const row = all.data.orders.find((x) => x.id === o.id);
    assert.equal(row.stage, 'sent');
    assert.ok(Array.isArray(row.problems));
    assert.ok(row.history.length >= 2 && row.history.every((h) => h.at && h.event));
    // older orders without stored history still get one
    assert.deepEqual(royalmail.historyOf({ createdAt: '2026-01-01T00:00:00Z', posted_at: '2026-01-02T00:00:00Z', tracking_number: 'X' }).map((h) => h.event), ['Paid', 'Shipped']);
    assert.ok(royalmail.problemsOf({ status: 'paid', stock_conflict: true, shipping_address: null }).length === 2);
  });

  it('packing slips: A4 + A6, escaped, bulk for everything to post; needs the admin login', async () => {
    const o = await paypalOrder([['card', 1]], 'PAYPAL-SLIP-1');
    const a4 = await admin('GET', `/orders/${o.id}/packing-slip?print=0`);
    assert.equal(a4.status, 200);
    assert.match(a4.type, /text\/html/);
    assert.match(a4.data, /Packing slip/);
    assert.match(a4.data, /LS1 4AP/);
    assert.match(a4.data, /Charizard &lt;b&gt;holo&lt;\/b&gt;/);
    assert.ok(!a4.data.includes('<b>holo</b>'));
    assert.match(a4.data, /size: A4/);
    assert.ok(!a4.data.includes('window.print'));
    const a6 = await admin('GET', `/orders/${o.id}/packing-slip?size=a6`);
    assert.match(a6.data, /size: 105mm 148mm/);
    assert.match(a6.data, /window\.print/);
    const bulk = await admin('GET', '/packing-slips');
    assert.ok((bulk.data.match(/class="page a4"/g) || []).length >= 2);
    assert.equal((await call('GET', `/api/admin/orders/${o.id}/packing-slip`)).status, 401);
  });

  it('Royal Mail fields + history are saved in the private orders repo', async () => {
    const o = await paypalOrder([['card', 1]], 'PAYPAL-REPO-1');
    await admin('GET', `/royalmail/labels?ids=${o.id}`);
    await new Promise((res) => setTimeout(res, 50));
    const saved = repoOrder(o.id);
    assert.ok(saved, 'order file in the private repo');
    assert.equal(saved.royalmail.orderIdentifier, o.royalmail.orderIdentifier);
    assert.ok(saved.royalmail.labelPrintedAt);
    assert.ok(saved.tracking_number);
    assert.ok(saved.history.some((h) => h.event === 'Label printed'));
    assert.ok(![...files.values()].some((f) => f.buf.toString().includes(RM_KEY)), 'key never stored');
  });
});
