// Regression: live settings use cache-busting "?v=<timestamp>" URLs. The banner and the page
// background must be in the served HTML itself (not only added later by JavaScript).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { makeAnimatedGif } = require('./helpers/make-gif');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-render-'));
const LIVE = {
  shop_name: 'Po-ke Mart Fun',
  tagline: 'Pokémon TCG singles & lots — fair prices, fast UK postage.',
  banner_image: '/images/banner.gif?v=1792615696500',
  background_image: '/images/background.jpg?v=1792615705908',
  background_last: '/images/background.jpg',
  show_banner_text: false,
  logo_image: '/images/logo.png',
};
fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(LIVE));
fs.writeFileSync(path.join(tmpDir, 'products.json'), '[]');
fs.mkdirSync(path.join(tmpDir, 'banner'));
fs.writeFileSync(path.join(tmpDir, 'banner', 'banner.gif'), makeAnimatedGif(1200, 300, [1, 2]));
process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.PRODUCTS_FILE = path.join(tmpDir, 'products.json');
process.env.BANNER_FILE = path.join(tmpDir, 'banner', 'banner.jpg');
delete process.env.GITHUB_TOKEN;

const app = require('../server/index');
const settingsStore = require('../server/settings-store');
const { render } = require('../server/page-render');
let server, base;
before(async () => {
  settingsStore.reset();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('server-rendered banner + background (settings with ?v= query strings)', () => {
  it('index HTML has the banner <img> with src, real ratio, not hidden, and the background on <html>', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const html = await res.text();
    assert.match(html, /<html lang="en-GB" class="has-page-bg" style="--page-bg-image: url\(&quot;\/images\/background\.jpg\?v=1792615705908&quot;\)">/);
    const img = html.match(/<img class="hero-img" id="hero-img"[^>]*>/)[0];
    assert.match(img, /src="\/images\/banner\.gif\?v=1792615696500"/);
    assert.match(img, /aspect-ratio: 1200 \/ 300/);
    assert.doesNotMatch(img, /\shidden/);
    assert.match(html, /<section class="hero-banner has-image" id="hero-banner"/);
    assert.doesNotMatch(html, /show-text/);
    assert.match(html, /<h1 id="hero-name">Po-ke Mart Fun<\/h1>/, 'accessible h1 kept');
    assert.equal((await fetch(base + '/index.html')).status, 200);
  });

  it('cart / checkout / success get the background + logo too', async () => {
    for (const page of ['/cart.html', '/checkout.html', '/success.html']) {
      const html = await (await fetch(base + page)).text();
      assert.match(html, /class="has-page-bg"/, page);
      assert.match(html, /<img class="brand-logo" src="\/images\/logo\.png"/, page);
    }
  });

  it('render(): no image -> img stays hidden; show_banner_text -> show-text; HTML is escaped', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const none = render(tpl, { ...LIVE, banner_image: '', background_image: '', show_banner_text: true, shop_name: '<b>x</b>' }, null);
    assert.match(none, /<img class="hero-img" id="hero-img" alt="" hidden \/>/);
    assert.match(none, /<section class="hero-banner show-text" id="hero-banner"/);
    assert.doesNotMatch(none, /has-page-bg/);
    assert.match(none, /&lt;b&gt;x&lt;\/b&gt;/);
    const evil = render(tpl, { ...LIVE, banner_image: '/x.gif" onerror="alert(1)' }, null);
    assert.doesNotMatch(evil, /onerror/);
  });

  it('api.js accepts ?v= URLs and adds the page background class + variable', async () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
    const props = {}; const classes = new Set();
    const documentElement = {
      style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } },
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    };
    const sandbox = {
      window: {}, document: { documentElement, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: async () => ({ ok: true, json: async () => LIVE }),
      Intl, encodeURI, JSON, Promise, console,
    };
    vm.runInNewContext(code, sandbox);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(classes.has('has-page-bg'));
    assert.equal(props['--page-bg-image'], 'url("/images/background.jpg?v=1792615705908")');
  });
});
