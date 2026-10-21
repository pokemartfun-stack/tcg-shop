// GitHub persistence with a mocked GitHub API (no network).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { makeAnimatedGif } = require('./helpers/make-gif');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-gh-'));
fs.writeFileSync(path.join(tmpDir, 'products.json'), JSON.stringify([{ id: 'c1', title: 'C1', price_gbp: 1, stock: 1, image: '/images/tauros-ar.svg' }]));
process.env.PRODUCTS_FILE = path.join(tmpDir, 'products.json');
process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BANNER_FILE = path.join(tmpDir, 'banner', 'banner.jpg');
process.env.BACKGROUND_FILE = path.join(tmpDir, 'bg', 'background.jpg');
process.env.LOGO_FILE = path.join(tmpDir, 'logo', 'logo.png');
process.env.FAVICON_FILE = path.join(tmpDir, 'logo', 'favicon.png');
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

  it('page background upload: whole image kept, saved locally + committed to public/images/background.jpg, settings updated', async () => {
    const tall = await sharp({ create: { width: 1000, height: 3000, channels: 3, background: '#fc0' } }).png().toBuffer();
    const fd = new FormData();
    fd.append('background', new Blob([tall]), 'pikachu.png');
    assert.equal((await realFetch(base + '/api/admin/settings/background', { method: 'POST', body: fd })).status, 401);
    const fd2 = new FormData();
    fd2.append('background', new Blob([tall]), 'pikachu.png');
    const res = await realFetch(base + '/api/admin/settings/background', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd2 });
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.equal(d.github, true);
    assert.match(d.settings.background_image, /^\/images\/background\.jpg\?v=\d+$/);
    const c = commits.find((x) => x.file === 'public/images/background.jpg');
    assert.ok(c, JSON.stringify(commits));
    assert.match(c.message, /^\[skip render\]/);
    const meta = await sharp(repo.get('public/images/background.jpg')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.height, 2400, 'longest side capped at 2400');
    assert.equal(meta.width, 800, 'not cropped: aspect ratio kept');
    assert.ok(fs.existsSync(process.env.BACKGROUND_FILE));
    assert.equal(JSON.parse(repo.get('data/settings.json').toString()).background_image, d.settings.background_image);
    assert.equal((await (await realFetch(base + '/api/settings')).json()).background_image, d.settings.background_image);
    const img = await realFetch(base + d.settings.background_image);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
  });

  it('background is fetched from GitHub when missing locally (after a restart), then cached', async () => {
    fs.rmSync(process.env.BACKGROUND_FILE);
    const res = await realFetch(base + '/images/background.jpg?v=2');
    assert.equal(res.status, 200);
    assert.ok(fs.existsSync(process.env.BACKGROUND_FILE));
  });

  it('rejects non-images, removes and restores the page background', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fd = new FormData();
    fd.append('background', new Blob(['hello']), 'notes.txt');
    const bad = await realFetch(base + '/api/admin/settings/background', { method: 'POST', headers: auth, body: fd });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /only JPG, PNG, WebP or HEIC/);
    assert.equal((await realFetch(base + '/api/admin/settings/background', { method: 'DELETE' })).status, 401);
    const del = await realFetch(base + '/api/admin/settings/background', { method: 'DELETE', headers: auth });
    assert.equal(del.status, 200);
    assert.equal((await (await realFetch(base + '/api/settings')).json()).background_image, '');
    assert.equal(JSON.parse(repo.get('data/settings.json').toString()).background_image, '');
    const rs = await realFetch(base + '/api/admin/settings/background/restore', { method: 'POST', headers: auth });
    assert.equal(rs.status, 200);
    assert.match((await (await realFetch(base + '/api/settings')).json()).background_image, /^\/images\/background\.jpg\?v=\d+$/);
  });
});

describe('GIF banner / background (kept animated)', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  async function upload(field, buf, name) {
    const fd = new FormData();
    fd.append(field, new Blob([buf]), name);
    const res = await realFetch(`${base}/api/admin/settings/${field}`, { method: 'POST', headers: auth(), body: fd });
    return { status: res.status, d: await res.json() };
  }
  const gifPath = () => process.env.BANNER_FILE.replace(/\.jpg$/, '.gif');

  it('animated banner GIF is stored as banner.gif, multi-frame, committed and served as image/gif', async () => {
    const gif = makeAnimatedGif(600, 80, [1, 2, 3]);
    const { status, d } = await upload('banner', gif, 'party.gif');
    assert.equal(status, 200, JSON.stringify(d));
    assert.equal(d.format, 'gif');
    assert.equal(d.frames, 3);
    assert.equal(d.animated, true);
    assert.match(d.settings.banner_image, /^\/images\/banner\.gif\?v=\d+$/);
    const c = commits.find((x) => x.file === 'public/images/banner.gif');
    assert.ok(c, JSON.stringify(commits.map((x) => x.file)));
    assert.match(c.message, /^\[skip render\]/);
    assert.ok(repo.get('public/images/banner.gif').equals(gif), 'small GIF passed through untouched');
    assert.equal(JSON.parse(repo.get('data/settings.json').toString()).banner_image, d.settings.banner_image);
    const res = await realFetch(base + d.settings.banner_image);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/gif');
    const meta = await sharp(Buffer.from(await res.arrayBuffer()), { animated: true }).metadata();
    assert.equal(meta.format, 'gif');
    assert.equal(meta.pages, 3, 'still animated');
  });

  it('wide animated GIF is resized to 2000px wide and keeps every frame', async () => {
    const { status, d } = await upload('banner', makeAnimatedGif(2600, 40, [1, 2, 3, 1]), 'wide.gif');
    assert.equal(status, 200, JSON.stringify(d));
    const meta = await sharp(repo.get('public/images/banner.gif'), { animated: true }).metadata();
    assert.equal(meta.width, 2000);
    assert.equal(meta.pages, 4);
    assert.ok(meta.delay.every((ms) => ms === 200), 'frame timing kept');
  });

  it('GIF is fetched back from GitHub when missing locally (after a restart)', async () => {
    fs.rmSync(gifPath());
    const res = await realFetch(base + '/images/banner.gif?v=9');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/gif');
    assert.ok(fs.existsSync(gifPath()), 'cached back to disk');
  });

  it('switching GIF -> JPG -> GIF points the setting at the right file each time', async () => {
    const png = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#0a0' } }).png().toBuffer();
    let r = await upload('banner', png, 'flat.png');
    assert.equal(r.status, 200);
    assert.equal(r.d.format, 'jpg');
    assert.match(r.d.settings.banner_image, /^\/images\/banner\.jpg\?v=\d+$/);
    let img = await realFetch(base + r.d.settings.banner_image);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    r = await upload('banner', makeAnimatedGif(200, 50, [2, 3]), 'again.gif');
    assert.match(r.d.settings.banner_image, /^\/images\/banner\.gif\?v=\d+$/);
    assert.equal((await (await realFetch(base + '/api/settings')).json()).banner_image, r.d.settings.banner_image);
  });

  it('rejects GIFs over 8 MB and fake GIFs', async () => {
    const huge = Buffer.concat([makeAnimatedGif(10, 10, [1]), Buffer.alloc(8 * 1024 * 1024)]);
    const big = await upload('banner', huge, 'huge.gif');
    assert.equal(big.status, 400);
    assert.match(big.d.error, /under 8 MB/);
    const fake = await upload('banner', Buffer.from('GIF89a not really'), 'fake.gif');
    assert.equal(fake.status, 400);
  });

  it('page background accepts an animated GIF, and restore brings back the GIF after remove', async () => {
    const { status, d } = await upload('background', makeAnimatedGif(400, 300, [1, 3]), 'bg.gif');
    assert.equal(status, 200, JSON.stringify(d));
    assert.equal(d.frames, 2);
    assert.match(d.settings.background_image, /^\/images\/background\.gif\?v=\d+$/);
    assert.ok(repo.has('public/images/background.gif'));
    assert.equal((await realFetch(base + d.settings.background_image)).headers.get('content-type'), 'image/gif');
    await realFetch(base + '/api/admin/settings/background', { method: 'DELETE', headers: auth() });
    const rs = await (await realFetch(base + '/api/admin/settings/background/restore', { method: 'POST', headers: auth() })).json();
    assert.match(rs.settings.background_image, /^\/images\/background\.gif\?v=\d+$/);
  });
});

describe('shop logo + favicon', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  async function upload(buf, name) {
    const fd = new FormData();
    fd.append('logo', new Blob([buf]), name);
    const res = await realFetch(`${base}/api/admin/settings/logo`, { method: 'POST', headers: auth(), body: fd });
    return { status: res.status, d: await res.json() };
  }

  it('requires admin', async () => {
    const fd = new FormData();
    fd.append('logo', new Blob([Buffer.from('x')]), 'a.png');
    assert.equal((await realFetch(`${base}/api/admin/settings/logo`, { method: 'POST', body: fd })).status, 401);
  });

  it('logo upload: 512px square PNG committed, favicon regenerated + committed, setting updated', async () => {
    const wide = await sharp({ create: { width: 900, height: 500, channels: 3, background: '#ffcb05' } }).jpeg().toBuffer();
    const { status, d } = await upload(wide, 'my-logo.jpg');
    assert.equal(status, 200, JSON.stringify(d));
    assert.equal(d.github, true);
    assert.match(d.settings.logo_image, /^\/images\/logo\.png\?v=\d+$/);
    const logoMeta = await sharp(repo.get('public/images/logo.png')).metadata();
    assert.deepEqual([logoMeta.format, logoMeta.width, logoMeta.height], ['png', 512, 512]);
    const fav = repo.get('public/favicon.png');
    assert.ok(fav, 'favicon committed');
    const favMeta = await sharp(fav).metadata();
    assert.deepEqual([favMeta.format, favMeta.width, favMeta.height, favMeta.hasAlpha], ['png', 64, 64, true]);
    const { data } = await sharp(fav).raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0, 'favicon corner is transparent (round)');
    assert.equal(JSON.parse(repo.get('data/settings.json').toString()).logo_image, d.settings.logo_image);
    const res = await realFetch(base + d.settings.logo_image);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const f = await realFetch(base + '/favicon.png');
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'image/png');
  });

  it('animated GIF logo stays animated (logo.gif)', async () => {
    const { status, d } = await upload(makeAnimatedGif(120, 120, [1, 2, 3]), 'spin.gif');
    assert.equal(status, 200, JSON.stringify(d));
    assert.match(d.settings.logo_image, /^\/images\/logo\.gif\?v=\d+$/);
    assert.equal((await sharp(repo.get('public/images/logo.gif'), { animated: true }).metadata()).pages, 3);
    assert.equal((await realFetch(base + d.settings.logo_image)).headers.get('content-type'), 'image/gif');
  });

  it('rejects non-images; "Use default logo" points back at logo-default.png and resets the favicon', async () => {
    const bad = await upload(Buffer.from('hello'), 'notes.txt');
    assert.equal(bad.status, 400);
    const before = commits.filter((c) => c.file === 'public/favicon.png').length;
    const res = await realFetch(`${base}/api/admin/settings/logo`, { method: 'DELETE', headers: auth() });
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.equal(d.settings.logo_image, '/images/logo-default.png');
    assert.equal(commits.filter((c) => c.file === 'public/favicon.png').length, before + 1);
    const def = await realFetch(base + '/images/logo-default.png');
    assert.equal(def.status, 200);
  });
});
