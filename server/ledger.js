'use strict';
/**
 * Accounting ledger: an APPEND-ONLY list of money events (sale, postage charged, estimated fee,
 * refund, adjustment). Entries are never edited or deleted — a correction is a new entry (type
 * 'adjustment'). There is deliberately no update/delete function in this module.
 *
 * Storage follows orders / customer accounts: ledger.json in the PRIVATE orders repo
 * (ORDERS_GITHUB_REPO, "[skip render]" commits, serialised by the orders store's queue), with a local
 * copy (LEDGER_FILE or data/ledger.json, git-ignored) as the in-memory cache / demo-mode fallback.
 * On restart the repo copy is merged with the local one by entry id (union; the first copy of an id wins).
 *
 * Amounts are signed pounds: money in is positive (sale, postage), money out negative (refund, fee).
 * Entry: { id, at (ISO), date_uk, time_uk, type, order_id, order_number, customer, amount, method,
 *          reference, note, by }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ordersStore = require('./orders-store');
const sales = require('./sales');

const REPO_FILE = 'ledger.json';
const PENDING_KEY = '__ledger__';
const TYPES = ['sale', 'postage', 'fee', 'refund', 'adjustment'];
// Oldest first; entries posted at the same instant (one order) keep a natural order: sale, postage, fee, refund …
const byTime = (a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || (a.id < b.id ? -1 : 1);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

function filePath() { return process.env.LEDGER_FILE || path.join(__dirname, '..', 'data', 'ledger.json'); }

/** Keep only well-formed entries, first copy of each id wins, oldest first. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !e.id || !TYPES.includes(e.type) || !Number.isFinite(Number(e.amount))) continue;
    const id = String(e.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(normalise({ ...e, id }));
  }
  return out.sort(byTime);
}

function normalise(e) {
  const at = e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
  const p = sales.ukParts(at);
  return {
    id: String(e.id), at, date_uk: p.date, time_uk: p.time, type: e.type,
    order_id: str(e.order_id, 120), order_number: str(e.order_number, 60), customer: str(e.customer, 120),
    amount: money(e.amount), method: str(e.method, 40), reference: str(e.reference, 120), note: str(e.note, 500), by: str(e.by, 60),
  };
}

let cache = null;
function all() {
  if (!cache) { try { cache = clean(JSON.parse(fs.readFileSync(filePath(), 'utf8'))); } catch { cache = []; } }
  return cache;
}
function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(all(), null, 2) + '\n', 'utf8');
  } catch (err) { console.error('Could not write local ledger file:', err.message); }
}
// Safety: never push before the repo copy has been merged in, or a fresh server would overwrite the
// stored ledger with a shorter one. If the repo can't be read yet, the save waits ("Retry saving now").
let loaded = false;
async function ensureLoaded() {
  if (loaded || !ordersStore.ordersConfig()) return;
  await pullFromGitHub();
}
ordersStore.registerFile(PENDING_KEY, REPO_FILE, () => all(), 'accounting ledger', ensureLoaded);

let lastSave = Promise.resolve({ github: false });
function save(message) {
  writeLocal();
  lastSave = (async () => {
    try { await ensureLoaded(); } catch (err) {
      ordersStore.markPending(PENDING_KEY);
      console.error('Ledger not saved to the orders repo yet:', err.message);
      return { github: false, githubError: err.message };
    }
    return ordersStore.pushFile(REPO_FILE, all(), message, PENDING_KEY);
  })();
  return lastSave;
}
function whenSaved() { return lastSave; }

/**
 * Append entries (never changes an existing one). An entry with an id that is already in the ledger is
 * ignored, which makes the automatic postings idempotent. Returns the entries that were really added.
 */
function append(entries, message = 'ledger entry') {
  const list = all();
  const have = new Set(list.map((e) => e.id));
  const added = [];
  for (const raw of [].concat(entries)) {
    if (!raw || !TYPES.includes(raw.type) || !Number.isFinite(Number(raw.amount))) continue;
    const id = raw.id ? String(raw.id) : `led_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    if (have.has(id)) continue;
    const e = normalise({ ...raw, id, at: raw.at || new Date().toISOString() });
    have.add(id);
    list.push(e);
    added.push(e);
  }
  if (!added.length) return { added, github: false };
  list.sort(byTime);
  save(message);
  return { added };
}

const customerOf = (o) => (o.shipping_address && o.shipping_address.name) || o.email || '';

/** Postings for a new paid, real order: sale (items), postage charged, estimated fee. Ids are fixed so they post once. */
function saleEntries(o, fees = sales.DEFAULT_FEES) {
  if (!o || o.demo || o.status === 'cancelled') return [];
  const f = sales.orderFigures({ ...o, refunds: undefined }, fees);
  const base = { at: o.createdAt, order_id: o.id, order_number: o.order_number || o.id, customer: customerOf(o), method: o.method || '', reference: o.stripe_payment_intent || o.payment_ref || o.id, by: 'system' };
  const out = [{ ...base, id: `sale:${o.id}`, type: 'sale', amount: f.sales, note: `${f.items} item(s)` }];
  if (f.postage > 0) out.push({ ...base, id: `postage:${o.id}`, type: 'postage', amount: f.postage, note: (o.postage && o.postage.service) || 'Postage charged to customer' });
  if (f.fee > 0) out.push({ ...base, id: `fee:${o.id}`, type: 'fee', amount: -f.fee, note: 'ESTIMATED payment fee (not the exact figure — see Stripe / PayPal reports)' });
  return out;
}
function recordSale(o, fees) {
  try { return append(saleEntries(o, fees), `ledger: sale ${o.order_number || o.id}`); } catch (err) { console.error('Ledger: could not record sale:', err.message); return { added: [] }; }
}

function refundEntry(o, r) {
  return {
    id: `refund:${o.id}:${r.id}`, at: r.at, type: 'refund', amount: -money(r.amount), order_id: o.id, order_number: o.order_number || o.id,
    customer: customerOf(o), method: r.method === 'stripe' ? 'stripe' : 'manual', reference: r.stripe_refund_id || r.id,
    note: `${r.method === 'manual' ? 'RECORDED MANUALLY (no money moved by the shop) — ' : ''}${r.reason || ''}`.trim(), by: r.by || 'admin',
  };
}
function recordRefund(o, r) {
  try { return append(refundEntry(o, r), `ledger: refund ${o.order_number || o.id}`); } catch (err) { console.error('Ledger: could not record refund:', err.message); return { added: [] }; }
}

/**
 * Bring the ledger up to date with orders that pre-date it (or were saved while it failed): sales for
 * every real order, and refunds already on orders. Orders marked "refunded" before refunds were
 * recorded get one refund entry for the whole total, labelled as a status change. Safe to run repeatedly.
 */
function backfill(orders, fees) {
  const entries = [];
  for (const o of orders || []) {
    if (!o || o.demo) continue;
    entries.push(...saleEntries(o, fees));
    if (Array.isArray(o.refunds) && o.refunds.length) for (const r of o.refunds) entries.push(refundEntry(o, r));
    else if (o.status === 'refunded') {
      entries.push({ id: `refund:${o.id}:legacy`, at: o.refunded_at || o.updatedAt || o.createdAt, type: 'refund', amount: -money(o.total), order_id: o.id, order_number: o.order_number || o.id, customer: customerOf(o), method: 'manual', reference: o.id, note: 'Order was marked Refunded before refunds were recorded (amount = order total; no details kept)', by: 'system' });
    }
  }
  return append(entries, 'ledger: backfill');
}

/** Entries whose UK date is within [from, to], oldest first. */
function inRange(from, to, list = all()) {
  const r = sales.cleanRange(from, to);
  return list.filter((e) => e.date_uk >= r.from && e.date_uk <= r.to);
}

function totals(list) {
  const t = { sale: 0, postage: 0, fee: 0, refund: 0, adjustment: 0, net: 0 };
  for (const e of list) { t[e.type] = money(t[e.type] + e.amount); t.net = money(t.net + e.amount); }
  return t;
}

/** Startup: merge the repo copy with the local one by id (union), push anything only held locally. */
async function pullFromGitHub() {
  const remote = await ordersStore.pullFile(REPO_FILE);
  loaded = true; // the repo was read (a missing file just means the ledger is new)
  if (!remote) return false;
  const merged = clean(remote);
  const ids = new Set(merged.map((e) => e.id));
  const localOnly = all().filter((e) => !ids.has(e.id));
  cache = clean([...merged, ...localOnly]);
  if (localOnly.length) save(`ledger: ${localOnly.length} entr${localOnly.length === 1 ? 'y' : 'ies'} added while offline`);
  else writeLocal();
  return true;
}

function reset() { cache = null; loaded = false; lastSave = Promise.resolve({ github: false }); }

module.exports = { REPO_FILE, TYPES, all, append, recordSale, recordRefund, saleEntries, refundEntry, backfill, inRange, totals, pullFromGitHub, whenSaved, reset, filePath };
