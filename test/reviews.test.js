// Customer reviews: public API, spam limits, admin approve/hide/feature/delete, on/off switch,
// storage in the private orders repo (mocked GitHub) with a local-file fallback.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-reviews-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'single', title: 'Single card', price_gbp: 4, stock: 10, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.REVIEWS_FILE = P('reviews.json');
process.env.ADMIN_PASSWORD = 'owner-secret';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'owner/shop';
process.env.GITHUB_WRITE_GAP_MS = '0';
delete process.env.ORDERS_GITHUB_REPO;
delete process.env.ORDERS_GITHUB_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_ID;

// ---- mocked GitHub: owner/shop (public), owner/orders (private) ----
const repos = { 'owner/shop': { private: false, files: new Map() }, 'owner/orders': { private: true, files: new Map() } };
const commits = [];
const realFetch = global.fetch;
const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const info = u.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)$/);
  if (info) return repos[info[1]] ? json({ full_name: info[1], private: repos[info[1]].private }) : json({ message: 'Not Found' }, 404);
  const m = u.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/contents\/([^?]*)/);
  if (!m) return realFetch(url, opts);
  const r = repos[m[1]];
  if (!r) return json({ message: 'Not Found' }, 404);
  const file = decodeURIComponent(m[2]);
  if ((opts.method || 'GET') === 'GET') {
    return r.files.has(file)
      ? json({ type: 'file', path: file, sha: 'sha-' + r.files.get(file).v, content: r.files.get(file).buf.toString('base64') })
      : json({ message: 'Not Found' }, 404);
  }
  const body = JSON.parse(opts.body);
  const cur = r.files.get(file);
  if (cur && body.sha !== 'sha-' + cur.v) return json({ message: 'sha mismatch' }, 409);
  commits.push({ repo: m[1], file, message: body.message });
  r.files.set(file, { buf: Buffer.from(body.content, 'base64'), v: cur ? cur.v + 1 : 1 });
  return json({ content: { sha: 'x' } }, 201);
};
const readRepo = (repo, file) => JSON.parse(repos[repo].files.get(file).buf.toString('utf8'));

const reviews = require('../server/reviews');
const ordersStore = require('../server/orders-store');
const app = require('../server/index');

let server, base, admin, ipN = 0;
const nextIp = () => `203.0.113.${++ipN}`;
async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': opts.ip || nextIp() };
  if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
  const res = await realFetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}
const GOOD = { name: 'Ash K', rating: 5, comment: 'Cards arrived well packed and quickly. Thanks!' };
const post = (b, opts) => call('POST', '/api/reviews', { ...GOOD, ...b }, opts);
const setOn = (on) => call('PUT', '/api/admin/reviews/settings', { enabled: on }, { admin });
const list = async () => (await call('GET', '/api/admin/reviews', null, { admin })).data;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/admin/login', { password: 'owner-secret' })).data.token;
});
after(() => { server.close(); global.fetch = realFetch; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('reviews: off by default, local file fallback', () => {
  before(() => { ordersStore.reset(); reviews.reset(); });

  it('section is off until the owner switches it on; submissions are refused while off', async () => {
    const g = await call('GET', '/api/reviews');
    assert.equal(g.status, 200);
    assert.deepEqual([g.data.enabled, g.data.count, g.data.reviews], [false, 0, []]);
    const p = await post({});
    assert.equal(p.status, 403);
    assert.equal((await list()).reviews.length, 0);
  });

  it('admin review routes need the admin login', async () => {
    assert.equal((await call('GET', '/api/admin/reviews')).status, 401);
    assert.equal((await call('PUT', '/api/admin/reviews/settings', { enabled: true })).status, 401);
    assert.equal((await call('DELETE', '/api/admin/reviews/rv_0123456789abcdef')).status, 401);
  });

  it('without ORDERS_GITHUB_REPO everything is saved to the local reviews file only', async () => {
    const r = await setOn(true);
    assert.equal(r.status, 200);
    assert.equal(r.data.enabled, true);
    assert.equal((await post({ name: 'Local Larry' })).status, 200);
    const local = JSON.parse(fs.readFileSync(P('reviews.json'), 'utf8'));
    assert.equal(local.enabled, true);
    assert.equal(local.reviews[0].name, 'Local Larry');
    assert.equal(repos['owner/orders'].files.size, 0);
    assert.ok(!repos['owner/shop'].files.has('reviews.json') && !commits.some((c) => /review/.test(c.file)), 'never in the public shop repo');
    assert.equal((await setOn('yes')).status, 400);
  });
});

describe('reviews with the private orders repo (mocked GitHub)', () => {
  before(() => {
    process.env.ORDERS_GITHUB_REPO = 'owner/orders';
    ordersStore.reset(); reviews.reset();
    fs.rmSync(P('reviews.json'), { force: true });
  });

  it('switching on commits reviews.json to the private repo with [skip render]', async () => {
    const r = await setOn(true);
    assert.equal(r.data.github, true);
    assert.equal(readRepo('owner/orders', 'reviews.json').enabled, true);
    const c = commits.filter((x) => x.file === 'reviews.json').pop();
    assert.equal(c.repo, 'owner/orders');
    assert.match(c.message, /^\[skip render\] reviews section on$/);
    assert.equal((await call('GET', '/api/reviews')).data.enabled, true);
  });

  it('a new review is pending: saved privately, not shown on the shop', async () => {
    const r = await post({ order: '#ABC-123' });
    assert.deepEqual([r.status, r.data], [200, { ok: true, pending: true }]);
    const saved = readRepo('owner/orders', 'reviews.json').reviews;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'pending');
    assert.equal(saved[0].order, 'ABC-123');
    assert.equal(saved[0].verified, false);
    assert.ok(!('ip' in saved[0]) && !JSON.stringify(saved[0]).includes('203.0.113'), 'no IP address stored');
    const pub = (await call('GET', '/api/reviews')).data;
    assert.deepEqual([pub.count, pub.reviews.length, pub.average], [0, 0, null]);
    const a = await list();
    assert.equal(a.counts.pending, 1);
    assert.equal(a.storage.mode, 'github');
  });

  it('validates name, stars, comment and order number', async () => {
    const cases = [
      [{ name: '' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'],
      [{ rating: 0 }, 'rating'], [{ rating: 6 }, 'rating'], [{ rating: 4.5 }, 'rating'], [{ rating: 'five' }, 'rating'],
      [{ comment: 'short' }, 'comment'], [{ comment: 'y'.repeat(1001) }, 'comment'],
      [{ comment: 'Great shop, see https://spam.example for cheap cards' }, 'comment'],
      [{ order: 'abc 123; drop' }, 'order'], [{ order: 'a'.repeat(61) }, 'order'],
    ];
    for (const [b, field] of cases) {
      const r = await post(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.data.field, field, JSON.stringify(b));
    }
    assert.equal((await call('POST', '/api/reviews', [1, 2])).status, 400);
  });

  it('keeps text as plain text: HTML is stored as typed (escaped by the pages), control characters removed', async () => {
    const v = reviews.validate({ name: '  <b>Misty</b>\u0000 ', rating: 4, comment: '<script>alert(1)</script> lovely\u202E cards\n\n\n\nthanks' });
    assert.equal(v.review.name, '<b>Misty</b>');
    assert.equal(v.review.comment, '<script>alert(1)</script> lovely cards\n\nthanks');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reviews.js'), 'utf8');
    assert.ok(!/innerHTML/.test(js), 'shop page never uses innerHTML for reviews');
    const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-reviews.js'), 'utf8');
    for (const f of ['r.name', 'r.comment', 'r.order']) assert.ok(adminJs.includes(`esc(${f})`), `admin escapes ${f}`);
  });

  it('honeypot: bots that fill the hidden box get "ok" but nothing is saved', async () => {
    const before = (await list()).reviews.length;
    const r = await post({ website: 'http://bot.example' });
    assert.deepEqual([r.status, r.data.ok], [200, true]);
    assert.equal((await list()).reviews.length, before);
  });

  it('rate limit: 3 reviews per visitor per 10 minutes, then 429', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 3; i++) assert.equal((await post({ name: `Rate ${i}` }, { ip })).status, 200);
    const r = await post({ name: 'Rate 4' }, { ip });
    assert.equal(r.status, 429);
    assert.equal((await post({ name: 'Other visitor' })).status, 200, 'other visitors are not blocked');
  });

  it('show / feature / hide / delete, with average, count and star breakdown', async () => {
    const all = (await list()).reviews;
    const [a, b, c] = all;
    await call('PATCH', `/api/admin/reviews/${a.id}`, { status: 'approved' }, { admin });
    await call('PATCH', `/api/admin/reviews/${b.id}`, { status: 'approved' }, { admin });
    let pub = (await call('GET', '/api/reviews')).data;
    assert.equal(pub.count, 2);
    assert.equal(pub.average, 5);
    assert.equal(pub.breakdown[5], 2);
    assert.ok(pub.reviews.every((r) => !('order' in r) && !('status' in r)), 'no order numbers or internal fields on the shop');
    // feature a pending review: it is shown and pinned to the top
    const f = await call('PATCH', `/api/admin/reviews/${c.id}`, { featured: true }, { admin });
    assert.equal(f.status, 200);
    assert.deepEqual([f.data.review.status, f.data.review.featured], ['approved', true]);
    pub = (await call('GET', '/api/reviews')).data;
    assert.equal(pub.reviews[0].id, c.id);
    assert.equal(pub.reviews[0].featured, true);
    assert.equal((await list()).counts.featured, 1);
    // hide
    await call('PATCH', `/api/admin/reviews/${a.id}`, { status: 'hidden' }, { admin });
    pub = (await call('GET', '/api/reviews')).data;
    assert.ok(!pub.reviews.some((r) => r.id === a.id));
    assert.equal(pub.count, 2);
    // bad input
    assert.equal((await call('PATCH', `/api/admin/reviews/${a.id}`, { status: 'published' }, { admin })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/reviews/${a.id}`, { featured: 'yes' }, { admin })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/reviews/${a.id}`, {}, { admin })).status, 400);
    assert.equal((await call('PATCH', '/api/admin/reviews/rv_ffffffffffffffff', { status: 'hidden' }, { admin })).status, 404);
    // delete
    const d = await call('DELETE', `/api/admin/reviews/${b.id}`, null, { admin });
    assert.equal(d.status, 200);
    assert.ok(!readRepo('owner/orders', 'reviews.json').reviews.some((r) => r.id === b.id));
    assert.equal((await call('DELETE', `/api/admin/reviews/${b.id}`, null, { admin })).status, 404);
  });

  it('"Verified purchase" when the order number matches a real (non-demo) order', async () => {
    await ordersStore.add({ id: 'cs_test_real1', status: 'paid', demo: false, method: 'stripe', items: [], subtotal: 4, createdAt: new Date().toISOString() });
    await ordersStore.add({ id: 'demo_abc', status: 'paid', demo: true, method: 'demo', items: [], subtotal: 4, createdAt: new Date().toISOString() });
    await post({ name: 'Real Buyer', order: 'cs_test_real1' });
    await post({ name: 'Demo Buyer', order: 'demo_abc' });
    const rs = (await list()).reviews;
    assert.equal(rs.find((r) => r.name === 'Real Buyer').verified, true);
    assert.equal(rs.find((r) => r.name === 'Demo Buyer').verified, false);
  });

  it('switching off hides everything on the shop (even shown reviews) and refuses new ones', async () => {
    await setOn(false);
    const pub = (await call('GET', '/api/reviews')).data;
    assert.deepEqual([pub.enabled, pub.count, pub.reviews.length], [false, 0, 0]);
    assert.equal((await post({})).status, 403);
    assert.ok((await list()).reviews.length > 0, 'reviews are kept, just not shown');
    await setOn(true);
    assert.ok((await call('GET', '/api/reviews')).data.count > 0);
  });

  it('after a restart (empty disk) reviews and the on/off switch are loaded back from the private repo', async () => {
    const want = readRepo('owner/orders', 'reviews.json');
    fs.rmSync(P('reviews.json'), { force: true });
    reviews.reset(); ordersStore.reset();
    assert.equal(reviews.data().reviews.length, 0);
    assert.equal(await reviews.pullFromGitHub(), true);
    assert.equal(reviews.data().enabled, want.enabled);
    assert.deepEqual(reviews.data().reviews.map((r) => r.id), want.reviews.map((r) => r.id));
    assert.ok(fs.existsSync(P('reviews.json')), 'local copy rewritten');
  });

  it('a failed repo save is retried by "Retry saving now"', async () => {
    const id = (await list()).reviews[0].id;
    const realGet = global.fetch;
    let failPut = true;
    global.fetch = async (url, opts = {}) => {
      if (failPut && opts.method === 'PUT' && String(url).endsWith('/reviews.json')) return json({ message: 'boom' }, 500);
      return realGet(url, opts);
    };
    const r = await call('PATCH', `/api/admin/reviews/${id}`, { status: 'hidden' }, { admin });
    assert.equal(r.data.github, false);
    assert.ok(ordersStore.status().pending >= 1);
    failPut = false;
    const retry = await call('POST', '/api/admin/orders/retry-sync', null, { admin });
    global.fetch = realGet;
    assert.equal(retry.data.pending, 0);
    assert.equal(readRepo('owner/orders', 'reviews.json').reviews.find((x) => x.id === id).status, 'hidden');
  });
});

describe('reviews on the pages', () => {
  it('shop page has the reviews section (hidden until switched on), star picker and honeypot', async () => {
    const html = (await call('GET', '/')).text;
    assert.match(html, /<section class="reviews" id="reviews"[^>]* hidden>/);
    for (let i = 1; i <= 5; i++) assert.match(html, new RegExp(`name="rating" id="star${i}" value="${i}"`));
    assert.match(html, /class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1"/);
    assert.match(html, /<script src="\/js\/reviews\.js"><\/script>/);
    assert.ok(html.indexOf('id="product-grid"') < html.indexOf('id="reviews"'), 'reviews sit below the products');
  });

  it('admin page has the on/off switch and the review list', async () => {
    const html = (await call('GET', '/admin')).text;
    assert.match(html, /id="reviews-section"/);
    assert.match(html, /type="checkbox" id="rv-enabled"/);
    assert.match(html, /href="#reviews-section">Reviews</);
    assert.match(html, /<script src="\/js\/admin-reviews\.js"><\/script>/);
  });
});
