// Shop tabs (Cards & Lots / Sealed Products / Accessories & Merch) and category mapping.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-tabs-'));
const tmpProducts = path.join(tmpDir, 'products.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'products.json'), tmpProducts);
process.env.PRODUCTS_FILE = tmpProducts;
delete process.env.GITHUB_TOKEN;

const CAT = require('../public/js/categories');
const importer = require('../server/importer');
const store = require('../server/products-store');
const { render } = require('../server/page-render');
const app = require('../server/index');

const ACC = 'Accessories & Merch';

describe('category mapping', () => {
  it('has exactly the four shop categories and three tabs', () => {
    assert.deepEqual(CAT.CATEGORIES, ['Trading cards', 'Trading card lots', 'Sealed products', ACC]);
    assert.deepEqual(CAT.TABS.map((t) => [t.id, t.label]), [
      ['cards', 'Cards & Lots'], ['sealed', 'Sealed Products'], ['accessories', ACC],
    ]);
    assert.equal(CAT.DEFAULT_TAB, 'cards');
  });

  it('keeps Vinted "Hobbies & Collectables > …" cards and lots in Cards & Lots', () => {
    assert.equal(CAT.normaliseCategory('Hobbies & Collectables > Trading cards'), 'Trading cards');
    assert.equal(CAT.normaliseCategory('Hobbies & Collectables > Trading card lots'), 'Trading card lots');
    assert.equal(CAT.normaliseCategory('trading CARD lots'), 'Trading card lots');
    assert.equal(CAT.tabForCategory('Trading card lots'), 'cards');
  });

  it('maps sealed words to Sealed products', () => {
    for (const v of ['Sealed products', 'sealed', 'Booster box', 'Booster packs', 'Elite Trainer Box', 'ETB', 'Pokémon tin', 'Hobbies & Collectables > Booster boxes']) {
      assert.equal(CAT.normaliseCategory(v), 'Sealed products', v);
      assert.equal(CAT.tabForCategory(v), 'sealed', v);
    }
  });

  it('maps accessory, merch and toy words to Accessories & Merch ("deck box" is not sealed)', () => {
    for (const v of ['Accessories', ACC, 'accessories & merch', 'Card sleeves', 'Toploaders', 'Binder', 'Deck box', 'Playmat',
      'Figure', 'Figures & models', 'Model', 'Plush', 'Plushies', 'Cushion', 'Merch', 'Merchandise', 'Toy', 'Soft toys']) {
      assert.equal(CAT.normaliseCategory(v), ACC, v);
      assert.equal(CAT.tabForCategory(v), 'accessories', v);
    }
  });

  it('sends unknown / empty categories to Cards & Lots', () => {
    for (const v of ['', null, undefined, 'Hobbies & Collectables', 'Something else']) {
      assert.equal(CAT.normaliseCategory(v), 'Trading cards');
      assert.equal(CAT.tabForCategory(v), 'cards');
    }
  });

  it('parses ?tab= values safely', () => {
    assert.equal(CAT.parseTab('sealed'), 'sealed');
    assert.equal(CAT.parseTab('ACCESSORIES'), 'accessories');
    assert.equal(CAT.parseTab('Sealed Products'), 'sealed');
    assert.equal(CAT.parseTab(''), 'cards');
    assert.equal(CAT.parseTab('<script>'), 'cards');
    assert.equal(CAT.parseTab(null), 'cards');
  });
});

describe('tab filtering', () => {
  const list = [
    { id: 'a', category: 'Trading cards' },
    { id: 'b', category: 'Trading card lots' },
    { id: 'c', category: 'Sealed products' },
    { id: 'd', category: ACC },
    { id: 'e', category: 'Odd old value' },
  ];
  it('splits products into the three tabs, unknown going to Cards & Lots', () => {
    assert.deepEqual(CAT.productsInTab(list, 'cards').map((p) => p.id), ['a', 'b', 'e']);
    assert.deepEqual(CAT.productsInTab(list, 'sealed').map((p) => p.id), ['c']);
    assert.deepEqual(CAT.productsInTab(list, 'accessories').map((p) => p.id), ['d']);
    assert.deepEqual(CAT.productsInTab(list, 'nonsense').map((p) => p.id), ['a', 'b', 'e']);
  });
  it('puts every current shop product in Cards & Lots', () => {
    const products = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'products.json'), 'utf8'));
    assert.equal(CAT.productsInTab(products, 'cards').length, products.length);
    assert.equal(CAT.productsInTab(products, 'sealed').length, 0);
  });
});

describe('importer + store use the shop categories', () => {
  it('Vinted JSON keeps working and accepts sealed / merch categories', () => {
    const base = { price: '£3.50', quality: 'Near mint', photos: [] };
    const r = importer.importList([
      { ...base, title: 'Pikachu V', category: 'Hobbies & Collectables > Trading cards' },
      { ...base, title: 'Bulk lot', category: 'Hobbies & Collectables > Trading card lots' },
      { ...base, title: '151 ETB', category: 'Elite Trainer Box' },
      { ...base, title: 'Snorlax plush', category: 'Plush toy' },
      { ...base, title: 'Mystery', category: 'Hobbies & Collectables > Board games' },
    ]);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(r.items.map((i) => i.product.category),
      ['Trading cards', 'Trading card lots', 'Sealed products', ACC, 'Trading cards']);
  });
  it('store.normalise stores one of the four categories', () => {
    const p = (category) => store.normalise({ id: 'x', title: 'X', price_gbp: 1, stock: 1, category }).product.category;
    assert.equal(p('Sealed products'), 'Sealed products');
    assert.equal(p('accessories'), ACC);
    assert.equal(p(undefined), 'Trading cards');
  });
});

describe('server-rendered tabs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const active = (out) => (/<a class="shop-tab active" href="[^"]*" data-tab="([a-z]+)" aria-current="page">/.exec(out) || [])[1];

  it('index.html has the three tab links above the filters', () => {
    for (const t of ['cards', 'sealed', 'accessories']) assert.match(html, new RegExp(`href="/\\?tab=${t}" data-tab="${t}"`));
    assert.ok(html.indexOf('id="shop-tabs"') < html.indexOf('class="filters"'));
    assert.ok(html.indexOf('id="mode-banner"') < html.indexOf('id="shop-tabs"'));
    assert.match(html, /src="\/js\/categories\.js"/);
  });
  it('marks the ?tab= tab as current (default Cards & Lots)', () => {
    assert.equal(active(render(html, {}, null, {})), 'cards');
    assert.equal(active(render(html, {}, null, { tab: 'sealed' })), 'sealed');
    assert.equal(active(render(html, {}, null, { tab: 'accessories' })), 'accessories');
    assert.equal(active(render(html, {}, null, { tab: 'bogus' })), 'cards');
    assert.equal((render(html, {}, null, { tab: 'sealed' }).match(/aria-current="page"/g) || []).length, 1);
  });

  let server, base;
  before(async () => {
    store.reset();
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('GET /?tab=sealed serves the page with Sealed Products current, and categories.js is served', async () => {
    const res = await fetch(`${base}/?tab=sealed`);
    assert.equal(res.status, 200);
    assert.equal(active(await res.text()), 'sealed');
    const js = await fetch(`${base}/js/categories.js`);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /TCGCategories/);
  });

  it('admin can set a product category (moves it to another tab)', async () => {
    process.env.ADMIN_PASSWORD = 'owner-secret';
    const login = await (await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'owner-secret' }),
    })).json();
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
    const add = await fetch(`${base}/api/admin/products`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ id: 'etb-test', title: 'ETB test', price_gbp: 45, stock: 1, condition: 'New (sealed)', category: 'Sealed products' }),
    });
    assert.equal(add.status, 200);
    assert.equal((await add.json()).product.category, 'Sealed products');
    const patch = await fetch(`${base}/api/admin/products/etb-test`, { method: 'PATCH', headers: h, body: JSON.stringify({ category: ACC }) });
    assert.equal((await patch.json()).product.category, ACC);
    const shop = await (await fetch(`${base}/api/products`)).json();
    assert.deepEqual(CAT.productsInTab(shop, 'accessories').map((p) => p.id), ['etb-test']);
  });
});
