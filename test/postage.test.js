// Postage: Royal Mail Tracked 48, one charge per order at the largest band in the basket.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-postage-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'single', title: 'Single card', price_gbp: 4, stock: 10, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'lot', title: 'Card lot', price_gbp: 12, stock: 10, condition: 'Good', category: 'Trading card lots', image: '/images/tauros-ar.svg' },
  { id: 'thick-lot', title: 'Thick lot', price_gbp: 6, stock: 10, condition: 'Good', category: 'Trading card lots', postage_band: 'Small Parcel', image: '/images/tauros-ar.svg' },
  { id: 'box', title: 'Booster box', price_gbp: 12, stock: 10, condition: 'New (sealed)', category: 'Sealed products', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.ADMIN_PASSWORD = 'owner-secret';
delete process.env.GITHUB_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_ID;

const postage = require('../server/postage');
const store = require('../server/products-store');
const importer = require('../server/importer');
const { enrichCart } = require('../server/cart');
const { buildStripeShipping, addressMetadata } = require('../server/payments');
const app = require('../server/index');

const ADDRESS = { name: 'Ash Ketchum', line1: '1 Pallet Road', town: 'London', postcode: 'sw1a1aa' };

describe('postage bands', () => {
  it('offers Large Letter and Small Parcel at Royal Mail Tracked 48 online prices', () => {
    assert.deepEqual(postage.BAND_IDS, ['Large Letter', 'Small Parcel']);
    assert.equal(postage.DEFAULT_POSTAGE.service, 'Royal Mail Tracked 48');
    assert.equal(postage.DEFAULT_POSTAGE.bands['Large Letter'].price, 2.9);
    assert.equal(postage.DEFAULT_POSTAGE.bands['Small Parcel'].price, 3.75);
    assert.equal(postage.DEFAULT_POSTAGE.free_over_enabled, false);
  });

  it('maps Vinted sizes: Small -> Large Letter, Medium/Large -> Small Parcel', () => {
    assert.equal(postage.bandFromVinted('Small'), 'Large Letter');
    assert.equal(postage.bandFromVinted('small'), 'Large Letter');
    assert.equal(postage.bandFromVinted('Medium'), 'Small Parcel');
    assert.equal(postage.bandFromVinted('Large'), 'Small Parcel');
    assert.equal(postage.bandFromVinted('Extra large'), 'Small Parcel');
    assert.equal(postage.bandFromVinted(''), null);
  });

  it('missing size: Large Letter for single cards and card lots, Small Parcel for sealed / accessories', () => {
    assert.equal(postage.bandForProduct({ category: 'Trading cards' }), 'Large Letter');
    assert.equal(postage.bandForProduct({ category: 'Trading card lots' }), 'Large Letter');
    assert.equal(postage.defaultBand('trading card LOTS'), 'Large Letter');
    assert.equal(postage.bandForProduct({ category: 'Sealed products' }), 'Small Parcel');
    assert.equal(postage.bandForProduct({ category: 'Accessories & Merch' }), 'Small Parcel');
    assert.equal(postage.bandForProduct({}), 'Large Letter');
    // an explicit band (set in admin) wins over the Vinted size and the category
    assert.equal(postage.bandForProduct({ postage_band: 'small parcel', postage_size: 'Small', category: 'Trading cards' }), 'Small Parcel');
  });
});

describe('postage quote', () => {
  const LL = { postage_band: 'Large Letter', qty: 1 };
  const SP = { postage_band: 'Small Parcel', qty: 1 };

  it('charges once, at the largest band in the basket', () => {
    assert.equal(postage.quote([LL, { ...LL, qty: 5 }], 10).amount, 2.9);
    const q = postage.quote([LL, LL, SP], 20);
    assert.equal(q.band, 'Small Parcel');
    assert.equal(q.amount, 3.75);
    assert.equal(q.total, 23.75);
    assert.equal(postage.quote([SP, SP, SP], 30).amount, 3.75); // not per item
  });

  it('no postage on an empty basket', () => {
    const q = postage.quote([], 0);
    assert.equal(q.amount, 0);
    assert.equal(q.band, null);
  });

  it('uses the prices set in admin', () => {
    const q = postage.quote([SP], 10, { bands: { 'Large Letter': { price: 1.5 }, 'Small Parcel': { price: 4.2 } } });
    assert.equal(q.amount, 4.2);
    assert.equal(q.total, 14.2);
  });

  it('free postage threshold: off by default, applies at or over the amount when on', () => {
    assert.equal(postage.quote([SP], 100).amount, 3.75);
    const on = { free_over_enabled: true, free_over: 25 };
    assert.equal(postage.quote([SP], 24.99, on).amount, 3.75);
    const q = postage.quote([SP], 25, on);
    assert.equal(q.amount, 0);
    assert.equal(q.free, true);
    assert.equal(q.total, 25);
  });

  it('validates admin postage settings', () => {
    assert.match(postage.validatePostage({ bands: { 'Small Parcel': { price: -1 } } }).error, /Small Parcel/);
    assert.match(postage.validatePostage({ bands: { 'Large Letter': { price: '' } } }).error, /Large Letter/);
    assert.match(postage.validatePostage({ free_over: 'abc' }).error, /threshold/);
    const ok = postage.validatePostage({ bands: { 'Large Letter': { price: '3.1' } }, free_over_enabled: 'on', free_over: '40' }).postage;
    assert.equal(ok.bands['Large Letter'].price, 3.1);
    assert.equal(ok.bands['Small Parcel'].price, 3.75);
    assert.equal(ok.free_over_enabled, true);
    assert.equal(ok.free_over, 40);
  });

  it('validates UK delivery addresses', () => {
    const a = postage.validateAddress(ADDRESS);
    assert.equal(a.address.postcode, 'SW1A 1AA');
    assert.equal(a.address.country, 'United Kingdom');
    assert.equal(postage.validateAddress({ ...ADDRESS, postcode: '12345' }).field, 'postcode');
    assert.equal(postage.validateAddress({ ...ADDRESS, line1: '' }).field, 'line1');
    assert.equal(postage.validateAddress({ ...ADDRESS, name: ' ' }).field, 'name');
    assert.equal(postage.validateAddress({ ...ADDRESS, phone: 'call me' }).field, 'phone');
    assert.equal(postage.validateAddress({ ...ADDRESS, postcode: 'm1 1ae' }).address.postcode, 'M1 1AE');
  });
});

describe('products + import keep a postage band', () => {
  it('store.normalise sets postage_band (and keeps the Vinted size)', () => {
    const n = (p) => store.normalise({ id: 'x', title: 'X', price_gbp: 1, stock: 1, ...p }).product;
    assert.equal(n({ category: 'Trading cards' }).postage_band, 'Large Letter');
    assert.equal(n({ category: 'Trading card lots' }).postage_band, 'Large Letter');
    assert.equal(n({ category: 'Sealed products' }).postage_band, 'Small Parcel');
    assert.equal(n({ category: 'Accessories & Merch' }).postage_band, 'Small Parcel');
    const v = n({ postage_size: 'Medium', category: 'Trading cards' });
    assert.equal(v.postage_band, 'Small Parcel');
    assert.equal(v.postage_size, 'Medium');
    assert.equal(n({ postage_band: 'Small Parcel' }).postage_band, 'Small Parcel');
  });

  it('Vinted import maps postage_size', () => {
    const base = { price: '3', quality: 'Near mint', photos: [] };
    const r = importer.importList([
      { ...base, title: 'A', postage_size: 'Small', category: 'Hobbies & Collectables > Trading card lots' },
      { ...base, title: 'B', postage_size: 'Medium', category: 'Hobbies & Collectables > Trading cards' },
      { ...base, title: 'C', postage_size: 'Large', category: 'Hobbies & Collectables > Trading cards' },
      { ...base, title: 'D', category: 'Hobbies & Collectables > Trading cards' },
      { ...base, title: 'E', category: 'Hobbies & Collectables > Trading card lots' },
      { ...base, title: 'F', postage_size: 'Medium', category: 'Hobbies & Collectables > Trading card lots' },
      { ...base, title: 'G', category: 'Booster box' },
    ]);
    assert.deepEqual(r.items.map((i) => i.product.postage_band), ['Large Letter', 'Small Parcel', 'Small Parcel', 'Large Letter', 'Large Letter', 'Small Parcel', 'Small Parcel']);
  });

  it('enrichCart adds server-side postage + total', () => {
    const products = [{ id: 'a', title: 'A', price_gbp: 2, stock: 5, postage_band: 'Large Letter' }, { id: 'b', title: 'B', price_gbp: 10, stock: 5, postage_band: 'Small Parcel' }];
    const e = enrichCart({ items: [{ productId: 'a', qty: 3 }, { productId: 'b', qty: 1 }] }, products, postage.DEFAULT_POSTAGE);
    assert.equal(e.subtotal, 16);
    assert.equal(e.postage.band, 'Small Parcel');
    assert.equal(e.total, 19.75);
  });

  it('Stripe gets the postage as a shipping option (in pence) and the address as metadata', () => {
    const s = buildStripeShipping(postage.quote([{ postage_band: 'Small Parcel', qty: 1 }], 10));
    assert.equal(s.shipping_rate_data.fixed_amount.amount, 375);
    assert.equal(s.shipping_rate_data.fixed_amount.currency, 'gbp');
    assert.match(s.shipping_rate_data.display_name, /Royal Mail Tracked 48/);
    assert.equal(buildStripeShipping(postage.quote([], 0)), null);
    assert.match(addressMetadata(postage.validateAddress(ADDRESS).address).ship_to, /SW1A 1AA/);
  });
});

describe('checkout charges postage (server-side)', () => {
  let server, base, adminToken;
  before(async () => {
    store.reset();
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    adminToken = (await call('POST', '/api/admin/login', { password: 'owner-secret' })).data.token;
  });
  after(() => { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function call(method, url, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.shopper) headers['x-session-token'] = opts.shopper;
    if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const m = (res.headers.get('set-cookie') || '').match(/session=([^;]+)/);
    return { status: res.status, data: await res.json().catch(() => ({})), session: m && decodeURIComponent(m[1]) };
  }
  const newShopper = async () => (await call('GET', '/api/cart')).session;
  const orders = () => JSON.parse(fs.readFileSync(P('orders.json'), 'utf8'));

  it('cart shows one Tracked 48 charge at the largest band', async () => {
    const s = await newShopper();
    let c = (await call('POST', '/api/cart/add', { productId: 'single', qty: 3 }, { shopper: s })).data;
    assert.equal(c.postage.band, 'Large Letter');
    assert.equal(c.postage.amount, 2.9);
    assert.equal(c.total, 14.9);
    c = (await call('POST', '/api/cart/add', { productId: 'box', qty: 1 }, { shopper: s })).data;
    assert.equal(c.postage.band, 'Small Parcel');
    assert.equal(c.postage.amount, 3.75);
    assert.equal(c.total, 27.75);
    const q = (await call('GET', '/api/checkout/quote', null, { shopper: s })).data;
    assert.deepEqual([q.subtotal, q.postage.amount, q.total], [24, 3.75, 27.75]);
  });

  it('card lots without a size go as a Large Letter, like singles', async () => {
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'single', qty: 2 }, { shopper: s });
    const c = (await call('POST', '/api/cart/add', { productId: 'lot', qty: 1 }, { shopper: s })).data;
    assert.equal(c.postage.band, 'Large Letter');
    assert.equal(c.postage.amount, 2.9);
    assert.equal(c.total, 22.9);
  });

  it('a lot set to Small Parcel in admin makes the basket a Small Parcel', async () => {
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'lot', qty: 1 }, { shopper: s });
    const c = (await call('POST', '/api/cart/add', { productId: 'thick-lot', qty: 1 }, { shopper: s })).data;
    assert.equal(c.postage.band, 'Small Parcel');
  });

  it('checkout needs an email and a UK delivery address', async () => {
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'single', qty: 1 }, { shopper: s });
    let r = await call('POST', '/api/checkout/demo', { email: 'a@b.co' }, { shopper: s });
    assert.equal(r.status, 400);
    assert.equal(r.data.field, 'name');
    r = await call('POST', '/api/checkout/demo', { address: ADDRESS }, { shopper: s });
    assert.equal(r.data.field, 'email');
    r = await call('POST', '/api/checkout/demo', { email: 'a@b.co', address: { ...ADDRESS, postcode: 'NOPE' } }, { shopper: s });
    assert.equal(r.data.field, 'postcode');
    assert.equal((await call('POST', '/api/checkout/paypal/record', { email: 'a@b.co' }, { shopper: s })).status, 400);
  });

  it('demo order total includes postage worked out by the server (client values ignored) and is stored on the order', async () => {
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'single', qty: 2 }, { shopper: s });
    await call('POST', '/api/cart/add', { productId: 'box', qty: 1 }, { shopper: s });
    const r = await call('POST', '/api/checkout/demo', {
      email: 'buyer@example.com', address: { ...ADDRESS, phone: '07700 900123' },
      postage: { amount: 0 }, total: 1, subtotal: 1, // must be ignored
    }, { shopper: s });
    assert.equal(r.status, 200);
    const o = r.data.order;
    assert.equal(o.subtotal, 20);
    assert.deepEqual(o.postage, { service: 'Royal Mail Tracked 48', band: 'Small Parcel', amount: 3.75, free: false });
    assert.equal(o.total, 23.75);
    assert.equal(o.shipping_address.postcode, 'SW1A 1AA');
    assert.equal(o.shipping_address.phone, '07700 900123');
    const saved = orders().find((x) => x.id === o.id);
    assert.equal(saved.total, 23.75);
    assert.equal(saved.postage.band, 'Small Parcel');
  });

  it('PayPal (demo) order records postage too', async () => {
    const s = await newShopper();
    await call('POST', '/api/cart/add', { productId: 'single', qty: 1 }, { shopper: s });
    const r = await call('POST', '/api/checkout/paypal/record', { email: 'p@example.com', address: ADDRESS }, { shopper: s });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.postage.amount, 2.9);
    assert.equal(r.data.order.total, 6.9);
    assert.equal(r.data.order.shipping_address.town, 'London');
  });

  it('admin postage prices + free threshold change what the server charges', async () => {
    assert.equal((await call('PUT', '/api/admin/settings', { postage: { bands: { 'Small Parcel': { price: -2 } } } }, { admin: adminToken })).status, 400);
    const put = await call('PUT', '/api/admin/settings', { postage: { bands: { 'Large Letter': { price: '3.00' }, 'Small Parcel': { price: '4.50' } } } }, { admin: adminToken });
    assert.equal(put.status, 200);
    assert.equal(put.data.settings.postage.bands['Small Parcel'].price, 4.5);
    assert.equal(put.data.settings.postage.free_over_enabled, false);
    const st = (await call('GET', '/api/admin/settings', null, { admin: adminToken })).data;
    assert.deepEqual(st.postage_bands.map((b) => b.id), ['Large Letter', 'Small Parcel']);
    // partial update keeps the prices
    await call('PUT', '/api/admin/settings', { postage: { free_over_enabled: true, free_over: 30 } }, { admin: adminToken });
    assert.equal(JSON.parse(fs.readFileSync(P('settings.json'), 'utf8')).postage.bands['Small Parcel'].price, 4.5);

    const s = await newShopper();
    let c = (await call('POST', '/api/cart/add', { productId: 'box', qty: 1 }, { shopper: s })).data;
    assert.equal(c.postage.amount, 4.5);
    assert.equal(c.total, 16.5);
    c = (await call('POST', '/api/cart/add', { productId: 'box', qty: 2 }, { shopper: s })).data; // £36 >= £30
    assert.equal(c.postage.amount, 0);
    assert.equal(c.postage.free, true);
    const r = await call('POST', '/api/checkout/demo', { email: 'f@example.com', address: ADDRESS }, { shopper: s });
    assert.equal(r.data.order.total, 36);
    assert.equal(r.data.order.postage.free, true);
  });
});
