'use strict';
// Refunds + accounting ledger + exports. Mock Stripe (no network): refund create/list, idempotency,
// webhook charge.refunded, partial/full refunds, manual refunds, stock put-back, append-only ledger,
// totals/CSV/Excel/PDF exports, admin permissions.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Stripe = require('stripe');
const ExcelJS = require('exceljs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-accounts-'));
const P = (f) => path.join(tmp, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'a', title: 'Card A', price_gbp: 2, stock: 100, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'b', title: 'Lot B', price_gbp: 5.5, stock: 100, condition: 'Played', category: 'Trading card lots', image: '/images/tauros-ar.svg' },
]));
Object.assign(process.env, {
  PRODUCTS_FILE: P('products.json'), SETTINGS_FILE: P('settings.json'), ORDERS_FILE: P('orders.json'), COSTS_FILE: P('costs.json'),
  USERS_FILE: P('users.json'), LEDGER_FILE: P('ledger.json'), ADMIN_PASSWORD: 'accounts-test-owner',
  STRIPE_SECRET_KEY: 'sk_test_fake_for_tests', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_for_tests', STRIPE_WEBHOOK_SECRET: 'whsec_accounts_tests',
});
for (const k of ['GITHUB_TOKEN', 'ORDERS_GITHUB_REPO', 'PAYPAL_CLIENT_ID', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'COMPANY_ADDRESS', 'VAT_NUMBER']) delete process.env[k];
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET;

const payments = require('../server/payments');
const ordersStore = require('../server/orders-store');
const productStore = require('../server/products-store');
const ledger = require('../server/ledger');
const sales = require('../server/sales');
const refundsMod = require('../server/refunds');
const pdfReports = require('../server/pdf-reports');
const accountsExport = require('../server/accounts-export');

// ---- mock Stripe ----
const realStripe = new Stripe('sk_test_fake_for_tests');
const refundCalls = [];
const stripeRefunds = []; // every refund that "exists" in Stripe
const idem = new Map();
let failRefund = false;
let rn = 0;
const stripeMock = {
  webhooks: realStripe.webhooks,
  refunds: {
    create: async (params, opts) => {
      refundCalls.push({ params, opts });
      if (failRefund) throw new Error('Charge is already fully refunded (mock)');
      if (idem.has(opts.idempotencyKey)) return idem.get(opts.idempotencyKey);
      const r = { id: `re_test_${++rn}`, object: 'refund', amount: params.amount, status: 'succeeded', payment_intent: params.payment_intent, metadata: params.metadata, created: Math.floor(Date.now() / 1000) };
      stripeRefunds.push(r); idem.set(opts.idempotencyKey, r);
      return r;
    },
    list: async ({ payment_intent }) => ({ data: stripeRefunds.filter((r) => r.payment_intent === payment_intent) }),
  },
  checkout: { sessions: {
    retrieve: async (id) => ({ id, payment_intent: `pi_for_${id}` }),
    list: async ({ payment_intent }) => ({ data: [{ id: payment_intent.replace('pi_for_', '') }] }),
  } },
};
payments.getStripe = () => stripeMock;

const app = require('../server/index');
let server, base, token;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await admin('POST', '/login', { password: process.env.ADMIN_PASSWORD })).data.token;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
function paidSession(lines, { pi } = {}) {
  const products = JSON.parse(fs.readFileSync(P('products.json'), 'utf8'));
  const items = lines.map(([productId, qty]) => { const p = products.find((x) => x.id === productId); return { productId, qty, price_gbp: p.price_gbp, title: p.title }; });
  const subtotal = items.reduce((s, l) => s + l.price_gbp * l.qty, 0);
  const enriched = { items, subtotal, postage: { service: 'Royal Mail Tracked 48', band: 'large_letter', amount: 2.9, free: false, total: subtotal + 2.9 } };
  const id = `cs_test_acc_${++n}`;
  const metadata = payments.orderMetadata({ enriched, address: { name: 'Misty Waterflower', line1: '2 Cerulean Gym', town: 'Cardiff', postcode: 'CF10 1AA', country: 'United Kingdom' }, email: 'misty@example.com', userId: null });
  return { id, object: 'checkout.session', payment_status: 'paid', amount_total: Math.round((subtotal + 2.9) * 100), currency: 'gbp', customer_email: 'misty@example.com', payment_intent: pi || `pi_for_${id}`, metadata };
}
async function sendEvent(type, object) {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const res = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const pay = (s) => sendEvent('checkout.session.completed', s);
async function admin(method, url, body, tok = token, raw = false) {
  const res = await fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const stock = (id) => productStore.get().find((p) => p.id === id).stock;
const entriesFor = (orderId) => ledger.all().filter((e) => e.order_id === orderId);

describe('ledger postings for a sale', () => {
  it('records sale, postage and estimated fee once, and keeps the Stripe payment id on the order', async () => {
    const s = paidSession([['a', 2]]);
    assert.equal((await pay(s)).data.recorded, true);
    await pay(s); // duplicate webhook
    const o = ordersStore.find(s.id);
    assert.equal(o.stripe_payment_intent, `pi_for_${s.id}`);
    const e = entriesFor(s.id);
    assert.deepEqual(e.map((x) => [x.type, x.amount]), [['sale', 4], ['postage', 2.9], ['fee', -0.3]]);
    assert.equal(e[0].order_number, o.order_number);
    assert.equal(e[0].customer, 'Misty Waterflower');
    assert.match(e[0].date_uk, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(e[0].time_uk, /^\d{2}:\d{2}$/);
    assert.match(e[2].note, /ESTIMATED/);
  });
});

describe('Stripe refunds', () => {
  it('partial refund: Stripe API called with pence + idempotency key, recorded on order, history and ledger, stock put back', async () => {
    const s = paidSession([['a', 2], ['b', 1]]); // items 9.50 + 2.90 = 12.40
    await pay(s);
    const before = stock('a');
    const r = await admin('POST', `/orders/${s.id}/refund`, { amount: 4, reason: 'Card A damaged in post', restock: [{ productId: 'a', qty: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const call = refundCalls.at(-1);
    assert.equal(call.params.payment_intent, `pi_for_${s.id}`);
    assert.equal(call.params.amount, 400);
    assert.match(call.opts.idempotencyKey, /^pmf-refund-/);
    const o = ordersStore.find(s.id);
    assert.equal(o.refunds.length, 1);
    const rf = o.refunds[0];
    assert.equal(rf.amount, 4); assert.equal(rf.method, 'stripe'); assert.equal(rf.reason, 'Card A damaged in post');
    assert.match(rf.stripe_refund_id, /^re_test_/); assert.equal(rf.by, 'admin'); assert.ok(rf.at);
    assert.equal(o.status, 'paid');                 // partial: still an active order
    assert.equal(o.refunded_gbp, 4);
    assert.equal(stock('a'), before + 1);
    assert.ok(o.history.some((h) => h.event === 'Part refund' && /£4\.00 via Stripe/.test(h.note)));
    const led = entriesFor(s.id).filter((x) => x.type === 'refund');
    assert.equal(led.length, 1);
    assert.equal(led[0].amount, -4); assert.equal(led[0].method, 'stripe'); assert.equal(led[0].reference, rf.stripe_refund_id);
    // webhook for the same refund must not record it again
    const w = await sendEvent('charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: `pi_for_${s.id}` });
    assert.equal(w.data.refunds_recorded, 0);
    assert.equal(ordersStore.find(s.id).refunds.length, 1);
    // second refund, then the remainder; never more than what is left
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 8.41, reason: 'too much' })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 8.4, reason: 'rest', restock: [{ productId: 'b', qty: 1 }] })).status, 200);
    const done = ordersStore.find(s.id);
    assert.equal(done.status, 'refunded'); assert.ok(done.refunded_at);
    assert.ok(done.history.some((h) => h.event === 'Refunded'));
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 0.01, reason: 'x' })).status, 400);
    assert.equal(entriesFor(s.id).filter((x) => x.type === 'refund').length, 2);
  });

  it('validates: reason required, amount > 0, restock limits, demo orders, login required', async () => {
    const s = paidSession([['a', 1]]);
    await pay(s);
    const calls = refundCalls.length;
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: '  ' })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 0, reason: 'x' })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 'abc', reason: 'x' })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: -1, reason: 'x' })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'x', restock: [{ productId: 'a', qty: 2 }] })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'x', restock: [{ productId: 'zzz', qty: 1 }] })).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'x' }, null)).status, 401);
    assert.equal((await admin('POST', `/orders/nope/refund`, { amount: 1, reason: 'x' })).status, 404);
    assert.equal(refundCalls.length, calls, 'Stripe was never called');
    assert.equal(ordersStore.find(s.id).refunds, undefined);
    await ordersStore.add({ id: 'demo_acc1', status: 'paid', demo: true, method: 'demo', email: 'd@example.com', items: [], subtotal: 5, total: 5, createdAt: new Date().toISOString() });
    assert.equal((await admin('POST', `/orders/demo_acc1/refund`, { amount: 1, reason: 'x' })).status, 400);
  });

  it('a Stripe error records nothing and returns the error', async () => {
    const s = paidSession([['a', 1]]);
    await pay(s);
    failRefund = true;
    try {
      const r = await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'test' });
      assert.equal(r.status, 502);
      assert.match(r.data.error, /Stripe refused/);
    } finally { failRefund = false; }
    assert.equal(ordersStore.find(s.id).refunds, undefined);
    assert.equal(entriesFor(s.id).filter((x) => x.type === 'refund').length, 0);
  });

  it('works for older orders that have no stored payment id (asks Stripe for the session)', async () => {
    await ordersStore.add({ id: 'cs_test_old1', order_number: 'PMF-OLD1', status: 'paid', demo: false, method: 'stripe', email: 'o@example.com', items: [{ productId: 'a', qty: 1, price_gbp: 2, title: 'Card A', line_total: 2 }], subtotal: 2, postage: { amount: 2.9 }, total: 4.9, createdAt: new Date().toISOString() });
    const r = await admin('POST', `/orders/cs_test_old1/refund`, { amount: 4.9, reason: 'old order' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(refundCalls.at(-1).params.payment_intent, 'pi_for_cs_test_old1');
    assert.equal(ordersStore.find('cs_test_old1').status, 'refunded');
  });
});

describe('manual refunds', () => {
  it('PayPal / non-Stripe orders can only be recorded manually (no Stripe call), labelled as manual', async () => {
    await ordersStore.add({ id: 'pp_acc1', order_number: 'PMF-PP1', status: 'paid', demo: false, method: 'paypal', email: 'p@example.com', items: [{ productId: 'a', qty: 1, price_gbp: 2, title: 'Card A', line_total: 2 }], subtotal: 2, postage: { amount: 2.9 }, total: 4.9, createdAt: new Date().toISOString(), shipping_address: { name: 'Pay Pal' } });
    const calls = refundCalls.length;
    const bad = await admin('POST', `/orders/pp_acc1/refund`, { amount: 1, reason: 'x', method: 'stripe' });
    assert.equal(bad.status, 400);
    const r = await admin('POST', `/orders/pp_acc1/refund`, { amount: 1.5, reason: 'Refunded via PayPal website' });
    assert.equal(r.status, 200);
    assert.equal(refundCalls.length, calls);
    const rf = ordersStore.find('pp_acc1').refunds[0];
    assert.equal(rf.method, 'manual'); assert.equal(rf.stripe_refund_id, null);
    const led = entriesFor('pp_acc1').find((x) => x.type === 'refund');
    assert.equal(led.method, 'manual'); assert.match(led.note, /RECORDED MANUALLY/);
    assert.match(ordersStore.find('pp_acc1').history.at(-1).note, /recorded manually/);
  });

  it('Stripe orders can also be recorded manually, and without Stripe keys only manual is offered', async () => {
    const s = paidSession([['a', 1]]);
    await pay(s);
    const calls = refundCalls.length;
    assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'refunded at the bank', method: 'manual' })).status, 200);
    assert.equal(refundCalls.length, calls);
    const keep = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.equal(refundsMod.options(ordersStore.find(s.id)).stripe, false);
      assert.equal((await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'x', method: 'stripe' })).status, 400);
      const r = await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'no keys' });
      assert.equal(r.status, 200);
      assert.equal(ordersStore.find(s.id).refunds.at(-1).method, 'manual');
    } finally { process.env.STRIPE_SECRET_KEY = keep; }
  });

  it('choosing status "Refunded" in the old status list records a manual refund for the rest', async () => {
    const s = paidSession([['a', 1]]);
    await pay(s);
    const r = await admin('PATCH', `/orders/${s.id}`, { status: 'refunded', note: 'customer returned it' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const o = ordersStore.find(s.id);
    assert.equal(o.status, 'refunded');
    assert.equal(o.refunds.length, 1);
    assert.equal(o.refunds[0].amount, 4.9);
    assert.equal(o.refunds[0].method, 'manual');
    assert.equal(o.refunds[0].reason, 'customer returned it');
    assert.equal(entriesFor(s.id).filter((x) => x.type === 'refund').length, 1);
  });
});

describe('Stripe webhook charge.refunded (refund made in the Stripe dashboard)', () => {
  it('records it once (dedupe by Stripe refund id), even when the event is repeated', async () => {
    const s = paidSession([['a', 3]]); // 6 + 2.9 = 8.90
    await pay(s);
    const pi = `pi_for_${s.id}`;
    stripeRefunds.push({ id: 're_dash_1', object: 'refund', amount: 250, status: 'succeeded', payment_intent: pi, reason: 'requested_by_customer', created: Math.floor(Date.now() / 1000) - 60 });
    const w1 = await sendEvent('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: pi });
    assert.equal(w1.status, 200);
    assert.equal(w1.data.refunds_recorded, 1);
    await sendEvent('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: pi });
    const o = ordersStore.find(s.id);
    assert.equal(o.refunds.length, 1);
    assert.equal(o.refunds[0].stripe_refund_id, 're_dash_1');
    assert.equal(o.refunds[0].amount, 2.5);
    assert.equal(o.refunds[0].by, 'Stripe dashboard');
    assert.equal(o.refunds[0].source, 'stripe_webhook');
    assert.equal(o.status, 'paid');
    assert.equal(entriesFor(s.id).filter((x) => x.type === 'refund').length, 1);
    // a second dashboard refund for the rest makes it fully refunded
    stripeRefunds.push({ id: 're_dash_2', object: 'refund', amount: 640, status: 'succeeded', payment_intent: pi, created: Math.floor(Date.now() / 1000) });
    await sendEvent('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: pi });
    assert.equal(ordersStore.find(s.id).status, 'refunded');
    assert.equal(ordersStore.find(s.id).refunds.length, 2);
  });

  it('finds older orders through the Stripe checkout session, ignores unknown payments and failed refunds', async () => {
    await ordersStore.add({ id: 'cs_test_old2', order_number: 'PMF-OLD2', status: 'paid', demo: false, method: 'stripe', email: 'o@example.com', items: [{ productId: 'a', qty: 1, price_gbp: 2, title: 'Card A', line_total: 2 }], subtotal: 2, postage: { amount: 2.9 }, total: 4.9, createdAt: new Date().toISOString() });
    stripeRefunds.push({ id: 're_dash_old', object: 'refund', amount: 100, status: 'succeeded', payment_intent: 'pi_for_cs_test_old2', created: Math.floor(Date.now() / 1000) });
    stripeRefunds.push({ id: 're_dash_failed', object: 'refund', amount: 100, status: 'failed', payment_intent: 'pi_for_cs_test_old2', created: Math.floor(Date.now() / 1000) });
    const w = await sendEvent('charge.refunded', { id: 'ch_old', object: 'charge', payment_intent: 'pi_for_cs_test_old2' });
    assert.equal(w.data.refunds_recorded, 1);
    assert.equal(ordersStore.find('cs_test_old2').refunds[0].amount, 1);
    const none = await sendEvent('charge.refunded', { id: 'ch_none', object: 'charge', payment_intent: 'pi_for_cs_unknown' });
    assert.equal(none.status, 200);
    assert.equal(none.data.refunds_recorded, 0);
    assert.equal((await sendEvent('charge.refunded', { id: 'ch_nopi', object: 'charge' })).status, 200);
  });

  it('needs a valid signature', async () => {
    const res = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=bad' }, body: '{}' });
    assert.equal(res.status, 400);
  });
});

describe('sales totals subtract refunds', () => {
  const day = '2026-06-10';
  const mk = (id, extra = {}) => ({ id, status: 'paid', demo: false, method: 'stripe', createdAt: `${day}T10:00:00Z`, items: [{ productId: 'a', title: 'Card A', qty: 2, price_gbp: 10, line_total: 20, cost_gbp: 4 }], subtotal: 20, postage: { amount: 2.9, service: 'Royal Mail Tracked 48' }, total: 22.9, email: 'x@example.com', shipping_address: { name: 'N' }, ...extra });
  const opts = { from: day, to: day };
  it('partial refunds reduce net; full refunds drop the order from the totals but show in the refunds figure', () => {
    const plain = sales.summarise([mk('o1')], opts).totals;
    const part = sales.summarise([mk('o1', { refunds: [{ amount: 5, at: `${day}T12:00:00Z`, reason: 'dent', method: 'manual' }] })], opts);
    assert.equal(part.totals.refunds, 5);
    assert.equal(part.totals.net, Math.round((plain.net - 5) * 100) / 100);
    assert.equal(part.totals.profit, Math.round((plain.profit - 5) * 100) / 100);
    assert.equal(part.totals.sales, plain.sales);
    assert.equal(part.refunds.amount, 5); assert.equal(part.refunds.partial_orders, 1);
    const full = sales.summarise([mk('o1', { status: 'refunded', refunds: [{ amount: 22.9, at: `${day}T12:00:00Z`, reason: 'x', method: 'stripe' }] })], opts);
    assert.equal(full.totals.orders, 0);
    assert.equal(full.excluded.refunded, 1);
    assert.equal(full.refunds.amount, 22.9);
    // legacy refunded status (no refunds array) counts as a full refund
    assert.equal(sales.summarise([mk('o1', { status: 'refunded' })], opts).refunds.amount, 22.9);
  });
  it('put-back-in-stock refunds are not counted as cost', () => {
    const o = mk('o1', { refunds: [{ amount: 10, at: `${day}T12:00:00Z`, method: 'manual', reason: 'returned', restock: [{ productId: 'a', qty: 1 }] }] });
    assert.equal(sales.orderFigures(o).cost, 4);
    assert.equal(sales.orderFigures(mk('o1')).cost, 8);
  });
  it('CSV and Excel carry refunded_gbp, refund_date_uk, refund_reason', async () => {
    const o = mk('o1', { refunds: [{ amount: 5, at: `${day}T12:00:00Z`, reason: 'dent, "bad" corner', method: 'manual' }, { amount: 2, at: '2026-06-11T09:00:00Z', reason: '=cmd', method: 'manual' }] });
    const csv = sales.toCsv([o], opts).split('\r\n');
    const head = csv[0].split(',');
    for (const c of ['refunded_gbp', 'refund_date_uk', 'refund_reason']) assert.ok(head.includes(c), c);
    assert.ok(csv[1].includes('7.00,2026-06-11,"dent, ""bad"" corner; =cmd"'), csv[1]);
    assert.ok(!csv[2] || !csv[2].includes('7.00'), 'order-level refund only on line 1');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await require('../server/sales-xlsx').toXlsx([o], opts));
    const ws = wb.getWorksheet('Orders');
    assert.deepEqual(ws.getRow(1).values.slice(1), sales.CSV_COLUMNS);
    assert.equal(ws.getRow(2).getCell(sales.CSV_COLUMNS.indexOf('refunded_gbp') + 1).value, 7);
    const sum = wb.getWorksheet('Summary');
    let found = false; sum.eachRow((r) => { if (String(r.getCell(1).value).startsWith('Part refunds')) { found = true; assert.equal(r.getCell(2).value, 7); } });
    assert.ok(found);
  });
});

describe('ledger is append-only and merges safely', () => {
  it('has no way to edit or delete, ignores a repeated id, and corrections are new entries', async () => {
    assert.deepEqual(Object.keys(ledger).filter((k) => /^(update|edit|delete|remove|clear|set|overwrite)/i.test(k)), []);
    const before = ledger.all().length;
    const r1 = ledger.append({ id: 'fixed-1', type: 'adjustment', amount: 1, note: 'first' });
    const r2 = ledger.append({ id: 'fixed-1', type: 'adjustment', amount: 99, note: 'changed' });
    assert.equal(r1.added.length, 1); assert.equal(r2.added.length, 0);
    assert.equal(ledger.all().length, before + 1);
    assert.equal(ledger.all().find((e) => e.id === 'fixed-1').note, 'first');
    // entries returned by all() can't be used to rewrite the stored data on disk
    const onDisk = JSON.parse(fs.readFileSync(P('ledger.json'), 'utf8'));
    assert.equal(onDisk.find((e) => e.id === 'fixed-1').amount, 1);
    // admin correction endpoint
    assert.equal((await admin('POST', '/ledger/adjustment', { amount: -3, note: '' })).status, 400);
    assert.equal((await admin('POST', '/ledger/adjustment', { amount: 0, note: 'x' })).status, 400);
    assert.equal((await admin('POST', '/ledger/adjustment', { amount: -3, note: 'fix' }, null)).status, 401);
    const ok = await admin('POST', '/ledger/adjustment', { amount: -3, note: 'Correction: postage over-charged', reference: 'ref1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.entry.type, 'adjustment'); assert.equal(ok.data.entry.amount, -3);
  });

  it('merges the private-repo copy with the local one by id, and never pushes before the repo copy was read', async () => {
    const realPull = ordersStore.pullFile; const realPush = ordersStore.pushFile; const realCfg = ordersStore.ordersConfig; const realMark = ordersStore.markPending;
    const pushed = []; let marked = 0; let remote = null; let pullFails = true;
    ordersStore.ordersConfig = () => ({ repo: 'owner/orders', token: 't', branch: 'main' });
    ordersStore.pullFile = async (f) => { assert.equal(f, 'ledger.json'); if (pullFails) throw new Error('repo unreachable'); return remote; };
    ordersStore.pushFile = async (f, data, msg, key) => { pushed.push({ f, data: JSON.parse(JSON.stringify(data)), msg, key }); return { github: true }; };
    ordersStore.markPending = () => { marked++; };
    try {
      ledger.reset();
      fs.writeFileSync(P('ledger.json'), JSON.stringify([{ id: 'local-1', at: '2026-01-01T10:00:00Z', type: 'sale', amount: 5 }, { id: 'both-1', at: '2026-01-02T10:00:00Z', type: 'sale', amount: 7, note: 'local copy' }]));
      // 1) repo can't be read: the append is kept locally, flagged as pending, and NOT pushed
      ledger.append({ id: 'new-1', type: 'adjustment', amount: 1, note: 'while offline' });
      const r = await ledger.whenSaved();
      assert.equal(r.github, false); assert.equal(marked, 1); assert.equal(pushed.length, 0);
      // 2) repo readable: remote entries + local-only entries are merged (remote copy of a shared id wins) and pushed
      pullFails = false;
      remote = [{ id: 'remote-1', at: '2025-12-01T10:00:00Z', type: 'sale', amount: 3 }, { id: 'both-1', at: '2026-01-02T10:00:00Z', type: 'sale', amount: 7, note: 'remote copy' }];
      ledger.append({ id: 'new-2', type: 'adjustment', amount: 2, note: 'online' });
      await ledger.whenSaved();
      const last = pushed.at(-1);
      assert.equal(last.f, 'ledger.json'); assert.equal(last.key, '__ledger__');
      assert.deepEqual(last.data.map((e) => e.id).sort(), ['both-1', 'local-1', 'new-1', 'new-2', 'remote-1']);
      assert.equal(last.data.find((e) => e.id === 'both-1').note, 'remote copy');
      // 3) startup merge
      ledger.reset();
      fs.writeFileSync(P('ledger.json'), JSON.stringify([{ id: 'only-local', at: '2026-02-01T10:00:00Z', type: 'sale', amount: 1 }]));
      remote = [{ id: 'only-remote', at: '2026-01-01T10:00:00Z', type: 'sale', amount: 2 }];
      assert.equal(await ledger.pullFromGitHub(), true);
      assert.deepEqual(ledger.all().map((e) => e.id), ['only-remote', 'only-local']);
      assert.deepEqual(pushed.at(-1).data.map((e) => e.id), ['only-remote', 'only-local']);
    } finally {
      Object.assign(ordersStore, { pullFile: realPull, pushFile: realPush, ordersConfig: realCfg, markPending: realMark });
      ledger.reset();
    }
  });

  it('backfill posts earlier orders once (sales, existing refunds, legacy "refunded" status)', () => {
    const base = { demo: false, method: 'stripe', createdAt: '2026-03-01T10:00:00Z', items: [{ qty: 1 }], subtotal: 10, postage: { amount: 2 }, total: 12, shipping_address: { name: 'B' } };
    const orders = [
      { ...base, id: 'bf1', order_number: 'PMF-BF1', status: 'paid' },
      { ...base, id: 'bf2', order_number: 'PMF-BF2', status: 'refunded', refunded_at: '2026-03-02T10:00:00Z' },
      { ...base, id: 'bf3', order_number: 'PMF-BF3', status: 'paid', refunds: [{ id: 'rf1', amount: 3, at: '2026-03-03T10:00:00Z', method: 'manual', reason: 'x' }] },
      { ...base, id: 'bfd', status: 'paid', demo: true },
    ];
    const a = ledger.backfill(orders);
    assert.ok(a.added.length >= 8);
    assert.equal(entriesFor('bfd').length, 0);
    assert.equal(entriesFor('bf2').find((e) => e.type === 'refund').amount, -12);
    assert.equal(entriesFor('bf3').find((e) => e.type === 'refund').amount, -3);
    assert.equal(ledger.backfill(orders).added.length, 0, 'second run adds nothing');
  });
});

describe('exports', () => {
  const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  const text = (buf) => { const f = P(`t${Math.random().toString(36).slice(2)}.pdf`); fs.writeFileSync(f, buf); return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); };

  it('ledger CSV and Excel for a date range (admin only)', async () => {
    ledger.append({ id: 'csv-1', at: '2026-08-05T12:00:00Z', type: 'adjustment', amount: -1.5, order_number: 'PMF-CSV', customer: '=HYPERLINK("x")', note: 'comma, "quote"' });
    assert.equal((await admin('GET', '/ledger/csv?from=2026-08-01&to=2026-08-31', null, null, true)).status, 401);
    const c = await admin('GET', '/ledger/csv?from=2026-08-01&to=2026-08-31', null, token, true);
    assert.equal(c.status, 200);
    assert.match(c.headers.get('content-type'), /text\/csv/);
    const csv = c.buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], accountsExport.COLUMNS.join(','));
    assert.equal(lines.length, 2, 'only the entry inside the range');
    assert.ok(lines[1].includes("'=HYPERLINK") && lines[1].includes('-1.50') && lines[1].includes('"comma, ""quote"""'));
    const x = await admin('GET', '/ledger/xlsx?from=2026-08-01&to=2026-08-31', null, token, true);
    assert.equal(x.status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buf);
    const ws = wb.getWorksheet('Ledger');
    assert.deepEqual(ws.getRow(1).values.slice(1), accountsExport.COLUMNS);
    assert.equal(ws.getRow(2).getCell(8).value, -1.5);
    assert.ok(wb.getWorksheet('Totals'));
    const j = await admin('GET', '/ledger?from=2026-08-01&to=2026-08-31');
    assert.equal(j.data.entries.length, 1); assert.equal(j.data.totals.adjustment, -1.5);
  });

  it('accounts PDF report and single-order receipt', async (t) => {
    const s = paidSession([['a', 1]]); await pay(s);
    await admin('POST', `/orders/${s.id}/refund`, { amount: 1, reason: 'Goodwill refund for PDF test' });
    const o = ordersStore.find(s.id);
    assert.equal((await admin('GET', '/accounts/report.pdf', null, null, true)).status, 401);
    assert.equal((await admin('GET', `/orders/${s.id}/receipt.pdf`, null, null, true)).status, 401);
    const rep = await admin('GET', '/accounts/report.pdf?from=2000-01-01&to=2999-12-31', null, token, true);
    assert.equal(rep.status, 200); assert.equal(rep.headers.get('content-type'), 'application/pdf');
    assert.equal(rep.buf.subarray(0, 5).toString(), '%PDF-');
    const rc = await admin('GET', `/orders/${s.id}/receipt.pdf`, null, token, true);
    assert.equal(rc.status, 200); assert.equal(rc.buf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await admin('GET', '/orders/nope/receipt.pdf')).status, 404);
    if (!hasPdftotext) return t.skip('pdftotext not installed');
    const rt = text(rc.buf);
    assert.ok(!rt.split('\n').some((l) => l.includes('2 Cerulean Gym') && l.includes('Cardiff')), 'address lines are on separate lines');
    assert.ok(rt.includes('PO-KE-MART-FUN LIMITED') && rt.includes('16870472'));
    assert.ok(rt.includes('[REGISTERED ADDRESS — to confirm]'), 'placeholder, not an invented address');
    assert.ok(rt.includes('[VAT STATUS / NUMBER — to confirm]'));
    assert.ok(rt.includes(o.order_number) && rt.includes('Goodwill refund for PDF test') && rt.includes('£4.90'));
    const pt = text(rep.buf);
    for (const w of ['Accounts report', 'Sales summary', 'Refunds', 'Ledger', 'Goodwill refund for PDF test', o.order_number]) assert.ok(pt.includes(w), w);
    process.env.COMPANY_ADDRESS = '1 Example Road, Testville'; process.env.VAT_NUMBER = 'GB000000000';
    try { const t2 = text(await pdfReports.receiptPdf(o)); assert.ok(t2.includes('1 Example Road, Testville') && t2.includes('GB000000000')); } finally { delete process.env.COMPANY_ADDRESS; delete process.env.VAT_NUMBER; }
  });

  it('refund list endpoint + tracker rows carry refund options', async () => {
    const list = await admin('GET', '/refunds?from=2000-01-01&to=2999-12-31');
    assert.equal(list.status, 200);
    assert.ok(list.data.refunds.length >= 3);
    assert.ok(list.data.refunds.every((r) => r.order_number && r.reason && r.amount > 0 && ['stripe', 'manual'].includes(r.method)));
    const orders = await admin('GET', '/orders?all=1');
    const row = orders.data.orders.find((x) => x.refunds && x.refunds.length && x.status === 'paid');
    assert.ok(row.refund.remaining >= 0 && row.refund.state === 'partial');
    assert.equal((await admin('GET', '/refunds', null, null)).status, 401);
  });
});

describe('admin page tabs', () => {
  it('has Sales, Orders, Refunds and Accounts as tabs, the refund dialog and the export buttons', async () => {
    const html = await (await fetch(base + '/admin')).text();
    assert.match(html, /id="admin-tabs"/);
    for (const [id, tab] of [['orders-section', 'orders'], ['sales-section', 'sales'], ['refunds-section', 'refunds'], ['accounts-section', 'accounts']]) assert.match(html, new RegExp(`<section id="${id}" data-tab="${tab}"`));
    assert.match(html, /id="tracker"/);
    for (const id of ['refund-dialog', 'ac-csv', 'ac-xlsx', 'ac-pdf', 's-pdf', 'rf-reason', 'rf-go']) assert.match(html, new RegExp(`id="${id}"`));
    // every section lives in exactly one tab
    const sections = [...html.matchAll(/<section id="([^"]+)"([^>]*)>/g)].filter((m) => m[1] !== 'login-box');
    assert.ok(sections.length >= 14);
    for (const m of sections) assert.match(m[2], /data-tab="[a-z]+"/, m[1]);
    for (const f of ['admin-tabs.js', 'admin-accounts.js']) assert.equal((await fetch(`${base}/js/${f}`)).status, 200);
  });
});
