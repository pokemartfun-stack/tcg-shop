// GitHub persistence with a mocked GitHub API (no network).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-gh-'));
fs.writeFileSync(path.join(tmpDir, 'products.json'), JSON.stringify([{ id: 'c1', title: 'C1', price_gbp: 1, stock: 1, image: '/images/tauros-ar.svg' }]));
process.env.PRODUCTS_FILE = path.join(tmpDir, 'products.json');
process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BANNER_FILE = path.join(tmpDir, 'banner', 'banner.jpg');
process.env.ADMIN_PASSWORD = 'pw';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'owner/repo';
process.env.GITHUB_WRITE_GAP_MS = '0';

const repo = new Map(); // path -> Buffer
const commits = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/^https:\/\/api\.github\.com\/repos\/owner\/repo\/contents\/([^?]+)/);
  if (!m) return realFetch(url, opts);
  const file = decodeURIComponent(m[1]);
  const method = opts.method || 'GET';
  if (method === 'GET') {
    if (!repo.has(file)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (/raw/.test((opts.headers || {}).Accept || '')) return new Response(repo.get(file));
    return new Response(JSON.stringify({ sha: 'sha-' + file, content: repo.get(file).toString('base64') }));
  }
  const body = JSON.parse(opts.body);
  commits.push({ file, message: body.message, sha: body.sha });
  repo.set(file, Buffer.from(body.content, 'base64'));
  return new Response(JSON.stringify({ content: { sha: 'new' } }), { status: 201 });
};

const app = require('../server/index');
let server, base, token;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await realFetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })).json()).token;
});
after(() => { server.close(); global.fetch = realFetch; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('GitHub persistence (mocked)', () => {
  it('commits photos to public/uploads and products.json with [skip render]', async () => {
    const jpg = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#00f' } }).jpeg().toBuffer();
    const fd = new FormData();
    fd.append('photos', new Blob([jpg]), 'front.jpg');
    const res = await realFetch(base + '/api/admin/products/c1/images', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.equal(d.github, true);
    const photoCommit = commits.find((c) => c.file.startsWith('public/uploads/c1-front-'));
    assert.ok(photoCommit, JSON.stringify(commits));
    assert.match(photoCommit.message, /^\[skip render\]/);
    const prodCommit = commits.find((c) => c.file === 'data/products.json');
    assert.match(prodCommit.message, /^\[skip render\]/);
    const saved = JSON.parse(repo.get('data/products.json').toString());
    assert.equal(saved[0].images[1], d.product.images[1]);
  });

  it('serves a photo from GitHub when it is missing on local disk (after a restart)', async () => {
    const file = [...repo.keys()].find((k) => k.startsWith('public/uploads/'));
    const local = path.join(process.env.UPLOADS_DIR, path.basename(file));
    fs.rmSync(local);
    const res = await realFetch(`${base}/uploads/${path.basename(file)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.ok(fs.existsSync(local), 'cached back to disk');
    assert.equal((await realFetch(`${base}/uploads/nope-0000000000.jpg`)).status, 404);
  });

  it('banner upload: resized, saved locally + committed to public/images/banner.jpg, settings updated', async () => {
    const big = await sharp({ create: { width: 3200, height: 1000, channels: 3, background: '#e53935' } }).png().toBuffer();
    const fd = new FormData();
    fd.append('banner', new Blob([big]), 'my-banner.png');
    assert.equal((await realFetch(base + '/api/admin/settings/banner', { method: 'POST', body: fd })).status, 401);
    const fd2 = new FormData();
    fd2.append('banner', new Blob([big]), 'my-banner.png');
    const res = await realFetch(base + '/api/admin/settings/banner', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd2 });
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.match(d.settings.banner_image, /^\/images\/banner\.jpg\?v=\d+$/);
    assert.equal(d.github, true);
    const c = commits.find((x) => x.file === 'public/images/banner.jpg');
    assert.ok(c);
    assert.match(c.message, /^\[skip render\]/);
    const meta = await sharp(repo.get('public/images/banner.jpg')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 2000);
    assert.ok(fs.existsSync(process.env.BANNER_FILE));
    assert.equal(JSON.parse(repo.get('data/settings.json').toString()).banner_image, d.settings.banner_image);
    assert.equal((await (await realFetch(base + '/api/settings')).json()).banner_image, d.settings.banner_image);
  });

  it('banner is fetched from GitHub when missing locally (after a restart), then cached', async () => {
    fs.rmSync(process.env.BANNER_FILE);
    const res = await realFetch(base + '/images/banner.jpg?v=1');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.ok(fs.existsSync(process.env.BANNER_FILE));
  });

  it('rejects non-images and removes the banner image', async () => {
    const fd = new FormData();
    fd.append('banner', new Blob(['hello']), 'notes.txt');
    const bad = await realFetch(base + '/api/admin/settings/banner', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /only JPG, PNG, WebP or HEIC/);
    const del = await realFetch(base + '/api/admin/settings/banner', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(del.status, 200);
    assert.equal((await (await realFetch(base + '/api/settings')).json()).banner_image, '');
  });
});
