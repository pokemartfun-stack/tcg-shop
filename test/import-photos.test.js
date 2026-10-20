const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-import-'));
const productsFile = path.join(tmpDir, 'products.json');
fs.writeFileSync(productsFile, JSON.stringify([
  { id: 'keep-me', title: 'Keep me', price_gbp: 1, stock: 1, image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = productsFile;
process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.ADMIN_PASSWORD = 'owner-secret';
delete process.env.GITHUB_TOKEN;

const app = require('../server/index');
const importer = require('../server/importer');

const vinted = (over = {}) => ({
  photo: 'D:\\Work Stuff\\06 Company\\Vinted\\Export\\images\\IMG_001.jpg',
  photos: [
    'D:\\Work Stuff\\06 Company\\Vinted\\Export\\images\\IMG_001.jpg',
    'images/img_002.png',
    'images/Back_Photo.HEIC',
  ],
  title: 'Charizard ex 199/165',
  description: 'Pack fresh',
  price: '£4.99',
  quality: 'Very good',
  postage_size: 'Small',
  product_type: 'Hobbies & Collectables > Trading cards',
  category: 'Hobbies & Collectables > Trading cards',
  date_added: '2026-10-05 14:32',
  ...over,
});

let server, base, token, jpgBig, png;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await json('POST', '/api/admin/login', { password: 'owner-secret' })).data.token;
  jpgBig = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#c33' } }).jpeg().toBuffer();
  png = await sharp({ create: { width: 300, height: 400, channels: 4, background: '#3c3' } }).png().toBuffer();
});
after(() => { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function json(method, url, body) {
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
  for (const f of files || []) fd.append(f.field, new Blob([f.data]), f.name);
  const res = await fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const products = async () => (await fetch(base + '/api/products').then((r) => r.json()));

describe('Vinted-format import (unit)', () => {
  it('maps price, quality, category, date, stock and makes stable unique ids', () => {
    const r = importer.importList([
      vinted(),
      vinted({ price: 3, category: 'Hobbies & Collectables > Trading card lots', quantity: 4 }),
      vinted({ title: 'Pokémon Bulk & Lot!', price: '12', stock: 2, photos: [], photo: '' }),
      vinted({ price: 'free' }),
      vinted({ title: '' }),
      'not an object',
    ]);
    assert.equal(r.format, 'vinted');
    assert.equal(r.items.length, 3);
    const [a, b, c] = r.items.map((i) => i.product);
    assert.equal(a.id, 'charizard-ex-199-165');
    assert.equal(b.id, 'charizard-ex-199-165-2');
    assert.equal(c.id, 'pokemon-bulk-and-lot');
    assert.equal(a.price_gbp, 4.99);
    assert.equal(a.condition, 'Very good');
    assert.equal(a.category, 'Trading cards');
    assert.equal(b.category, 'Trading card lots');
    assert.equal(a.stock, 1);
    assert.equal(b.stock, 4);
    assert.equal(c.stock, 2);
    assert.ok(a.added_at.startsWith('2026-10-05'));
    assert.deepEqual(r.items[0].localRefs.length, 3);
    assert.deepEqual(r.errors.map((e) => e.index), [3, 4, 5]);
    assert.match(r.errors[0].error, /Price "free"/);
    assert.match(r.errors[1].error, /Missing title/);
    // same input -> same ids (stable re-imports)
    assert.equal(importer.importList([vinted()]).items[0].product.id, 'charizard-ex-199-165');
  });

  it('accepts the shop schema unchanged', () => {
    const r = importer.importList([{ id: 'x1', title: 'X', price_gbp: 2, stock: 3, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' }]);
    assert.equal(r.format, 'shop');
    assert.equal(r.items[0].product.id, 'x1');
    assert.equal(r.items[0].product.image, '/images/tauros-ar.svg');
  });
});

describe('admin upload with photos', () => {
  it('imports a Vinted file + photos in one request, matching by file name (any case / HEIC)', async () => {
    const heic = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.heic'));
    const r = await multipart('/api/admin/upload', { mode: 'merge' }, [
      { field: 'file', name: 'vinted_listings.json', data: JSON.stringify([vinted(), vinted({ title: 'No photos here', photos: ['images/missing.jpg'], photo: '' }), vinted({ price: 'oops' })]) },
      { field: 'photos', name: 'img_001.JPG', data: jpgBig },
      { field: 'photos', name: 'IMG_002.png', data: png },
      { field: 'photos', name: 'back_photo.heic', data: heic },
      { field: 'photos', name: 'random.jpg', data: png },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.added, 2);
    assert.equal(r.data.photos, 3);
    assert.equal(r.data.errors.length, 1);
    assert.equal(r.data.errors[0].item, 3);
    assert.ok(r.data.warnings.some((w) => /missing\.jpg/.test(w)));
    assert.ok(r.data.warnings.some((w) => /random\.jpg/.test(w)));

    const card = (await products()).find((p) => p.id === 'charizard-ex-199-165');
    assert.equal(card.images.length, 3);
    assert.equal(card.image, card.images[0]);
    assert.match(card.images[0], /^\/uploads\/charizard-ex-199-165-img-001-[0-9a-f]{10}\.jpg$/);
    assert.match(card.images[2], /back-photo/);
    // resized + served
    const res = await fetch(base + card.image);
    assert.equal(res.status, 200);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.ok(meta.width <= 1200 && meta.height <= 1200);
    const placeholder = (await products()).find((p) => p.id === 'no-photos-here');
    assert.equal(placeholder.image, '/images/lot-bulk-commons.svg');
    assert.ok((await products()).some((p) => p.id === 'keep-me'));
  });

  it('replace mode refuses a file with bad items and changes nothing', async () => {
    const before = await products();
    const r = await multipart('/api/admin/upload', { mode: 'replace' }, [
      { field: 'file', name: 'x.json', data: JSON.stringify([vinted({ title: 'Fine' }), vinted({ price: '' })]) },
    ]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /#2/);
    assert.deepEqual(await products(), before);
  });

  it('reports invalid JSON clearly', async () => {
    const r = await multipart('/api/admin/upload', { mode: 'merge' }, [{ field: 'file', name: 'broken.json', data: '[{"title": ' }]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /broken\.json is not valid JSON/);
  });

  it('bulk photos (batched, photos only) attach to existing cards in export order', async () => {
    const up = await multipart('/api/admin/upload', { mode: 'merge' }, [
      { field: 'file', name: 'v.json', data: JSON.stringify([vinted({ title: 'Later photos', photos: ['a\\one.jpg', 'a\\two.jpg'], photo: '' })]) },
    ]);
    assert.equal(up.status, 200);
    // second photo arrives first, in a separate batch
    let r = await multipart('/api/admin/photos/bulk', {}, [
      { field: 'photos', name: 'TWO.jpg', data: png },
      { field: 'photos', name: 'nobody.jpg', data: png },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.data.saved, 1);
    assert.ok(r.data.results.some((x) => x.name === 'TWO.jpg' && x.card === 'later-photos'));
    assert.ok(r.data.results.some((x) => x.name === 'nobody.jpg' && x.card === null));
    r = await multipart('/api/admin/photos/bulk', {}, [{ field: 'photos', name: 'one.JPG', data: jpgBig }]);
    assert.equal(r.data.saved, 1);
    const card = (await products()).find((p) => p.id === 'later-photos');
    assert.equal(card.images.length, 2);
    assert.match(card.images[0], /later-photos-one-/);
    assert.match(card.images[1], /later-photos-two-/);
  });

  it('per-card photo upload appends; unsupported types get a clear error', async () => {
    let r = await multipart('/api/admin/products/keep-me/images', {}, [{ field: 'photos', name: 'front.png', data: png }]);
    assert.equal(r.status, 200);
    assert.equal(r.data.product.images.length, 2); // original svg + new photo
    r = await multipart('/api/admin/products/keep-me/images', {}, [{ field: 'photos', name: 'anim.gif', data: png }]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /only JPG, PNG, WebP or HEIC/);
    const noAuth = await fetch(base + '/api/admin/photos/bulk', { method: 'POST' });
    assert.equal(noAuth.status, 401);
  });
});
