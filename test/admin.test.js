const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `products-${process.pid}.json`);
fs.copyFileSync(path.join(__dirname, '..', 'data', 'products.json'), tmp);
process.env.PRODUCTS_FILE = tmp;
delete process.env.GITHUB_TOKEN;

const app = require('../server/index');
const store = require('../server/products-store');

let server, base;
before(async () => {
  store.reset();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { force: true }); });

async function call(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

describe('admin auth', () => {
  it('rejects login when ADMIN_PASSWORD unset', async () => {
    delete process.env.ADMIN_PASSWORD;
    const r = await call('POST', '/api/admin/login', { password: 'x' });
    assert.equal(r.status, 503);
  });
  it('rejects wrong password and unauthenticated access', async () => {
    process.env.ADMIN_PASSWORD = 'owner-secret';
    assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
    assert.equal((await call('GET', '/api/admin/products')).status, 401);
    assert.equal((await call('DELETE', '/api/admin/products/tauros-ar', null, 'fake')).status, 401);
  });
});

describe('admin product management', () => {
  let token;
  before(async () => {
    process.env.ADMIN_PASSWORD = 'owner-secret';
    const r = await call('POST', '/api/admin/login', { password: 'owner-secret' });
    assert.equal(r.status, 200);
    token = r.data.token;
  });

  it('adds, edits and removes a card (visible on the shop instantly)', async () => {
    const add = await call('POST', '/api/admin/products', {
      id: 'test-card', title: 'Test Card', price_gbp: 1.5, stock: 2, image: 'https://example.com/a.jpg',
    }, token);
    assert.equal(add.status, 200);
    assert.equal((await call('POST', '/api/admin/products', { id: 'test-card', title: 'x', price_gbp: 1 }, token)).status, 409);
    let pub = await call('GET', '/api/products/test-card');
    assert.equal(pub.data.title, 'Test Card');

    const ed = await call('PATCH', '/api/admin/products/test-card', { stock: 7, price_gbp: 2.25 }, token);
    assert.equal(ed.data.product.stock, 7);
    assert.equal(ed.data.product.price_gbp, 2.25);
    assert.equal(JSON.parse(fs.readFileSync(tmp, 'utf8')).find((p) => p.id === 'test-card').stock, 7);

    assert.equal((await call('DELETE', '/api/admin/products/test-card', null, token)).status, 200);
    pub = await call('GET', '/api/products/test-card');
    assert.equal(pub.status, 404);
  });

  it('rejects invalid cards', async () => {
    const r = await call('POST', '/api/admin/products', { id: 'bad', title: 'Bad', price_gbp: -1 }, token);
    assert.equal(r.status, 400);
  });

  it('uploads JSON with merge and replace', async () => {
    const before = (await call('GET', '/api/products')).data.length;
    const merge = await call('POST', '/api/admin/upload', {
      mode: 'merge',
      products: [
        { id: 'tauros-ar', title: 'Tauros updated', price_gbp: 9, stock: 1, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
        { id: 'new-one', title: 'New', price_gbp: 1, stock: 1 },
      ],
    }, token);
    assert.equal(merge.status, 200);
    assert.equal(merge.data.added, 1);
    assert.equal(merge.data.updated, 1);
    assert.equal(merge.data.total, before + 1);

    const bad = await call('POST', '/api/admin/upload', { mode: 'merge', products: { not: 'array' } }, token);
    assert.equal(bad.status, 400);
    const dup = await call('POST', '/api/admin/upload', { mode: 'replace', products: [{ id: 'a', title: 'A', price_gbp: 1 }, { id: 'a', title: 'A', price_gbp: 1 }] }, token);
    assert.equal(dup.status, 400);

    const rep = await call('POST', '/api/admin/upload', { mode: 'replace', products: [{ id: 'only', title: 'Only', price_gbp: 3, stock: 1 }] }, token);
    assert.equal(rep.data.total, 1);
    assert.deepEqual((await call('GET', '/api/products')).data.map((p) => p.id), ['only']);
  });
});
