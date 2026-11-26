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
delete process.env.COMPANY_ADDRESS;
delete process.env.VAT_NUMBER;
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

  it('legal pages name the company and do not show placeholders or the company number', async () => {
    for (const name of ['contact', 'faq', 'privacy', 'terms']) {
      const html = (await get('/' + name)).text;
      assert.match(html, /PO-KE-MART-FUN LIMITED/);
      assert.doesNotMatch(html, new RegExp('16870' + '472'));
      assert.doesNotMatch(html, /to confirm/i);
      assert.doesNotMatch(html, /class="todo"/);
      assert.doesNotMatch(html, /\[REGISTERED ADDRESS/);
      assert.doesNotMatch(html, /\[CONTACT EMAIL/);
      assert.doesNotMatch(html, /Last updated:/);
      assert.doesNotMatch(html, /Registered office:/);
      assert.doesNotMatch(html, />VAT:/);
      assert.doesNotMatch(html, /ICO registration/);
    }
    const terms = (await get('/terms')).text;
    const privacy = (await get('/privacy')).text;
    const contact = (await get('/contact')).text;
    const faq = (await get('/faq')).text;
    assert.match(terms, /<h2>1\. Your order<\/h2>/);
    assert.match(terms, /<h2>2\. Products and condition<\/h2>/);
    assert.match(terms, /<h2>3\. Prices and payment<\/h2>/);
    assert.match(terms, /<h2>4\. Delivery<\/h2>/);
    assert.match(terms, /<h2>5\. Faulty or incorrect items<\/h2>/);
    assert.match(terms, /<h2>6\. Events outside our control<\/h2>/);
    assert.match(terms, /<h2>7\. Your data<\/h2>/);
    assert.doesNotMatch(terms, /About us/);
    assert.doesNotMatch(terms, /Your right to cancel/);
    assert.doesNotMatch(terms, /id="cancellation"/);
    assert.doesNotMatch(terms, /Model cancellation form/);
    assert.doesNotMatch(terms, /Our responsibility to you/);
    assert.doesNotMatch(terms, /Law and disputes/);
    assert.doesNotMatch(terms, /Consumer Contracts Regulations 2013/);
    assert.doesNotMatch(terms, /14 days/);
    assert.doesNotMatch(contact, /terms#cancellation/);
    assert.doesNotMatch(faq, /terms#cancellation/);
    assert.match(privacy, /get in touch via our <a href="\/contact">Contact us<\/a> page/);
    assert.match(contact, /Track order/);
    assert.doesNotMatch(contact, /<strong>Email:<\/strong>/);
    assert.match(faq, /Visit our <a href="\/contact">Contact us<\/a> page/);
    assert.doesNotMatch(faq, /We aim to send orders within/);
    for (const processor of ['Stripe', 'Render', 'GitHub', 'Royal Mail']) assert.match(privacy, new RegExp(processor));
  });

  it('CONTACT_EMAIL, COMPANY_ADDRESS and VAT_NUMBER fill in only when set', () => {
    const html = [
      '<div class="contact-card" data-if="contact-email" hidden><p>Email: <span data-contact-email></span></p></div>',
      '<p data-unless="contact-email">Visit our <a href="/contact">Contact us</a> page.</p>',
      '<p data-if="contact-email" hidden>Email us at <span data-contact-email></span>.</p>',
      '<p>PO-KE-MART-FUN LIMITED.</p>',
      '<p data-if="company-address" hidden>Registered office: <span data-company-address></span></p>',
      '<p data-if="vat-number" hidden>VAT: <span data-vat-number></span></p>',
    ].join('');
    const unset = render(html, {}, null, { contactEmail: '', companyAddress: '', vatNumber: '' });
    assert.match(unset, /Visit our <a href="\/contact">Contact us<\/a> page/);
    assert.doesNotMatch(unset, /Email:/);
    assert.doesNotMatch(unset, /Registered office:/);
    assert.doesNotMatch(unset, /VAT:/);
    assert.doesNotMatch(unset, /data-if=|data-unless=|hidden|to confirm|class="todo"/);
    const out = render(html, {}, null, { contactEmail: 'help@example.com', companyAddress: '1 Example Road, Testville', vatNumber: 'GB000000000' });
    assert.match(out, /<a href="mailto:help@example.com">help@example.com<\/a>/);
    assert.match(out, /Email us at <a href="mailto:help@example.com">help@example.com<\/a>/);
    assert.match(out, /Registered office: 1 Example Road, Testville/);
    assert.match(out, /VAT: GB000000000/);
    assert.doesNotMatch(out, /Visit our/);
    assert.doesNotMatch(out, /to confirm|class="todo"|data-if=|data-unless=|hidden/);
    const escaped = render('<p data-if="company-address" hidden>Registered office: <span data-company-address></span></p>', {}, null, { companyAddress: '<b>x</b>' });
    assert.match(escaped, /Registered office: &lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(escaped, /<b>x<\/b>/);
  });

  it('the public HTML templates themselves have no “to confirm” placeholders', () => {
    const dir = path.join(__dirname, '..', 'public');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'admin.html');
    assert.ok(files.includes('contact.html') && files.length >= 4);
    for (const f of files) {
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(html, /to confirm/i, f);
      assert.doesNotMatch(html, /class="todo"/, f);
      assert.doesNotMatch(html, new RegExp('16870' + '472'), f);
    }
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
