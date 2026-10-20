// Photo order: the JSON's photo / photos[] order decides the cover, whatever order files arrive in.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-order-'));
const productsFile = path.join(tmpDir, 'products.json');
fs.writeFileSync(productsFile, '[]');
process.env.PRODUCTS_FILE = productsFile;
process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.ADMIN_PASSWORD = 'pw';
delete process.env.GITHUB_TOKEN;

const app = require('../server/index');
const store = require('../server/products-store');

// Realistic long Vinted title (slug > 50 chars) — this is what broke the old name-prefix ordering.
const LONG = 'Pokemon TCG Charizard ex 199/165 Special Illustration Rare 151 Near Mint Pack Fresh';
const listing = (title, names) => ({
  photo: `D:\\Work Stuff\\06 Company\\Vinted\\Export\\images\\${names[0]}`,
  photos: names.map((n) => `D:\\Work Stuff\\06 Company\\Vinted\\Export\\images\\${n}`),
  title, price: '4.99', quality: 'Very good',
  category: 'Hobbies & Collectables > Trading cards', date_added: '2026-10-05 14:32',
});

let server, base, token;
const jpg = {};
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/api/admin/login', { password: 'pw' })).data.token;
  const colours = { front: '#f00', back: '#00f', side: '#0f0', top: '#ff0', a1: '#f0f', a2: '#0ff', a3: '#888' };
  for (const [k, c] of Object.entries(colours)) jpg[k] = await sharp({ create: { width: 40, height: 40, channels: 3, background: c } }).jpeg().toBuffer();
});
after(() => { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function multipart(url, fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  for (const f of files) fd.append(f.field || 'photos', new Blob([f.data]), f.name);
  const res = await fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const card = async (id) => (await (await fetch(base + '/api/products')).json()).find((p) => p.id === id);
const colourOf = async (url) => {
  const { data } = await sharp(fs.readFileSync(path.join(process.env.UPLOADS_DIR, path.basename(url)))).raw().toBuffer({ resolveWithObject: true });
  return [data[0] > 128 ? 1 : 0, data[1] > 128 ? 1 : 0, data[2] > 128 ? 1 : 0].join('');
};
const RED = '100', BLUE = '001', GREEN = '010', YELLOW = '110';

describe('photo order', () => {
  let id;
  it('long title + photos arriving in reverse order across separate batches: JSON order wins', async () => {
    const up = await multipart('/api/admin/upload', { mode: 'merge', photos_follow: '1' }, [
      { field: 'file', name: 'v.json', data: JSON.stringify([listing(LONG, ['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.HEIC', 'IMG_0004.jpg'])]) },
    ]);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    id = up.data.ids[0];
    assert.ok(id.length > 50, id);
    // batch 1: back + top, batch 2: side, batch 3: front (the cover) last
    await multipart('/api/admin/photos/bulk', {}, [{ name: 'IMG_0004.jpg', data: jpg.top }, { name: 'img_0002.JPG', data: jpg.back }]);
    await multipart('/api/admin/photos/bulk', {}, [{ name: 'IMG_0003.jpg', data: jpg.side }]);
    let c = await card(id);
    assert.equal(c.images.length, 3);
    assert.equal(await colourOf(c.images[0]), BLUE); // back is first until the front arrives
    await multipart('/api/admin/photos/bulk', {}, [{ name: 'IMG_0001.jpg', data: jpg.front }]);
    c = await card(id);
    assert.equal(c.images.length, 4, JSON.stringify(c.images));
    assert.deepEqual(await Promise.all(c.images.map(colourOf)), [RED, BLUE, GREEN, YELLOW]);
    assert.equal(c.image, c.images[0]);
    assert.ok(!c.images.some((u) => u.endsWith('.svg')), 'placeholder removed');
  });

  it('re-uploading one photo replaces just that photo, keeps order', async () => {
    await multipart('/api/admin/photos/bulk', {}, [{ name: 'IMG_0002.jpg', data: jpg.side }]);
    const c = await card(id);
    assert.equal(c.images.length, 4);
    assert.deepEqual(await Promise.all(c.images.map(colourOf)), [RED, GREEN, GREEN, YELLOW]);
  });

  it('one-request import with files in "wrong" order puts photo[0] first and drops svg placeholders', async () => {
    // existing card with an svg placeholder, then a Vinted import with photos replaces it
    fs.writeFileSync(productsFile, JSON.stringify([...store.get(), { id: 'short-card', title: 'Short card', price_gbp: 1, stock: 1, image: '/images/tauros-ar.svg' }]));
    store.reset();
    const r = await multipart('/api/admin/upload', { mode: 'merge' }, [
      { field: 'file', name: 'v.json', data: JSON.stringify([listing('Short card', ['b.jpg', 'a.jpg'])]) },
      { name: 'a.jpg', data: jpg.back },
      { name: 'b.jpg', data: jpg.front },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = await card('short-card');
    assert.equal(c.images.length, 2, JSON.stringify(c.images));
    assert.deepEqual(await Promise.all(c.images.map(colourOf)), [RED, BLUE]);
  });

  it('admin can set cover / reorder; "Fix photo order" restores JSON order for all cards', async () => {
    let c = await card(id);
    const reversed = c.images.slice().reverse();
    const p = await call('PATCH', `/api/admin/products/${id}`, { images: reversed });
    assert.equal(p.status, 200);
    c = await card(id);
    assert.equal(c.image, reversed[0]);
    // simulate legacy data: shuffled images, no photo_map, files named the old way
    const list = store.get().map((x) => x.id === 'short-card' ? { ...x, photo_map: undefined, images: x.images.slice().reverse(), image: x.images[1] } : x);
    await store.save(list, 'test');
    const fix = await call('POST', '/api/admin/photos/fix-order');
    assert.equal(fix.status, 200, JSON.stringify(fix.data));
    assert.ok(fix.data.changed >= 1);
    c = await card(id);
    assert.deepEqual(await Promise.all(c.images.map(colourOf)), [RED, GREEN, GREEN, YELLOW]);
    const s = await card('short-card');
    assert.deepEqual(await Promise.all(s.images.map(colourOf)), [RED, BLUE]);
    assert.equal((await fetch(base + '/api/admin/photos/fix-order', { method: 'POST' })).status, 401);
  });
});

describe('orderImages (unit)', () => {
  const { orderImages } = require('../server/photo-order');
  it('re-sorts cards saved with the old file naming and drops svg placeholders', () => {
    const p = {
      id: 'pikachu-151', photo_files: ['img_0001', 'img_0002', 'img_0003'],
      images: ['/images/lot-bulk-commons.svg', '/uploads/pikachu-151-img-0003-aaaaaaaaaa.jpg', '/uploads/pikachu-151-img-0002-bbbbbbbbbb.jpg', '/uploads/pikachu-151-img-0001-cccccccccc.jpg', 'https://example.com/extra.jpg'],
    };
    const r = orderImages(p);
    assert.deepEqual(r.product.images, [
      '/uploads/pikachu-151-img-0001-cccccccccc.jpg',
      '/uploads/pikachu-151-img-0002-bbbbbbbbbb.jpg',
      '/uploads/pikachu-151-img-0003-aaaaaaaaaa.jpg',
      'https://example.com/extra.jpg',
    ]);
    assert.equal(r.product.image, r.product.images[0]);
    assert.equal(r.changed, true);
    assert.equal(r.unresolved, 0);
    assert.equal(orderImages(r.product).changed, false);
  });
  it('reports photos it cannot place (old truncated names)', () => {
    const id = 'pokemon-tcg-charizard-ex-199-165-special-illustration-rare';
    const r = orderImages({ id, photo_files: ['img_0001', 'img_0002'], images: [`/uploads/${id.slice(0, 50)}-1111111111.jpg`, `/uploads/${id.slice(0, 50)}-2222222222.jpg`] });
    assert.equal(r.unresolved, 2);
  });
});
