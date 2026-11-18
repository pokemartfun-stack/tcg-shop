// Customer accounts saved in the private orders repo (mocked GitHub), and the admin Customers list.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-users-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'single', title: 'Single card', price_gbp: 4, stock: 10, condition: 'Near mint', category: 'Trading cards', image: '/uploads/single.jpg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.SECURITY_FILE = P('security.json');
process.env.REVIEWS_FILE = P('reviews.json');
process.env.USERS_FILE = P('users.json');
process.env.ADMIN_PASSWORD = 'owner-secret';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'owner/shop';
process.env.GITHUB_WRITE_GAP_MS = '0';
process.env.ORDERS_GITHUB_REPO = 'owner/orders';
delete process.env.ORDERS_GITHUB_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.ADMIN_2FA_RESET;

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
  const method = opts.method || 'GET';
  if (method === 'GET') {
    if (r.files.has(file)) return json({ type: 'file', path: file, sha: 'sha-' + r.files.get(file).v, content: r.files.get(file).buf.toString('base64') });
    return json({ message: 'Not Found' }, 404);
  }
  const body = JSON.parse(opts.body);
  const cur = r.files.get(file);
  if (cur && body.sha !== 'sha-' + cur.v) return json({ message: 'sha mismatch' }, 409);
  commits.push({ repo: m[1], file, message: body.message });
  r.files.set(file, { buf: Buffer.from(body.content, 'base64'), v: cur ? cur.v + 1 : 1 });
  return json({ content: { sha: 'x' } }, 201);
};
const readRepo = (repo, file) => JSON.parse(repos[repo].files.get(file).buf.toString('utf8'));

const auth = require('../server/auth');
const ordersStore = require('../server/orders-store');
const app = require('../server/index');

let server, base, admin;
async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
  const res = await realFetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/admin/login', { password: 'owner-secret' })).data.token;
  assert.ok(admin, 'admin token');
});
after(() => { server.close(); global.fetch = realFetch; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('customer accounts in the private orders repo', () => {
  it('a new account is committed to users.json in the private repo with [skip render], never to the shop repo', async () => {
    const r = await call('POST', '/api/auth/register', { email: 'Ash@Example.com', password: 'pikachu-123', name: 'Ash' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.email, 'ash@example.com');
    assert.equal(r.data.user.passwordHash, undefined);
    const saved = readRepo('owner/orders', 'users.json');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].email, 'ash@example.com');
    assert.match(saved[0].passwordHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'scrypt salt:hash');
    assert.ok(!saved[0].passwordHash.includes('pikachu-123'));
    assert.ok(commits.some((c) => c.repo === 'owner/orders' && c.file === 'users.json' && c.message.startsWith('[skip render]')));
    assert.ok(!commits.some((c) => c.repo === 'owner/shop'), 'nothing goes to the public shop repo');
  });

  it('concurrent sign-ups are all kept', async () => {
    const emails = ['misty@example.com', 'brock@example.com', 'may@example.com', 'dawn@example.com'];
    const rs = await Promise.all(emails.map((e, i) => call('POST', '/api/auth/register', { email: e, password: 'password-' + i, name: e.split('@')[0] })));
    rs.forEach((r) => assert.equal(r.status, 200));
    await auth.whenSaved();
    const saved = readRepo('owner/orders', 'users.json').map((u) => u.email);
    for (const e of ['ash@example.com', ...emails]) assert.ok(saved.includes(e), e);
  });

  it('accounts survive a restart that wipes the disk (loaded back from the repo)', async () => {
    fs.rmSync(P('users.json'), { force: true });
    auth.reset();
    assert.equal(auth.login('ash@example.com', 'pikachu-123').ok, false, 'gone from memory and disk');
    assert.equal(await auth.pullFromGitHub(), true);
    assert.equal(auth.login('ASH@example.com', 'pikachu-123').ok, true);
    assert.equal(auth.login('ash@example.com', 'wrong-password').ok, false);
    assert.ok(fs.existsSync(P('users.json')), 'local cache rewritten');
  });

  it('accounts created while the repo was unreachable are kept and pushed on the next start', async () => {
    auth.register('offline@example.com', 'password-off', 'Offline');
    await auth.whenSaved();
    // simulate: the repo copy doesn't have the new user yet
    const repoUsers = readRepo('owner/orders', 'users.json').filter((u) => u.email !== 'offline@example.com');
    repos['owner/orders'].files.set('users.json', { buf: Buffer.from(JSON.stringify(repoUsers)), v: 99 });
    assert.equal(await auth.pullFromGitHub(), true);
    await auth.whenSaved();
    assert.ok(readRepo('owner/orders', 'users.json').some((u) => u.email === 'offline@example.com'));
  });

  it('without a private repo, accounts stay in the local file (demo mode)', async () => {
    const saved = process.env.ORDERS_GITHUB_REPO;
    delete process.env.ORDERS_GITHUB_REPO;
    try {
      const n = commits.length;
      assert.equal(auth.register('local@example.com', 'password-loc', 'Local').ok, true);
      assert.deepEqual(await auth.whenSaved(), { github: false });
      assert.equal(commits.length, n);
      assert.ok(JSON.parse(fs.readFileSync(P('users.json'), 'utf8')).some((u) => u.email === 'local@example.com'));
    } finally {
      process.env.ORDERS_GITHUB_REPO = saved;
    }
  });
});

describe('admin Customers list', () => {
  it('needs the admin login', async () => {
    const r = await call('GET', '/api/admin/customers');
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.text, /@example\.com/);
  });

  it('returns only id, name, email, createdAt and orderCount, newest first, never password hashes', async () => {
    await ordersStore.add({ id: 'o1', email: 'ASH@example.com', createdAt: '2026-11-01T10:00:00Z', items: [], subtotal: 4, status: 'paid' });
    await ordersStore.add({ id: 'o2', email: 'ash@EXAMPLE.com ', createdAt: '2026-11-02T10:00:00Z', items: [], subtotal: 4, status: 'paid' });
    await ordersStore.add({ id: 'o3', email: 'misty@example.com', createdAt: '2026-11-03T10:00:00Z', items: [], subtotal: 4, status: 'paid' });
    const r = await call('GET', '/api/admin/customers', null, { admin });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /passwordHash|password/i);
    const list = r.data.customers;
    assert.ok(list.length >= 6);
    for (const c of list) assert.deepEqual(Object.keys(c).sort(), ['createdAt', 'email', 'id', 'name', 'orderCount']);
    const byEmail = Object.fromEntries(list.map((c) => [c.email, c]));
    assert.equal(byEmail['ash@example.com'].orderCount, 2);
    assert.equal(byEmail['misty@example.com'].orderCount, 1);
    assert.equal(byEmail['brock@example.com'].orderCount, 0);
    const times = list.map((c) => Date.parse(c.createdAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  });
});
