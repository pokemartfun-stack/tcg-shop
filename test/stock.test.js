const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `stock-products-${process.pid}.json`);
const tmpSettings = path.join(os.tmpdir(), `stock-settings-${process.pid}.json`);
const tmpOrders = path.join(__dirname, '..', 'data', 'orders.json');
const ordersBackup = fs.existsSync(tmpOrders) ? fs.readFileSync(tmpOrders, 'utf8') : null;
fs.writeFileSync(tmp, JSON.stringify([
  { id: 'a', title: 'Card A', price_gbp: 2, stock: 3, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'b', title: 'Card B', price_gbp: 5, stock: 0, condition: 'Near mint', category: 'Trading card lots', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = tmp;
process.env.SETTINGS_FILE = tmpSettings;
process.env.ADMIN_PASSWORD = 'owner-secret';
delete process.env.GITHUB_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_ID;
// checkout now needs an email + UK delivery address
const BUYER = { email: 't@example.com', address: { name: 'Ash Ketchum', line1: '1 Pallet Road', town: 'London', postcode: 'SW1A 1AA' } };

const app = require('../server/index');

let server, base, adminToken;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await call('POST', '/api/admin/login', { password: 'owner-secret' })).data.token;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { force: true });
  fs.rmSync(tmpSettings, { force: true });
  if (ordersBackup === null) fs.rmSync(tmpOrders, { force: true });
  else fs.writeFileSync(tmpOrders, ordersBackup);
});

async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.shopper) headers['x-session-token'] = opts.shopper;
  if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const cookie = res.headers.get('set-cookie') || '';
  const m = cookie.match(/session=([^;]+)/);
  return { status: res.status, data: await res.json().catch(() => ({})), session: m && decodeURIComponent(m[1]) };
}

async function newShopper() {
  return (await call('GET', '/api/cart')).session;
}
const stockOf = async (id) => (await call('GET', `/api/products/${id}`)).data.stock;
const fileStock = (id) => JSON.parse(fs.readFileSync(tmp, 'utf8')).find((p) => p.id === id).stock;

describe('stock enforcement', () => {
  it('refuses adding more than stock and out-of-stock cards', async () => {
    const s = await newShopper();
    assert.equal((await call('POST', '/api/cart/add', { productId: 'a', qty: 4 }, { shopper: s })).status, 400);
    assert.equal((await call('POST', '/api/cart/add', { productId: 'b', qty: 1 }, { shopper: s })).status, 400);
    assert.equal((await call('POST', '/api/cart/add', { productId: 'a', qty: 2 }, { shopper: s })).status, 200);
    assert.equal((await call('POST', '/api/cart/set-qty', { productId: 'a', qty: 9 }, { shopper: s })).status, 400);
  });

  it('demo checkout decrements stock and persists it', async () => {
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'a', qty: 2 }, { shopper: s });
    const r = await call('POST', '/api/checkout/demo', BUYER, { shopper: s });
    assert.equal(r.status, 200);
    assert.equal(await stockOf('a'), 1);
    assert.equal(fileStock('a'), 1);
    const cart = await call('GET', '/api/cart', null, { shopper: s });
    assert.equal(cart.data.items.length, 0);
  });

  it('refuses checkout when stock dropped below the cart quantity (stock unchanged)', async () => {
    const s1 = await newShopper();
    const s2 = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'a', qty: 1 }, { shopper: s1 });
    await call('POST', '/api/cart/add', { productId: 'a', qty: 1 }, { shopper: s2 });
    assert.equal((await call('POST', '/api/checkout/demo', BUYER, { shopper: s1 })).status, 200);
    assert.equal(await stockOf('a'), 0);
    const cart = await call('GET', '/api/cart', null, { shopper: s2 });
    assert.equal(cart.data.problems.length, 1);
    const r = await call('POST', '/api/checkout/demo', BUYER, { shopper: s2 });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /out of stock/);
    assert.equal((await call('POST', '/api/checkout/paypal/record', BUYER, { shopper: s2 })).status, 409);
    assert.equal((await call('GET', '/api/checkout/stock-check', null, { shopper: s2 })).status, 409);
    assert.equal(await stockOf('a'), 0);
  });

  it('demo PayPal order also decrements stock', async () => {
    await call('POST', '/api/admin/products/a/stock', { delta: 2 }, { admin: adminToken });
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'a', qty: 2 }, { shopper: s });
    assert.equal((await call('POST', '/api/checkout/paypal/record', BUYER, { shopper: s })).status, 200);
    assert.equal(await stockOf('a'), 0);
  });
});

describe('admin restock', () => {
  it('requires admin and applies +N / -N clamped at 0', async () => {
    assert.equal((await call('POST', '/api/admin/products/b/stock', { delta: 5 })).status, 401);
    let r = await call('POST', '/api/admin/products/b/stock', { delta: 5 }, { admin: adminToken });
    assert.equal(r.data.product.stock, 5);
    r = await call('POST', '/api/admin/products/b/stock', { delta: -100 }, { admin: adminToken });
    assert.equal(r.data.product.stock, 0);
    assert.equal(fileStock('b'), 0);
    assert.equal((await call('POST', '/api/admin/products/b/stock', { delta: 1.5 }, { admin: adminToken })).status, 400);
  });
});

describe('banner settings', () => {
  it('serves defaults publicly and lets admin update them', async () => {
    const pub = await call('GET', '/api/settings');
    assert.equal(pub.data.shop_name, 'Po-ke Mart Fun');
    assert.equal((await call('PUT', '/api/admin/settings', { tagline: 'x' })).status, 401);
    assert.equal((await call('PUT', '/api/admin/settings', { banner_image: 'javascript:alert(1)' }, { admin: adminToken })).status, 400);
    const ok = await call('PUT', '/api/admin/settings', { tagline: 'New tagline', banner_image: 'https://example.com/b.jpg' }, { admin: adminToken });
    assert.equal(ok.status, 200);
    const after = await call('GET', '/api/settings');
    assert.equal(after.data.tagline, 'New tagline');
    assert.equal(after.data.banner_image, 'https://example.com/b.jpg');
    assert.equal(JSON.parse(fs.readFileSync(tmpSettings, 'utf8')).tagline, 'New tagline');
  });

  it('page background: default is the repo image, validated, and can be cleared', async () => {
    assert.equal((await call('GET', '/api/settings')).data.background_image, '/images/background.jpg');
    assert.equal((await call('PUT', '/api/admin/settings', { background_image: 'javascript:alert(1)' }, { admin: adminToken })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { background_image: '/x.jpg") ; evil(' }, { admin: adminToken })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { background_image: '' }, { admin: adminToken })).status, 200);
    assert.equal((await call('GET', '/api/settings')).data.background_image, '');
    assert.equal((await call('PUT', '/api/admin/settings', { background_image: '/images/background.jpg' }, { admin: adminToken })).status, 200);
  });

  it('logo + "show shop name over banner" settings: defaults, toggling, validation', async () => {
    const pub = (await call('GET', '/api/settings')).data;
    assert.equal(pub.show_banner_text, false, 'off by default (banner art has its own lettering)');
    assert.equal(pub.logo_image, '/images/logo.png');
    for (const [input, expected] of [[true, true], ['on', true], [false, false], ['false', false]]) {
      const r = await call('PUT', '/api/admin/settings', { show_banner_text: input }, { admin: adminToken });
      assert.equal(r.status, 200);
      assert.equal(r.data.settings.show_banner_text, expected);
    }
    assert.equal(JSON.parse(fs.readFileSync(tmpSettings, 'utf8')).show_banner_text, false);
    assert.equal((await call('PUT', '/api/admin/settings', { logo_image: 'javascript:x' }, { admin: adminToken })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { logo_image: '/a.png"><script>' }, { admin: adminToken })).status, 400);
  });

  it('every customer page has the logo, favicon links and (index) a hero h1', async () => {
    for (const page of ['/', '/cart.html', '/checkout.html', '/success.html']) {
      const html = await (await fetch(base + page)).text();
      assert.match(html, /<img class="brand-logo" src="\/images\/logo\.png"/, page);
      assert.match(html, /rel="icon"[^>]+\/favicon\.png/, page);
      assert.doesNotMatch(html, /brand-mark/, page);
    }
    const index = await (await fetch(base + '/')).text();
    assert.match(index, /<h1 id="hero-name">/);
    for (const f of ['/images/logo.png', '/images/logo-default.png', '/favicon.png', '/favicon.ico', '/fonts/luckiest-guy-latin.woff2']) {
      assert.equal((await fetch(base + f)).status, 200, f);
    }
  });

  it('serves the committed background image file', async () => {
    const res = await fetch(base + '/images/background.jpg');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.ok((await res.arrayBuffer()).byteLength > 10000);
  });
});
