// New pages (Contact us, FAQ, Privacy, Terms, robots.txt, sitemap.xml), the shared header/footer
// on every public page, and the hidden demo placeholder-art listings.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-info-'));
fs.copyFileSync(path.join(__dirname, '..', 'data', 'products.json'), path.join(tmpDir, 'products.json'));
fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ shop_name: 'Po-ke Mart Fun' }));
process.env.PRODUCTS_FILE = path.join(tmpDir, 'products.json');
process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.ORDERS_FILE = path.join(tmpDir, 'orders.json');
delete process.env.GITHUB_TOKEN;
delete process.env.CONTACT_EMAIL;
delete process.env.SHOW_PLACEHOLDER_LISTINGS;

const app = require('../server/index');
const productStore = require('../server/products-store');
const { render } = require('../server/page-render');
let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };

describe('info pages', () => {
  for (const name of ['contact', 'faq', 'privacy', 'terms']) {
    it(`/${name} and /${name}.html are served with the shop header and footer`, async () => {
      for (const p of [`/${name}`, `/${name}.html`]) {
        const r = await get(p);
        assert.equal(r.status, 200, p);
        assert.match(r.type, /text\/html/);
        assert.match(r.text, /class="site-header"/);
        assert.match(r.text, /account-btn/);
        assert.match(r.text, /&copy; 2026 PO-KE-MART-FUN LIMITED/);
      }
    });
  }

  it('legal pages name the company and keep unknown details as visible placeholders', async () => {
    const terms = (await get('/terms')).text;
    const privacy = (await get('/privacy')).text;
    for (const html of [terms, privacy]) {
      assert.match(html, /PO-KE-MART-FUN LIMITED/);
      assert.doesNotMatch(html, /16870472/);
      assert.match(html, /\[REGISTERED ADDRESS — to confirm\]/);
      assert.match(html, /\[CONTACT EMAIL — to confirm\]/);
      assert.match(html, /Last updated:/);
    }
    assert.match(terms, /14 days/);
    assert.match(terms, /Consumer Contracts Regulations 2013/);
    for (const processor of ['Stripe', 'Render', 'GitHub', 'Royal Mail']) assert.match(privacy, new RegExp(processor));
  });

  it('CONTACT_EMAIL turns the email placeholders into a mailto link', () => {
    const html = '<p>Email: <span class="todo" data-contact-email>[CONTACT EMAIL — to confirm]</span></p>';
    assert.equal(render(html, {}, null, { contactEmail: '' }), html);
    const out = render(html, {}, null, { contactEmail: 'help@example.com' });
    assert.match(out, /<a href="mailto:help@example.com">help@example.com<\/a>/);
    assert.doesNotMatch(out, /to confirm/);
  });

  it('robots.txt blocks admin, API, checkout and success, and points to the sitemap', async () => {
    const r = await get('/robots.txt');
    assert.equal(r.status, 200);
    for (const p of ['/admin', '/api/', '/checkout', '/success']) assert.match(r.text, new RegExp(`Disallow: ${p.replace('/', '\\/')}`));
    assert.match(r.text, /Sitemap: https:\/\/tcg-shop-1\.onrender\.com\/sitemap\.xml/);
  });

  it('sitemap.xml lists the public pages', async () => {
    const r = await get('/sitemap.xml');
    assert.equal(r.status, 200);
    for (const p of ['', 'track', 'contact', 'faq', 'privacy', 'terms']) assert.ok(r.text.includes(`<loc>https://tcg-shop-1.onrender.com/${p}</loc>`), p);
    assert.doesNotMatch(r.text, /admin|checkout|success/);
  });

  it('/success works without .html', async () => {
    const r = await get('/success');
    assert.equal(r.status, 200);
    assert.match(r.text, /Thank you — Po-ke Mart Fun/);
  });
});

describe('shared header and footer', () => {
  for (const p of ['/', '/cart.html', '/checkout', '/track', '/thank-you']) {
    it(`${p}: Shop / Track / Cart / Account header and the new footer`, async () => {
      const html = (await get(p)).text;
      assert.match(html, /<a href="\/">Shop<\/a>/);
      assert.match(html, /<a href="\/track" aria-label="Track order">Track<span class="nav-long">order<\/span><\/a>/);
      assert.match(html, /<a href="\/cart.html" class="nav-cart">Cart/);
      assert.match(html, /data-open-auth="login" aria-label="Account/);
      assert.match(html, /data-auth-user hidden/);
      for (const link of ['/contact', '/faq', '/privacy', '/terms']) assert.ok(html.includes(`href="${link}"`), link);
      assert.match(html, /Not affiliated with Nintendo \/ The Pok/);
      assert.doesNotMatch(html, /UK shop demo|Placeholder card art/);
    });
  }

  it('the intro no longer promises PayPal', async () => {
    const html = (await get('/')).text;
    assert.doesNotMatch(html, /PayPal/);
    assert.match(html, /through Stripe/);
  });
});

describe('demo placeholder-art listings', () => {
  const DEMO = ['tauros-ar', 'varoom-ar', 'revavroom-sar', 'pikachu-promo', 'charizard-ex', 'lot-bulk-commons'];

  it('are hidden from the shop but kept in products.json', async () => {
    const pub = JSON.parse((await get('/api/products')).text).map((p) => p.id);
    for (const id of DEMO) assert.ok(!pub.includes(id), id);
    assert.ok(pub.length >= 1);
    const all = productStore.get().map((p) => p.id);
    for (const id of DEMO) assert.ok(all.includes(id), id);
    assert.equal((await get('/api/products/tauros-ar')).status, 404);
  });

  it('cannot be added to the cart', async () => {
    const r = await fetch(base + '/api/cart/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 'tauros-ar', qty: 1 }) });
    assert.equal(r.status, 400);
  });

  it('show again once they get a real photo, or with SHOW_PLACEHOLDER_LISTINGS=yes', () => {
    const p = productStore.get().find((x) => x.id === 'tauros-ar');
    assert.equal(productStore.isPlaceholderListing(p), true);
    assert.equal(productStore.isPlaceholderListing({ ...p, images: ['/uploads/tauros.jpg'], image: '/uploads/tauros.jpg' }), false);
    assert.equal(productStore.isPlaceholderListing({ id: 'other', image: '/images/x.svg', images: ['/images/x.svg'] }), false);
    process.env.SHOW_PLACEHOLDER_LISTINGS = 'yes';
    try {
      assert.ok(productStore.publicList().some((x) => x.id === 'tauros-ar'));
    } finally {
      delete process.env.SHOW_PLACEHOLDER_LISTINGS;
    }
    assert.ok(!productStore.publicList().some((x) => x.id === 'tauros-ar'));
  });
});
