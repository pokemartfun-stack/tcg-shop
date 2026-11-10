'use strict';
// Security batch: demo checkout blocked when payments are configured, security headers,
// session cookie Secure flag, admin login rate limit, and fees hidden from public settings.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-security-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'sec-card', title: 'Security test card', price_gbp: 4, stock: 5, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.ADMIN_PASSWORD = 'owner-secret';
delete process.env.GITHUB_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PUBLISHABLE_KEY;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.BASE_URL;
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;

const app = require('../server/index');
const admin = require('../server/admin');
const settingsStore = require('../server/settings-store');
const productStore = require('../server/products-store');

const BUYER = { email: 'sec@example.com', address: { name: 'Ash Ketchum', line1: '1 Pallet Road', town: 'London', postcode: 'SW1A 1AA' } };

let server, base;
before(async () => {
  settingsStore.reset();
  productStore.reset();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.shopper) headers['x-session-token'] = opts.shopper;
  if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
  if (opts.ip) headers['X-Forwarded-For'] = opts.ip;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const cookie = res.headers.get('set-cookie') || '';
  const m = cookie.match(/session=([^;]+)/);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers, cookie, session: m && decodeURIComponent(m[1]) };
}

async function newShopper() {
  return (await call('GET', '/api/cart')).session;
}

async function cartWithItem(qty = 1) {
  const s = await newShopper();
  const r = await call('POST', '/api/cart/add', { productId: 'sec-card', qty }, { shopper: s });
  assert.equal(r.status, 200);
  return s;
}

function stockOf(id) {
  return productStore.get().find((p) => p.id === id).stock;
}

describe('demo checkout is refused when payments are configured', () => {
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.PAYPAL_CLIENT_ID;
  });

  it('still records a demo order when no payment keys are set', async () => {
    const before = stockOf('sec-card');
    const s = await cartWithItem(1);
    const r = await call('POST', '/api/checkout/demo', BUYER, { shopper: s });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.demo, true);
    assert.equal(stockOf('sec-card'), before - 1);
  });

  it('refuses POST /api/checkout/demo when Stripe is configured and does not take stock', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy';
    const before = stockOf('sec-card');
    const s = await cartWithItem(1);
    const r = await call('POST', '/api/checkout/demo', BUYER, { shopper: s });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /turned off/i);
    assert.equal(stockOf('sec-card'), before);
    const cart = await call('GET', '/api/cart', null, { shopper: s });
    assert.equal(cart.data.count, 1);
  });

  it('refuses POST /api/checkout/demo when only PayPal is configured', async () => {
    process.env.PAYPAL_CLIENT_ID = 'paypal-dummy';
    const s = await cartWithItem(1);
    const r = await call('POST', '/api/checkout/demo', BUYER, { shopper: s });
    assert.equal(r.status, 403);
  });

  it('refuses the demo PayPal recording path when Stripe is configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy';
    const before = stockOf('sec-card');
    const s = await cartWithItem(1);
    const r = await call('POST', '/api/checkout/paypal/record', BUYER, { shopper: s });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /turned off/i);
    assert.equal(stockOf('sec-card'), before);
  });

  it('refuses a PayPal record without a PayPal order id when PayPal is configured', async () => {
    process.env.PAYPAL_CLIENT_ID = 'paypal-dummy';
    const before = stockOf('sec-card');
    const s = await cartWithItem(1);
    const r = await call('POST', '/api/checkout/paypal/record', BUYER, { shopper: s });
    assert.equal(r.status, 403);
    assert.equal(stockOf('sec-card'), before);
  });

  it('still records a demo PayPal order when no payment keys are set', async () => {
    const before = stockOf('sec-card');
    const s = await cartWithItem(1);
    const r = await call('POST', '/api/checkout/paypal/record', BUYER, { shopper: s });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.demo, true);
    assert.equal(stockOf('sec-card'), before - 1);
  });
});

describe('security headers and session cookie', () => {
  const savedBase = process.env.BASE_URL;
  afterEach(() => {
    if (savedBase === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = savedBase;
  });

  it('sends standard security headers and hides X-Powered-By on HTML and API responses', async () => {
    for (const url of ['/', '/checkout', '/track', '/admin', '/api/health', '/api/settings']) {
      const r = await call('GET', url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', url);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', url);
      if (url.startsWith('/api/customer-orders')) continue;
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', url);
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self'", url);
      assert.equal(r.headers.get('x-powered-by'), null, url);
      assert.equal(r.headers.get('strict-transport-security'), null, url);
    }
  });

  it('adds HSTS only when BASE_URL is https', async () => {
    process.env.BASE_URL = 'https://tcg-shop-1.onrender.com';
    const r = await call('GET', '/api/health');
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    process.env.BASE_URL = 'http://localhost:3847';
    const http = await call('GET', '/api/health');
    assert.equal(http.headers.get('strict-transport-security'), null);
  });

  it('sets the Secure flag on the session cookie when BASE_URL is https', async () => {
    process.env.BASE_URL = 'https://tcg-shop-1.onrender.com';
    const r = await call('GET', '/api/cart');
    assert.match(r.cookie, /session=/);
    assert.match(r.cookie, /;\s*Secure/i);
    assert.match(r.cookie, /HttpOnly/i);
    process.env.BASE_URL = 'http://localhost:3847';
    const http = await call('GET', '/api/cart');
    assert.match(http.cookie, /session=/);
    assert.doesNotMatch(http.cookie, /;\s*Secure/i);
  });
});

describe('admin login rate limit', () => {
  beforeEach(() => admin._resetLoginAttempts());
  afterEach(() => admin._resetLoginAttempts());

  it('allows 5 failed tries per IP in 15 minutes, then returns 429 with a friendly message', async () => {
    const ip = '198.51.100.20';
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/admin/login', { password: 'wrong-password' }, { ip });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
      assert.equal(r.data.error, 'Wrong password');
    }
    const blocked = await call('POST', '/api/admin/login', { password: 'wrong-password' }, { ip });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /15 minutes/i);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // Even the correct password is refused until the window ends
    const correct = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip });
    assert.equal(correct.status, 429);
  });

  it('does not lock out a different IP, and a successful sign-in clears earlier failures', async () => {
    const a = '198.51.100.21';
    const b = '198.51.100.22';
    for (let i = 0; i < 4; i++) {
      assert.equal((await call('POST', '/api/admin/login', { password: 'nope' }, { ip: a })).status, 401);
    }
    const other = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: b });
    assert.equal(other.status, 200);
    const ok = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: a });
    assert.equal(ok.status, 200);
    // After the successful sign-in, further failures start from a clean slate
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/admin/login', { password: 'nope' }, { ip: a })).status, 401);
    }
    assert.equal((await call('POST', '/api/admin/login', { password: 'nope' }, { ip: a })).status, 429);
  });

  it('never logs the password on a failed or successful sign-in', async () => {
    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const spy = (...args) => { logs.push(args.map(String).join(' ')); };
    console.log = spy; console.error = spy; console.warn = spy; console.info = spy;
    const secret = 'unique-pw-should-never-appear-in-logs-9f3a';
    try {
      await call('POST', '/api/admin/login', { password: secret }, { ip: '198.51.100.23' });
      process.env.ADMIN_PASSWORD = secret;
      await call('POST', '/api/admin/login', { password: secret }, { ip: '198.51.100.24' });
    } finally {
      Object.assign(console, orig);
      process.env.ADMIN_PASSWORD = 'owner-secret';
    }
    assert.ok(!logs.some((line) => line.includes(secret)), `password leaked in logs: ${logs.join(' | ')}`);
  });
});

describe('public settings hide admin-only fee estimates', () => {
  it('omits fees from GET /api/settings but keeps them on the admin settings endpoint', async () => {
    const pub = await call('GET', '/api/settings');
    assert.equal(pub.status, 200);
    assert.equal(pub.data.fees, undefined);
    assert.ok(!('fees' in pub.data));
    assert.equal(pub.data.shop_name, 'Po-ke Mart Fun');
    assert.ok(pub.data.postage);

    const login = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.30' });
    assert.equal(login.status, 200);
    const adm = await call('GET', '/api/admin/settings', null, { admin: login.data.token });
    assert.equal(adm.status, 200);
    assert.ok(adm.data.fees);
    assert.equal(typeof adm.data.fees.stripe.percent, 'number');
    assert.equal(typeof adm.data.fees.paypal.fixed, 'number');
  });
});
