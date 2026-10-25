// Order storage (private GitHub repo, mocked) + admin Sales API + cost price privacy.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-orders-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: 'single', title: 'Single card', price_gbp: 4, stock: 10, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
  { id: 'box', title: 'Booster box', price_gbp: 12, stock: 10, condition: 'New (sealed)', category: 'Sealed products', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.ADMIN_PASSWORD = 'owner-secret';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'owner/shop';
process.env.GITHUB_WRITE_GAP_MS = '0';
delete process.env.ORDERS_GITHUB_REPO;
delete process.env.ORDERS_GITHUB_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_ID;

// ---- mocked GitHub: repos owner/shop (public), owner/orders (private), owner/open (public) ----
const repos = { 'owner/shop': { private: false, files: new Map() }, 'owner/orders': { private: true, files: new Map() }, 'owner/open': { private: false, files: new Map() } };
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
    const kids = new Map();
    for (const f of r.files.keys()) {
      if (!f.startsWith(file + '/')) continue;
      const rest = f.slice(file.length + 1).split('/');
      kids.set(rest[0], { name: rest[0], path: file + '/' + rest[0], type: rest.length > 1 ? 'dir' : 'file' });
    }
    return kids.size ? json([...kids.values()]) : json({ message: 'Not Found' }, 404);
  }
  const body = JSON.parse(opts.body);
  const cur = r.files.get(file);
  if (cur && body.sha !== 'sha-' + cur.v) return json({ message: 'sha mismatch' }, 409);
  commits.push({ repo: m[1], file, message: body.message, sha: body.sha });
  r.files.set(file, { buf: Buffer.from(body.content, 'base64'), v: cur ? cur.v + 1 : 1 });
  return json({ content: { sha: 'x' } }, 201);
};
const readRepo = (repo, file) => JSON.parse(repos[repo].files.get(file).buf.toString('utf8'));

const ordersStore = require('../server/orders-store');
const sales = require('../server/sales');
const ExcelJS = require('exceljs');
const app = require('../server/index');

let server, base, admin;
async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.shopper) headers['x-session-token'] = opts.shopper;
  if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
  const res = await realFetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const m = (res.headers.get('set-cookie') || '').match(/session=([^;]+)/);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers, session: m && decodeURIComponent(m[1]) };
}
const ADDRESS = { name: 'Test Buyer', line1: '1 Test Street', town: 'Testtown', postcode: 'ZZ99 9ZZ', phone: '07700 900000' };
async function buy(productId, qty = 1) {
  const s = (await call('GET', '/api/cart')).session;
  await call('POST', '/api/cart/add', { productId, qty }, { shopper: s });
  return call('POST', '/api/checkout/demo', { email: 'test@example.com', address: ADDRESS }, { shopper: s });
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/admin/login', { password: 'owner-secret' })).data.token;
});
after(() => { server.close(); global.fetch = realFetch; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('without ORDERS_GITHUB_REPO: local file + loud warning', () => {
  it('orders go to the local file only, and admin shows the warning', async () => {
    ordersStore.reset();
    const r = await buy('single');
    assert.equal(r.status, 200);
    assert.ok(JSON.parse(fs.readFileSync(P('orders.json'), 'utf8')).some((o) => o.id === r.data.order.id));
    assert.equal(repos['owner/orders'].files.size, 0);
    assert.ok(![...repos['owner/shop'].files.keys()].some((f) => /orders/.test(f)), 'never in the public shop repo');
    const st = (await call('GET', '/api/admin/orders', null, { admin })).data.storage;
    assert.equal(st.mode, 'local');
    assert.equal(st.safe, false);
    assert.match(st.warning, /^Orders are not being saved safely — set ORDERS_GITHUB_REPO/);
    assert.equal((await call('GET', '/api/admin/status', null, { admin })).data.orders.mode, 'local');
  });
});

describe('with a private orders repo (mocked GitHub)', () => {
  before(() => { process.env.ORDERS_GITHUB_REPO = 'owner/orders'; ordersStore.reset(); fs.rmSync(P('orders.json'), { force: true }); });

  it('each order is committed to orders/YYYY-MM/<id>.json in the private repo with [skip render]', async () => {
    const r = await buy('box');
    const id = r.data.order.id;
    const file = ordersStore.repoPath(r.data.order);
    assert.match(file, new RegExp(`^orders/\\d{4}-\\d{2}/${id}\\.json$`));
    const saved = readRepo('owner/orders', file);
    assert.equal(saved.id, id);
    assert.equal(saved.shipping_address.postcode, 'ZZ99 9ZZ');
    assert.equal(saved.status, 'paid');
    const c = commits.find((x) => x.file === file);
    assert.equal(c.repo, 'owner/orders');
    assert.match(c.message, /^\[skip render\] order /);
    assert.ok(!commits.some((x) => x.repo === 'owner/shop' && /orders|ZZ99/.test(x.file + repos['owner/shop'].files.get(x.file).buf)), 'no order data in the shop repo');
    const st = ordersStore.status();
    assert.deepEqual([st.mode, st.safe, st.warning], ['github', true, null]);
  });

  it('admin: mark as posted needs a tracking number; update rewrites the same file (with sha)', async () => {
    const id = (await buy('single', 2)).data.order.id;
    assert.equal((await call('PATCH', `/api/admin/orders/${id}`, { status: 'posted' })).status, 401);
    assert.equal((await call('PATCH', `/api/admin/orders/${id}`, { status: 'shipped' }, { admin })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/orders/${id}`, { status: 'posted' }, { admin })).status, 400);
    const r = await call('PATCH', `/api/admin/orders/${id}`, { status: 'posted', tracking_number: 'ab 1234 5678 9gb', postage_paid: '2.75' }, { admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.github, true);
    assert.equal(r.data.order.tracking_number, 'AB123456789GB');
    assert.ok(r.data.order.posted_at);
    const file = ordersStore.repoPath(r.data.order);
    const saved = readRepo('owner/orders', file);
    assert.deepEqual([saved.status, saved.tracking_number, saved.postage_paid], ['posted', 'AB123456789GB', 2.75]);
    const writes = commits.filter((x) => x.file === file);
    assert.equal(writes.length, 2);
    assert.ok(writes[1].sha, 'update sent the current sha');
    assert.match(writes[1].message, /^\[skip render\] order .*: posted/);
    assert.equal((await call('PATCH', '/api/admin/orders/nope', { status: 'paid' }, { admin })).status, 404);
  });

  it('startup: orders are loaded back from the private repo after the disk is wiped', async () => {
    const before = ordersStore.all().map((o) => o.id).sort();
    fs.rmSync(P('orders.json'), { force: true });
    ordersStore.reset();
    assert.equal(ordersStore.all().length, 0);
    await ordersStore.pullFromGitHub();
    assert.deepEqual(ordersStore.all().map((o) => o.id).sort(), before);
    assert.equal(ordersStore.all().find((o) => o.status === 'posted').tracking_number, 'AB123456789GB');
  });

  it('refuses a public repo or the shop repo', async () => {
    for (const repo of ['owner/open', 'owner/shop', 'pokemartfun-stack/tcg-shop']) {
      process.env.ORDERS_GITHUB_REPO = repo;
      ordersStore.reset();
      const n = commits.length;
      const r = await buy('single');
      assert.equal(r.status, 200, 'the customer still gets their order');
      assert.equal(commits.slice(n).filter((c) => /^orders\//.test(c.file)).length, 0, `nothing written to ${repo}`);
      const st = ordersStore.status();
      assert.equal(st.safe, false);
      assert.match(st.warning, repo === 'owner/open' ? /PUBLIC/ : /public shop repo/);
    }
    process.env.ORDERS_GITHUB_REPO = 'owner/missing';
    ordersStore.reset();
    await buy('single');
    assert.match(ordersStore.status().warning, /create it \(private\)/);
    process.env.ORDERS_GITHUB_REPO = 'owner/orders';
    ordersStore.reset();
  });

  it('cost prices: saved privately, copied onto orders, never shown to shoppers or put in products.json', async () => {
    let r = await call('PATCH', '/api/admin/products/box', { cost_gbp: 'abc' }, { admin });
    assert.equal(r.status, 400);
    r = await call('PATCH', '/api/admin/products/box', { cost_gbp: '7.5' }, { admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.product.cost_gbp, 7.5);
    assert.ok(!JSON.parse(fs.readFileSync(P('products.json'), 'utf8')).some((p) => 'cost_gbp' in p), 'not in products.json (public repo)');
    assert.equal(readRepo('owner/orders', 'costs.json').box, 7.5);
    assert.equal((await call('GET', '/api/admin/products', null, { admin })).data.find((p) => p.id === 'box').cost_gbp, 7.5);
    const pub = await call('GET', '/api/products');
    assert.ok(!JSON.stringify(pub.data).includes('cost_gbp'));
    assert.ok(!(await call('GET', '/api/products/box')).text.includes('cost_gbp'));
    const o = (await buy('box')).data.order;
    assert.ok(!JSON.stringify(o).includes('cost_gbp'), 'customer response has no cost');
    assert.equal(ordersStore.find(o.id).items[0].cost_gbp, 7.5);
    // add form
    r = await call('POST', '/api/admin/products', { id: 'new-lot', title: 'New lot', price_gbp: 6, stock: 1, category: 'Trading card lots', image: '/images/tauros-ar.svg', cost_gbp: 2 }, { admin });
    assert.equal(r.status, 200);
    assert.equal(ordersStore.getCost('new-lot'), 2);
    // blank removes it
    await call('PATCH', '/api/admin/products/box', { cost_gbp: '' }, { admin });
    assert.equal(ordersStore.getCost('box'), null);
  });

  it('admin Sales API: summary, presets, CSV download, fees setting', async () => {
    assert.equal((await call('GET', '/api/admin/sales/summary')).status, 401);
    let s = (await call('GET', '/api/admin/sales/summary', null, { admin })).data;
    const today = sales.todayUk();
    assert.deepEqual([s.from, s.to], [today.slice(0, 8) + '01', today], 'default range: 1st of this month to today');
    assert.equal(s.totals.orders, 0, 'demo orders hidden by default');
    assert.ok(s.excluded.demo > 0);
    s = (await call('GET', '/api/admin/sales/summary?demo=1', null, { admin })).data;
    assert.ok(s.totals.orders > 0);
    const list = (await call('GET', '/api/admin/orders?demo=1', null, { admin })).data.orders;
    assert.ok(list.length > 1);
    assert.ok(Date.parse(list[0].createdAt) >= Date.parse(list[list.length - 1].createdAt), 'newest first');
    assert.ok(list[0].figures && list[0].uk.date);
    const csv = await call('GET', '/api/admin/sales/csv?demo=1', null, { admin });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename=".*\.csv"/);
    assert.ok(csv.text.replace(/^\uFEFF/, '').startsWith('order_date_uk,'));
    assert.equal((await call('GET', '/api/admin/sales/csv')).status, 401);
    assert.equal((await call('PUT', '/api/admin/settings', { fees: { stripe: { percent: -1 } } }, { admin })).status, 400);
    const f = await call('PUT', '/api/admin/settings', { fees: { paypal: { percent: 3.4 } } }, { admin });
    assert.equal(f.status, 200);
    const fees = (await call('GET', '/api/admin/settings', null, { admin })).data.fees;
    assert.deepEqual(fees, { stripe: { percent: 1.5, fixed: 0.2 }, paypal: { percent: 3.4, fixed: 0.3 } });
  });

  it('admin picks any From/To dates: inclusive UK days, From after To is refused', async () => {
    const today = sales.todayUk();
    let r = await call('GET', `/api/admin/sales/summary?from=${today}&to=${today}&demo=1`, null, { admin });
    assert.equal(r.status, 200);
    assert.ok(r.data.totals.orders > 0, 'orders placed today are included when From = To = today');
    r = await call('GET', '/api/admin/sales/summary?from=2020-01-01&to=2020-01-31&demo=1', null, { admin });
    assert.equal(r.data.totals.orders, 0);
    assert.equal((await call('GET', '/api/admin/orders?from=2020-01-01&to=2020-01-31&demo=1', null, { admin })).data.orders.length, 0);
    for (const url of ['/api/admin/sales/summary', '/api/admin/orders', '/api/admin/sales/csv', '/api/admin/sales/xlsx']) {
      r = await call('GET', `${url}?from=2026-10-20&to=2026-10-01`, null, { admin });
      assert.equal(r.status, 400, url);
      assert.match(r.data.error, /From date \(20\/10\/2026\) must be on or before the To date \(01\/10\/2026\)/);
    }
    assert.equal((await call('GET', '/api/admin/sales/summary?from=2026-02-30&to=2026-03-01', null, { admin })).status, 400);
    const csv = await call('GET', '/api/admin/sales/csv?from=2020-01-01&to=2020-01-31&demo=1', null, { admin });
    assert.equal(csv.text.replace(/^\uFEFF/, '').trim().split('\r\n').length, 1, 'CSV follows the range (header only)');
    assert.match(csv.headers.get('content-disposition'), /po-ke-mart-fun-orders-2020-01-01-to-2020-01-31\.csv/);
  });

  it('Download Excel: admin only, follows the range + demo toggle, real £ numbers and UK dates', async () => {
    const today = sales.todayUk();
    const from = today.slice(0, 8) + '01';
    assert.equal((await call('GET', '/api/admin/sales/xlsx')).status, 401);
    const res = await realFetch(`${base}/api/admin/sales/xlsx?from=${from}&to=${today}&demo=1`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="po-ke-mart-fun-sales-${from}-to-${today}.xlsx"`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Orders']);
    const sum = wb.getWorksheet('Summary');
    const find = (label) => { let row; sum.eachRow((r) => { if (r.getCell(1).value === label) row = r; }); return row; };
    const expected = sales.summarise(ordersStore.all(), { from, to: today, includeDemo: true, fees: (await call('GET', '/api/admin/settings', null, { admin })).data.fees });
    assert.equal(find('Orders').getCell(2).value, expected.totals.orders);
    assert.equal(find('Sales (items)').getCell(2).value, expected.totals.sales);
    assert.equal(typeof find('Profit').getCell(2).value, 'number');
    assert.match(find('Profit').getCell(2).numFmt, /£/);
    assert.ok(find('From (UK)').getCell(2).value instanceof Date);
    assert.equal(find('From (UK)').getCell(2).numFmt, 'dd/mm/yyyy');
    assert.ok(find('Month'), 'per-month table');
    assert.ok(find('Total'));

    const ws = wb.getWorksheet('Orders');
    assert.deepEqual(ws.getRow(1).values.slice(1), sales.CSV_COLUMNS, 'same columns as the CSV');
    assert.equal(ws.getRow(1).font.bold, true);
    assert.equal(ws.views[0].state, 'frozen');
    assert.equal(ws.views[0].ySplit, 1);
    assert.ok(ws.autoFilter);
    const lines = sales.lineRecords(ordersStore.all(), { from, to: today, includeDemo: true });
    assert.equal(ws.rowCount - 1, lines.length, 'one row per order line');
    const col = (k) => sales.CSV_COLUMNS.indexOf(k) + 1;
    const r2 = ws.getRow(2);
    assert.ok(r2.getCell(col('order_date_uk')).value instanceof Date);
    assert.equal(r2.getCell(col('order_date_uk')).numFmt, 'dd/mm/yyyy hh:mm');
    const uk = sales.ukParts(lines[0]._createdAt);
    assert.equal(r2.getCell(col('order_date_uk')).value.toISOString().slice(0, 16), `${uk.date}T${uk.time}`, 'UK wall-clock time');
    assert.equal(typeof r2.getCell(col('order_total_gbp')).value, 'number');
    assert.equal(r2.getCell(col('order_total_gbp')).value, lines[0].order_total_gbp);
    assert.match(r2.getCell(col('line_total_gbp')).numFmt, /£/);
    assert.ok(ws.getColumn(col('item')).width >= 40);
    // demo toggle off -> demo orders left out
    const res2 = await realFetch(`${base}/api/admin/sales/xlsx?from=${from}&to=${today}`, { headers: { Authorization: `Bearer ${admin}` } });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(Buffer.from(await res2.arrayBuffer()));
    assert.equal(wb2.getWorksheet('Orders').rowCount - 1, sales.lineRecords(ordersStore.all(), { from, to: today }).length);
  });
});
