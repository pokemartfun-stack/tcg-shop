'use strict';
// Stripe webhook: signature check, recording from session metadata (no browser cookie), and
// idempotency between the webhook and the success page (one order, stock taken once).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');

const tmpProducts = path.join(os.tmpdir(), `wh-products-${process.pid}.json`);
const tmpSettings = path.join(os.tmpdir(), `wh-settings-${process.pid}.json`);
const tmpOrders = path.join(os.tmpdir(), `wh-orders-${process.pid}.json`);
const PRODUCTS = [
  { id: 'a', title: 'Card A', price_gbp: 2, stock: 50, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'lot-b', title: 'Lot B', price_gbp: 5.5, stock: 50, condition: 'Played', category: 'Trading card lots', image: '/images/tauros-ar.svg' },
];
fs.writeFileSync(tmpProducts, JSON.stringify(PRODUCTS));
process.env.PRODUCTS_FILE = tmpProducts;
process.env.SETTINGS_FILE = tmpSettings;
process.env.ORDERS_FILE = tmpOrders;
process.env.COSTS_FILE = path.join(os.tmpdir(), `wh-costs-${process.pid}.json`);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake_for_tests';
const WHSEC = 'whsec_test_secret_for_tests';
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
delete process.env.GITHUB_TOKEN;
delete process.env.ORDERS_GITHUB_REPO;
delete process.env.PAYPAL_CLIENT_ID;

const payments = require('../server/payments');
const ordersStore = require('../server/orders-store');
const productStore = require('../server/products-store');

// Fake Stripe client: no network. Real webhooks helper so signatures are checked for real.
const realStripe = new Stripe('sk_test_fake_for_tests');
const SESSIONS = new Map();
let nextId = 1;
payments.getStripe = () => ({
  webhooks: realStripe.webhooks,
  checkout: {
    sessions: {
      create: async (params) => {
        const id = `cs_test_${String(nextId++).padStart(4, '0')}abc`;
        const amount = params.line_items.reduce((s, l) => s + l.price_data.unit_amount * l.quantity, 0)
          + (params.shipping_options ? params.shipping_options[0].shipping_rate_data.fixed_amount.amount : 0);
        SESSIONS.set(id, { id, object: 'checkout.session', payment_status: 'unpaid', amount_total: amount, currency: 'gbp', customer_email: params.customer_email, metadata: params.metadata, _params: params });
        return { id, url: `https://checkout.stripe.test/${id}` };
      },
      retrieve: async (id) => {
        const s = SESSIONS.get(id);
        if (!s) throw new Error('No such session');
        return s;
      },
    },
  },
});

const BUYER = { email: 'misty@example.com', address: { name: 'Misty Waterflower', line1: '2 Cerulean Gym', line2: 'Flat 1', town: 'Cardiff', postcode: 'cf10 1aa', phone: '07700 900123' } };
const app = require('../server/index');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  for (const f of [tmpProducts, tmpSettings, tmpOrders, process.env.COSTS_FILE]) fs.rmSync(f, { force: true });
});
beforeEach(() => { process.env.STRIPE_WEBHOOK_SECRET = WHSEC; });

async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.shopper) headers['x-session-token'] = opts.shopper;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const cookie = res.headers.get('set-cookie') || '';
  const m = cookie.match(/session=([^;]+)/);
  return { status: res.status, data: await res.json().catch(() => ({})), session: m && decodeURIComponent(m[1]) };
}

function eventFor(session, type = 'checkout.session.completed') {
  return JSON.stringify({ id: `evt_${session.id}_${type}`, object: 'event', type, data: { object: session } });
}

async function sendWebhook(payload, { secret = WHSEC, header } = {}) {
  const sig = header !== undefined ? header : Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const headers = { 'Content-Type': 'application/json' };
  if (sig) headers['Stripe-Signature'] = sig;
  const res = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers, body: payload });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const ordersFor = (id) => ordersStore.all().filter((o) => o.id === id);
const stockOf = (id) => productStore.get().find((p) => p.id === id).stock;

/** Shopper fills a basket and starts Stripe Checkout; returns the (unpaid) fake session. */
async function startCheckout(lines) {
  const shopper = (await call('GET', '/api/cart')).session;
  for (const [productId, qty] of lines) assert.equal((await call('POST', '/api/cart/add', { productId, qty }, { shopper })).status, 200);
  const r = await call('POST', '/api/checkout/stripe', BUYER, { shopper });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { shopper, session: SESSIONS.get(r.data.id) };
}

/** A paid session that only exists in Stripe (e.g. the server restarted after checkout). */
function metadataOnlySession(id, lines) {
  const products = productStore.get();
  const items = lines.map(([productId, qty]) => {
    const p = products.find((x) => x.id === productId);
    return { productId, qty, price_gbp: p.price_gbp, title: p.title };
  });
  const subtotal = items.reduce((s, l) => s + l.price_gbp * l.qty, 0);
  const enriched = { items, subtotal, postage: { service: 'Royal Mail Tracked 48', band: 'large_letter', amount: 2.9, free: false, total: subtotal + 2.9 } };
  const metadata = payments.orderMetadata({ enriched, address: { ...BUYER.address, postcode: 'CF10 1AA', country: 'United Kingdom' }, email: BUYER.email, userId: null });
  return { id, object: 'checkout.session', payment_status: 'paid', amount_total: Math.round((subtotal + 2.9) * 100), currency: 'gbp', customer_email: BUYER.email, metadata };
}

describe('Stripe webhook', () => {
  it('missing STRIPE_WEBHOOK_SECRET → 503, nothing recorded, rest of the shop still works', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const s = metadataOnlySession('cs_test_nosecret', [['a', 1]]);
    const payload = eventFor(s);
    const r = await sendWebhook(payload, { secret: WHSEC });
    assert.equal(r.status, 503);
    assert.equal(ordersFor(s.id).length, 0);
    assert.equal((await call('GET', '/api/products')).status, 200);
    assert.equal((await call('GET', '/api/health')).status, 200);
  });

  it('bad signature → 400 and no order / no stock change', async () => {
    const s = metadataOnlySession('cs_test_badsig', [['a', 2]]);
    const payload = eventFor(s);
    const before = stockOf('a');
    assert.equal((await sendWebhook(payload, { secret: 'whsec_wrong' })).status, 400);
    assert.equal((await sendWebhook(payload, { header: '' })).status, 400); // no header at all
    assert.equal((await sendWebhook(payload, { header: 't=123,v1=deadbeef' })).status, 400);
    // payload tampered after signing
    const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const res = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload.replace('"paid"', '"paid" ') });
    assert.equal(res.status, 400);
    assert.equal(ordersFor(s.id).length, 0);
    assert.equal(stockOf('a'), before);
  });

  it('valid signature records the order from session metadata alone (no cookie, no in-memory cart)', async () => {
    const s = metadataOnlySession('cs_test_metaonly', [['a', 2], ['lot-b', 1]]);
    const a0 = stockOf('a');
    const b0 = stockOf('lot-b');
    const r = await sendWebhook(eventFor(s));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.recorded, true);
    const [o, ...more] = ordersFor(s.id);
    assert.equal(more.length, 0);
    assert.equal(o.method, 'stripe');
    assert.equal(o.status, 'paid');
    assert.equal(o.demo, false);
    assert.equal(o.email, BUYER.email);
    assert.equal(o.recorded_by, 'webhook');
    assert.deepEqual(o.items.map((l) => [l.productId, l.qty, l.price_gbp, l.title]), [['a', 2, 2, 'Card A'], ['lot-b', 1, 5.5, 'Lot B']]);
    assert.equal(o.subtotal, 9.5);
    assert.deepEqual(o.postage, { service: 'Royal Mail Tracked 48', band: 'large_letter', amount: 2.9, free: false });
    assert.equal(o.total, 12.4);
    assert.equal(o.amount_paid, 12.4);
    assert.equal(o.shipping_address.name, 'Misty Waterflower');
    assert.equal(o.shipping_address.postcode, 'CF10 1AA');
    assert.equal(o.shipping_address.phone, '07700 900123');
    assert.equal(stockOf('a'), a0 - 2);
    assert.equal(stockOf('lot-b'), b0 - 1);
    // Stripe resends the same event → still one order, stock unchanged
    const again = await sendWebhook(eventFor(s));
    assert.equal(again.status, 200);
    assert.equal(again.data.recorded, false);
    assert.equal(ordersFor(s.id).length, 1);
    assert.equal(stockOf('a'), a0 - 2);
  });

  it('ignores unpaid sessions and other event types; records on async_payment_succeeded', async () => {
    const s = metadataOnlySession('cs_test_async', [['a', 1]]);
    const a0 = stockOf('a');
    const unpaid = { ...s, payment_status: 'unpaid' };
    assert.equal((await sendWebhook(eventFor(unpaid))).data.recorded, false);
    assert.equal((await sendWebhook(eventFor(s, 'payment_intent.created'))).data.ignored, 'payment_intent.created');
    assert.equal(ordersFor(s.id).length, 0);
    const r = await sendWebhook(eventFor(s, 'checkout.session.async_payment_succeeded'));
    assert.equal(r.data.recorded, true);
    assert.equal(ordersFor(s.id).length, 1);
    assert.equal(stockOf('a'), a0 - 1);
  });

  it('checkout stores the full order in metadata within Stripe limits', async () => {
    const { session } = await startCheckout([['a', 3], ['lot-b', 2]]);
    const m = session.metadata;
    assert.ok(Object.keys(m).length <= 50);
    for (const [k, v] of Object.entries(m)) {
      assert.ok(k.length <= 40, k);
      assert.equal(typeof v, 'string');
      assert.ok(v.length <= 500, k);
    }
    assert.equal(m.email, BUYER.email);
    assert.equal(m.a_postcode, 'CF10 1AA');
    assert.ok(m.ship_to.includes('Misty Waterflower')); // still shown in the Stripe dashboard
    const rebuilt = payments.orderFromSessionMetadata({ ...session, payment_status: 'paid' }, productStore.get());
    assert.deepEqual(rebuilt.enriched.items.map((l) => [l.productId, l.qty, l.price_gbp]), [['a', 3, 2], ['lot-b', 2, 5.5]]);
    assert.equal(rebuilt.enriched.subtotal, 17);
    assert.equal(rebuilt.enriched.postage.amount * 100, Number(m.pst_p));
  });

  it('big baskets are split over several metadata keys and still round-trip', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ productId: `vinted-card-number-${String(i).padStart(3, '0')}-holo`, qty: 1 + (i % 3), price_gbp: 1.25 + i }));
    const subtotal = items.reduce((s, l) => s + l.price_gbp * l.qty, 0);
    const meta = payments.orderMetadata({ enriched: { items, subtotal, postage: null }, address: null, email: 'x@example.com' });
    assert.ok(Number(meta.cart_n) > 1);
    assert.ok(Object.keys(meta).length <= 50);
    for (const v of Object.values(meta)) assert.ok(v.length <= 500);
    const back = payments.orderFromSessionMetadata({ id: 'cs_x', metadata: meta }, []);
    assert.equal(back.enriched.items.length, 60);
    assert.deepEqual(back.enriched.items.map((l) => [l.productId, l.qty, l.price_gbp]), items.map((l) => [l.productId, l.qty, l.price_gbp]));
  });

  it('webhook first, then success page → one order, stock taken once', async () => {
    const { shopper, session } = await startCheckout([['a', 2]]);
    const a0 = stockOf('a');
    session.payment_status = 'paid';
    const w = await sendWebhook(eventFor(session));
    assert.equal(w.data.recorded, true);
    const p = await call('GET', `/api/checkout/stripe/session/${session.id}`, null, { shopper });
    assert.equal(p.status, 200);
    assert.equal(p.data.status, 'paid');
    assert.equal(ordersFor(session.id).length, 1);
    assert.equal(ordersFor(session.id)[0].recorded_by, 'webhook');
    assert.equal(stockOf('a'), a0 - 2);
    assert.equal((await call('GET', '/api/cart', null, { shopper })).data.items.length, 0); // basket emptied
  });

  it('success page first, then webhook → one order, stock taken once', async () => {
    const { shopper, session } = await startCheckout([['lot-b', 1]]);
    const b0 = stockOf('lot-b');
    session.payment_status = 'paid';
    assert.equal((await call('GET', `/api/checkout/stripe/session/${session.id}`, null, { shopper })).status, 200);
    assert.equal(ordersFor(session.id).length, 1);
    assert.equal(ordersFor(session.id)[0].recorded_by, 'success page');
    const w = await sendWebhook(eventFor(session));
    assert.equal(w.status, 200);
    assert.equal(w.data.recorded, false);
    assert.equal(ordersFor(session.id).length, 1);
    assert.equal(stockOf('lot-b'), b0 - 1);
  });

  it('webhook and success page at the same moment → one order, stock taken once', async () => {
    const { shopper, session } = await startCheckout([['a', 1], ['lot-b', 1]]);
    const a0 = stockOf('a');
    const b0 = stockOf('lot-b');
    session.payment_status = 'paid';
    const results = await Promise.all([
      sendWebhook(eventFor(session)),
      call('GET', `/api/checkout/stripe/session/${session.id}`, null, { shopper }),
      sendWebhook(eventFor(session)),
      call('GET', `/api/checkout/stripe/session/${session.id}`, null, { shopper }),
    ]);
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(ordersFor(session.id).length, 1);
    assert.equal(stockOf('a'), a0 - 1);
    assert.equal(stockOf('lot-b'), b0 - 1);
    const saved = JSON.parse(fs.readFileSync(tmpOrders, 'utf8')).filter((o) => o.id === session.id);
    assert.equal(saved.length, 1);
  });
});
