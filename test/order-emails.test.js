'use strict';
// Customer order emails (Gmail via nodemailer) — uses a MOCK transport, no network.
// Covers: sent once when an order is paid (webhook + resent webhook), none for demo orders, off when
// the env vars are missing, escaping of customer data, shipped email with tracking (once), failures
// never breaking the order/webhook (and never leaking the password), admin status + resend.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-emails-'));
const P = (f) => path.join(tmp, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'a', title: 'Card A', price_gbp: 2, stock: 500, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'evil', title: '<img src=x onerror=alert(1)> & "Holo"', price_gbp: 5.5, stock: 500, condition: 'Played', category: 'Trading cards', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.USERS_FILE = P('users.json');
process.env.ADMIN_PASSWORD = 'email-test-owner';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake_for_tests';
const WHSEC = 'whsec_email_tests';
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
delete process.env.GITHUB_TOKEN;
delete process.env.ORDERS_GITHUB_REPO;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.CONTACT_EMAIL;
delete process.env.SHOP_URL;
delete process.env.MAIL_FROM_NAME;
const PASSWORD = 'abcd efgh ijkl mnop';
const GMAIL = 'shop.example@gmail.com';
const enableEmails = () => { process.env.GMAIL_USER = GMAIL; process.env.GMAIL_APP_PASSWORD = PASSWORD; };
const disableEmails = () => { delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD; };

const payments = require('../server/payments');
const ordersStore = require('../server/orders-store');
const emails = require('../server/emails');
const realStripe = new Stripe('sk_test_fake_for_tests');
payments.getStripe = () => ({ webhooks: realStripe.webhooks });

const sent = [];
let failWith = null;
const fakeTransport = { sendMail: async (msg) => { if (failWith) throw new Error(failWith); sent.push(msg); return { messageId: 'x' }; } };
emails.setTransport(fakeTransport);

const app = require('../server/index');
let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); emails.setTransport(null); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { sent.length = 0; failWith = null; enableEmails(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(15); } return false; }

let n = 0;
function paidSession(lines, { email = 'misty@example.com', name = 'Misty Waterflower' } = {}) {
  const products = JSON.parse(fs.readFileSync(P('products.json'), 'utf8'));
  const items = lines.map(([productId, qty]) => { const p = products.find((x) => x.id === productId); return { productId, qty, price_gbp: p.price_gbp, title: p.title }; });
  const subtotal = items.reduce((s, l) => s + l.price_gbp * l.qty, 0);
  const enriched = { items, subtotal, postage: { service: 'Royal Mail Tracked 48', band: 'large_letter', amount: 2.9, free: false, total: subtotal + 2.9 } };
  const metadata = payments.orderMetadata({ enriched, address: { name, line1: '2 Cerulean Gym', line2: '', town: 'Cardiff', postcode: 'CF10 1AA', country: 'United Kingdom' }, email, userId: null });
  return { id: `cs_test_mail_${++n}`, object: 'checkout.session', payment_status: 'paid', amount_total: Math.round((subtotal + 2.9) * 100), currency: 'gbp', customer_email: email, metadata };
}
async function webhook(session) {
  const payload = JSON.stringify({ id: `evt_${session.id}`, object: 'event', type: 'checkout.session.completed', data: { object: session } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const res = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function admin(method, url, body, token) {
  const res = await fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
let tokenCache;
async function adminToken() { if (!tokenCache) tokenCache = (await admin('POST', '/login', { password: process.env.ADMIN_PASSWORD })).data.token; return tokenCache; }

describe('order confirmation email', () => {
  it('is sent once when an order is paid, with the right contents', async () => {
    const s = paidSession([['a', 2]]);
    const r = await webhook(s);
    assert.equal(r.status, 200);
    assert.equal(r.data.recorded, true);
    assert.ok(await until(() => sent.length === 1), 'one email sent');
    const m = sent[0];
    const o = ordersStore.find(s.id);
    assert.equal(m.to, 'misty@example.com');
    assert.equal(m.replyTo, GMAIL);
    assert.deepEqual(m.from, { name: 'Po-ke Mart Fun', address: GMAIL });
    assert.match(m.subject, new RegExp(o.order_number));
    assert.match(m.text, new RegExp(o.order_number));
    assert.match(m.text, /2 x Card A/);
    assert.match(m.text, /Royal Mail Tracked 48: £2\.90/);
    assert.match(m.text, /Total: £6\.90/);
    assert.match(m.text, /2 Cerulean Gym/);
    assert.match(m.text, /Cardiff/);
    assert.ok(m.text.includes(`https://tcg-shop-1.onrender.com/track?number=${o.order_number}`));
    assert.ok(m.text.includes(GMAIL)); // contact info falls back to GMAIL_USER
    assert.ok(m.html.includes(`track?number=${o.order_number}`));
    assert.match(m.html, /name="viewport"/);
    assert.ok(await until(() => ordersStore.find(s.id).confirmation_emailed_at), 'marker saved on the order');
    // Stripe resends the webhook + the order is read again: still one email
    assert.equal((await webhook(s)).data.recorded, false);
    await sleep(150);
    assert.equal(sent.length, 1);
    assert.ok(ordersStore.find(s.id).history.some((h) => h.event === 'Confirmation email sent'));
  });

  it('uses CONTACT_EMAIL, MAIL_FROM_NAME and SHOP_URL when set', async () => {
    process.env.CONTACT_EMAIL = 'help@example.org';
    process.env.MAIL_FROM_NAME = 'Test Shop';
    process.env.SHOP_URL = 'https://shop.example.test/';
    try {
      const s = paidSession([['a', 1]]);
      await webhook(s);
      assert.ok(await until(() => sent.length === 1));
      assert.ok(sent[0].text.includes('help@example.org'));
      assert.ok(!sent[0].text.includes(GMAIL));
      assert.ok(sent[0].text.includes('https://shop.example.test/track?number='));
      assert.equal(sent[0].from.name, 'Test Shop');
    } finally { delete process.env.CONTACT_EMAIL; delete process.env.MAIL_FROM_NAME; delete process.env.SHOP_URL; }
  });

  it('is not sent for demo orders', async () => {
    // demo checkout only exists when no card/PayPal keys are set
    const keep = [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_PUBLISHABLE_KEY];
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PUBLISHABLE_KEY;
    try {
      const cart = await fetch(base + '/api/cart');
      const cookie = (cart.headers.get('set-cookie') || '').split(';')[0];
      const H = { 'Content-Type': 'application/json', Cookie: cookie };
      assert.equal((await fetch(base + '/api/cart/add', { method: 'POST', headers: H, body: JSON.stringify({ productId: 'a', qty: 1 }) })).status, 200);
      const res = await fetch(base + '/api/checkout/demo', { method: 'POST', headers: H, body: JSON.stringify({ email: 'demo@example.com', address: { name: 'Demo Buyer', line1: '1 Test St', town: 'Leeds', postcode: 'LS1 1AA', phone: '07700 900000' } }) });
      const d = await res.json();
      assert.equal(res.status, 200, JSON.stringify(d));
      assert.equal(d.order.demo, true);
    } finally { [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_PUBLISHABLE_KEY] = keep; }
    await sleep(200);
    assert.equal(sent.length, 0);
    // and the unit-level rule too
    emails.onOrderPaid({ id: 'demo_x', demo: true, status: 'paid', email: 'x@example.com' });
    await sleep(100);
    assert.equal(sent.length, 0);
  });

  it('is off (and the shop works as before) when GMAIL_USER / GMAIL_APP_PASSWORD are missing', async () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      for (const variant of ['none', 'user-only', 'pass-only']) {
        disableEmails();
        if (variant === 'user-only') process.env.GMAIL_USER = GMAIL;
        if (variant === 'pass-only') process.env.GMAIL_APP_PASSWORD = PASSWORD;
        const s = paidSession([['a', 1]]);
        const r = await webhook(s);
        assert.equal(r.status, 200);
        assert.equal(r.data.recorded, true);
        await sleep(150);
        assert.equal(sent.length, 0, variant);
        const o = ordersStore.find(s.id);
        assert.equal(o.status, 'paid');
        assert.equal(o.confirmation_emailed_at, undefined);
      }
    } finally { console.log = orig; }
    assert.ok(logs.some((l) => l === 'order emails off'), 'logs "order emails off"');
    assert.equal(logs.filter((l) => l === 'order emails off').length, 1, 'only once');
    assert.equal(emails.status().enabled, false);
    // admin resend says so
    const r = await admin('POST', `/orders/x/resend-email`, { kind: 'confirmation' }, await adminToken());
    assert.equal(r.status, 404);
    const first = ordersStore.all().find((o) => !o.demo);
    const r2 = await admin('POST', `/orders/${first.id}/resend-email`, {}, await adminToken());
    assert.equal(r2.status, 400);
    assert.match(r2.data.error, /off/i);
  });

  it('escapes customer data in the HTML and refuses unsafe recipient addresses', async () => {
    const s = paidSession([['evil', 1]], { name: '<script>alert("x")</script> Ash' });
    await webhook(s);
    assert.ok(await until(() => sent.length === 1));
    const html = sent[0].html;
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Holo&quot;'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    // unit: direct render with hostile values everywhere
    const o = { id: 'o1', order_number: 'PMF-<b>1</b>', email: 'a@b.co', items: [{ title: '<i>t</i>', qty: 1, price_gbp: 1, condition: '"><svg onload=1>' }], subtotal: 1, total: 3.9, postage: { amount: 2.9, service: '<u>svc</u>' },
      shipping_address: { name: '<b>n</b>', line1: '<l1>', town: "T'own", postcode: '<pc>' }, tracking_number: 'AB123456789GB' };
    for (const mail of [emails.confirmationEmail(o), emails.shippedEmail(o)]) {
      for (const bad of ['<svg onload', '<l1>', '<pc>', '<i>t</i>', '<u>svc</u>', 'PMF-<b>']) assert.ok(!mail.html.includes(bad), bad);
    }
    // header injection: a recipient with a line break is never sent
    emails.onOrderPaid({ id: 'inj', status: 'paid', email: 'a@b.co\r\nBcc: evil@example.com', items: [], subtotal: 0, total: 0 });
    await sleep(100);
    assert.equal(sent.length, 1);
  });

  it('never fails or blocks the order when sending fails, logs without the password, and can be resent', async () => {
    failWith = `Invalid login ${PASSWORD.replace(/ /g, '')} rejected`;
    const errs = [];
    const orig = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); };
    let s, r;
    try {
      s = paidSession([['a', 1]]);
      r = await webhook(s);
      assert.equal(r.status, 200);
      assert.equal(r.data.recorded, true);
      assert.ok(await until(() => ordersStore.find(s.id).confirmation_email_error));
    } finally { console.error = orig; }
    assert.ok(errs.some((e) => /not sent/.test(e)), 'error logged');
    for (const text of [...errs, JSON.stringify(ordersStore.find(s.id))]) {
      assert.ok(!text.includes(PASSWORD), 'password not leaked');
      assert.ok(!text.includes(PASSWORD.replace(/ /g, '')), 'password not leaked (compact)');
    }
    const o = ordersStore.find(s.id);
    assert.equal(o.status, 'paid');
    assert.equal(o.confirmation_emailed_at, undefined);
    // admin resend now works
    failWith = null;
    const tok = await adminToken();
    const rr = await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'confirmation' }, tok);
    assert.equal(rr.status, 200, JSON.stringify(rr.data));
    assert.equal(sent.length, 1);
    assert.ok(ordersStore.find(s.id).confirmation_emailed_at);
    assert.equal(ordersStore.find(s.id).confirmation_email_error, null);
  });
});

describe('shipped email', () => {
  it('is sent once when the admin marks the order posted with a tracking number', async () => {
    const s = paidSession([['a', 1]]);
    await webhook(s);
    assert.ok(await until(() => ordersStore.find(s.id).confirmation_emailed_at));
    sent.length = 0;
    const tok = await adminToken();
    // posted needs tracking
    assert.equal((await admin('PATCH', `/orders/${s.id}`, { status: 'posted' }, tok)).status, 400);
    await sleep(80);
    assert.equal(sent.length, 0);
    const r = await admin('PATCH', `/orders/${s.id}`, { status: 'posted', tracking_number: 'ab 123 456 789 gb' }, tok);
    assert.equal(r.status, 200);
    assert.ok(await until(() => sent.length === 1));
    const m = sent[0];
    assert.equal(m.to, 'misty@example.com');
    assert.match(m.subject, /has been posted/);
    assert.ok(m.text.includes('AB123456789GB'));
    assert.ok(m.text.includes('https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB'));
    assert.ok(m.html.includes('AB123456789GB'));
    assert.ok(m.html.includes('tracking-results/AB123456789GB'));
    assert.ok(await until(() => ordersStore.find(s.id).shipped_emailed_at));
    // editing the posted order, or flipping back and forth, does not email again
    await admin('PATCH', `/orders/${s.id}`, { note: 'hello' }, tok);
    await admin('PATCH', `/orders/${s.id}`, { status: 'paid' }, tok);
    await admin('PATCH', `/orders/${s.id}`, { status: 'posted' }, tok);
    await sleep(200);
    assert.equal(sent.length, 1);
    // admin order list shows email status
    const list = await admin('GET', '/orders?all=1', null, tok);
    assert.equal(list.data.emails.enabled, true);
    assert.equal(list.data.emails.from, GMAIL);
    assert.ok(!JSON.stringify(list.data).includes(PASSWORD.replace(/ /g, '')));
    const row = list.data.orders.find((x) => x.id === s.id);
    assert.ok(row.confirmation_emailed_at && row.shipped_emailed_at);
    // explicit resend of the shipped email
    const rs = await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'shipped' }, tok);
    assert.equal(rs.status, 200);
    assert.equal(sent.length, 2);
  });

  it('is not sent for demo orders or when emails are off', async () => {
    const tok = await adminToken();
    disableEmails();
    const s = paidSession([['a', 1]]);
    await webhook(s);
    await admin('PATCH', `/orders/${s.id}`, { status: 'posted', tracking_number: 'ZZ123456789GB' }, tok);
    await sleep(150);
    assert.equal(sent.length, 0);
    enableEmails();
    ordersStore.add({ id: 'demo_ship1', status: 'paid', demo: true, email: 'd@example.com', items: [], subtotal: 0, total: 0, createdAt: new Date().toISOString() });
    await admin('PATCH', `/orders/demo_ship1`, { status: 'posted', tracking_number: 'ZZ123456789GB' }, tok);
    await sleep(150);
    assert.equal(sent.length, 0);
  });
});

describe('admin resend endpoint', () => {
  it('requires the admin login and a valid kind', async () => {
    const s = paidSession([['a', 1]]);
    await webhook(s);
    assert.ok(await until(() => ordersStore.find(s.id).confirmation_emailed_at));
    assert.equal((await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'confirmation' })).status, 401);
    assert.equal((await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'confirmation' }, 'bad-token')).status, 401);
    const tok = await adminToken();
    assert.equal((await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'constructor' }, tok)).status, 400);
    assert.equal((await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'shipped' }, tok)).status, 400); // no tracking yet
    const before = sent.length;
    const r = await admin('POST', `/orders/${s.id}/resend-email`, { kind: 'confirmation' }, tok);
    assert.equal(r.status, 200);
    assert.equal(sent.length, before + 1);
    assert.ok(ordersStore.find(s.id).history.some((h) => h.event === 'Confirmation email resent'));
  });
});
