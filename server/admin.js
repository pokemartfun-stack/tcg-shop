'use strict';
const crypto = require('crypto');
const express = require('express');
const store = require('./products-store');
const settings = require('./settings-store');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const images = require('./images');
const importer = require('./importer');

const TOKENS = new Map(); // token -> expiry
const TTL = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return (req.cookies && req.cookies.admin) || null;
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin disabled: set ADMIN_PASSWORD' });
  const t = tokenFrom(req);
  const exp = t && TOKENS.get(t);
  if (!exp || exp < Date.now()) {
    if (t) TOKENS.delete(t);
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

const router = express.Router();
router.use(express.json({ limit: '5mb' }));

router.post('/login', (req, res) => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(503).json({ error: 'Admin disabled: set ADMIN_PASSWORD' });
  const given = (req.body && req.body.password) || '';
  if (!safeEqual(given, pw)) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  TOKENS.set(token, Date.now() + TTL);
  const secure = process.env.NODE_ENV === 'production' || (process.env.BASE_URL || '').startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `admin=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure}`);
  res.json({ ok: true, token });
});

router.post('/logout', (req, res) => {
  const t = tokenFrom(req);
  if (t) TOKENS.delete(t);
  res.setHeader('Set-Cookie', 'admin=; Path=/api/admin; Max-Age=0');
  res.json({ ok: true });
});

router.use(requireAdmin);

router.get('/status', (_req, res) => {
  const cfg = store.ghConfig();
  res.json({ ok: true, github: cfg ? { repo: cfg.repo, branch: cfg.branch } : null });
});

router.get('/products', (_req, res) => res.json(store.get()));

router.post('/products', async (req, res) => {
  const r = store.normalise(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const list = store.get();
  if (list.some((p) => p.id === r.product.id)) return res.status(409).json({ error: `id ${r.product.id} already exists` });
  if (!r.product.added_at) r.product.added_at = new Date().toISOString();
  const sync = await store.save([...list, r.product], `add ${r.product.id}`);
  res.json({ product: r.product, ...sync });
});

router.patch('/products/:id', async (req, res) => {
  const list = store.get();
  const i = list.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const merged = { ...list[i], ...(req.body || {}), id: list[i].id };
  const r = store.normalise(merged);
  if (r.error) return res.status(400).json({ error: r.error });
  const next = list.slice();
  next[i] = r.product;
  const sync = await store.save(next, `update ${r.product.id}`);
  res.json({ product: r.product, ...sync });
});

// Quick restock: { delta: +N / -N } — result clamped at 0.
router.post('/products/:id/stock', async (req, res) => {
  const delta = Number(req.body && req.body.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000) {
    return res.status(400).json({ error: 'delta must be a non-zero whole number' });
  }
  const list = store.get();
  const i = list.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const next = list.slice();
  next[i] = { ...list[i], stock: Math.max(0, list[i].stock + delta) };
  const sync = await store.save(next, `restock ${list[i].id} ${delta > 0 ? '+' : ''}${delta}`);
  res.json({ product: next[i], ...sync });
});

router.get('/settings', (_req, res) => res.json(settings.get()));

router.put('/settings', async (req, res) => {
  const r = await settings.update(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.delete('/products/:id', async (req, res) => {
  const list = store.get();
  if (!list.some((p) => p.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  const sync = await store.save(list.filter((p) => p.id !== req.params.id), `remove ${req.params.id}`);
  res.json({ ok: true, ...sync });
});

// ---------- Photo + JSON uploads (multipart) ----------
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 25 * 1024 * 1024, files: 120, fields: 20 },
});

function multipart(fields) {
  const mw = upload.fields(fields);
  return (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    mw(req, res, (err) => {
      if (!err) return next();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than 25 MB'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files in one go (max 120)'
        : err.message;
      res.status(400).json({ error: msg });
    });
  };
}

function cleanupFiles(req) {
  const all = Object.values(req.files || {}).flat();
  for (const f of all) fs.promises.unlink(f.path).catch(() => {});
}

function readJsonUpload(req) {
  const f = req.files && req.files.file && req.files.file[0];
  if (f) {
    let text = fs.readFileSync(f.path, 'utf8').replace(/^\uFEFF/, '');
    try { return { data: JSON.parse(text) }; } catch (err) {
      return { error: `${f.originalname} is not valid JSON (${err.message})` };
    }
  }
  if (req.body && typeof req.body.products === 'string') {
    try { return { data: JSON.parse(req.body.products) }; } catch (err) { return { error: `Not valid JSON (${err.message})` }; }
  }
  if (req.body && req.body.products !== undefined) return { data: req.body.products };
  return { error: 'Choose a .json file to upload' };
}

/**
 * Process uploaded files and attach them to a product (mutates a copy, returns it).
 * - each photo is stored as /uploads/<id>-<photo name>-<hash>.jpg
 * - re-uploading a photo with the same name replaces the old version
 * - images are ordered like photo_files (the Vinted export order), first = main photo
 */
async function attachPhotos(product, files, cache, { replaceAll = false } = {}) {
  const errors = [];
  const added = [];
  for (const f of files) {
    try {
      const key = `${product.id}|${f.path}`;
      let saved = cache && cache.get(key);
      if (!saved) {
        saved = await images.savePhoto(fs.readFileSync(f.path), f.originalname, `${product.id}-${images.stem(f.originalname)}`);
        if (cache) cache.set(key, saved);
      }
      added.push({ url: saved.url, prefix: `/uploads/${images.slugPart(`${product.id}-${images.stem(f.originalname)}`)}-` });
      if (saved.githubError) errors.push(`${f.originalname}: saved, but GitHub copy failed (${saved.githubError})`);
    } catch (err) {
      errors.push(err.message);
    }
  }
  let current = replaceAll ? [] : (product.images || [product.image] || []);
  current = current.filter((u) => u && u !== store.PLACEHOLDER_IMAGE && !added.some((a) => u.startsWith(a.prefix) && u !== a.url));
  let all = [...new Set([...current, ...added.map((a) => a.url)])];
  const order = (product.photo_files || []).map((st) => `/uploads/${images.slugPart(`${product.id}-${st}`)}-`);
  if (order.length) {
    const rank = (u) => { const i = order.findIndex((pre) => u.startsWith(pre)); return i < 0 ? order.length : i; };
    all = all.map((u, i) => ({ u, i })).sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i).map((x) => x.u);
  }
  if (!all.length) all = [store.PLACEHOLDER_IMAGE];
  return { product: { ...product, images: all.slice(0, 20), image: all[0] }, saved: added.length, errors };
}

/** Find the card a photo belongs to: by photo_files name, else photo name == card id. */
function matchPhoto(list, fileName) {
  const st = images.stem(fileName);
  return list.find((p) => (p.photo_files || []).includes(st)) || list.find((p) => p.id.toLowerCase() === st) || null;
}

router.post('/upload', multipart([{ name: 'file', maxCount: 1 }, { name: 'photos', maxCount: 119 }]), async (req, res) => {
  try {
    const mode = req.body && req.body.mode;
    if (mode !== 'merge' && mode !== 'replace') return res.status(400).json({ error: 'mode must be merge or replace' });
    const parsed = readJsonUpload(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const imp = importer.importList(parsed.data);
    const errors = imp.errors.map((e) => ({ ...e, item: e.index == null ? null : e.index + 1 }));
    const summary = (list) => list.map((e) => (e.item ? `#${e.item} ${e.title}: ${e.error}` : e.error)).join('\n');
    if (!imp.items.length) {
      return res.status(400).json({ error: `No cards could be imported.\n${summary(errors)}`, errors });
    }
    if (mode === 'replace' && errors.length) {
      return res.status(400).json({
        error: `Replace cancelled — fix these ${errors.length} item(s) first (nothing was changed):\n${summary(errors)}`,
        errors,
      });
    }

    // Match uploaded photos to cards by file name (case-insensitive, extension ignored).
    const photoFiles = (req.files && req.files.photos) || [];
    // the admin page sends photos afterwards in small batches (/photos/bulk) when photos_follow=1
    const photosFollow = Boolean(req.body && req.body.photos_follow);
    const byStem = importer.indexUploads(photoFiles);
    const used = new Set();
    const cache = new Map();
    const warnings = [];
    const waiting = [];
    let photosSaved = 0;
    const existing = new Map(store.get().map((p) => [p.id, p]));
    const now = Date.now();

    for (const it of imp.items) {
      const p = it.product;
      const matched = [];
      const missing = [];
      for (const ref of it.localRefs) {
        const f = byStem.get(images.stem(ref));
        if (f) { matched.push(f); used.add(f); } else missing.push(images.baseName(ref));
      }
      p.photo_files = it.localRefs.map((ref) => images.stem(ref));
      if (matched.length) {
        const r = await attachPhotos({ ...p, images: p.images.length ? p.images : [] }, matched, cache, { replaceAll: true });
        photosSaved += r.saved;
        p.images = [...new Set([...r.product.images.filter((u) => u !== store.PLACEHOLDER_IMAGE), ...p.images])];
        r.errors.forEach((e) => warnings.push(`${p.title}: ${e}`));
      }
      if (missing.length && !photosFollow) waiting.push({ title: p.title, missing });
      const prev = existing.get(p.id);
      if (!p.images.length) p.images = prev && prev.images && prev.images.length ? prev.images : [store.PLACEHOLDER_IMAGE];
      p.image = p.images[0];
      // keep original date for known cards; new cards keep file order (later in file = newer)
      if (!p.added_at) p.added_at = prev && prev.added_at ? prev.added_at : new Date(now + it.index).toISOString();
    }
    if (waiting.length > 5) {
      warnings.push(`${waiting.length} card(s) are waiting for their photos (e.g. ${waiting.slice(0, 3).map((w) => w.title).join(', ')}). Add them with "Bulk photos for existing cards".`);
    } else {
      waiting.forEach((w) => warnings.push(`${w.title}: photo${w.missing.length > 1 ? 's' : ''} not uploaded – ${w.missing.join(', ')}`));
    }
    const unused = photoFiles.filter((f) => !used.has(f)).map((f) => f.originalname);
    if (unused.length && !photosFollow) warnings.push(`Photos not matched to any card: ${unused.join(', ')}`);

    let next;
    let added = 0, updated = 0;
    if (mode === 'replace') {
      next = imp.items.map((it) => it.product);
      added = next.length;
    } else {
      next = store.get().slice();
      for (const { product } of imp.items) {
        const i = next.findIndex((x) => x.id === product.id);
        if (i >= 0) { next[i] = product; updated++; } else { next.push(product); added++; }
      }
    }
    const sync = await store.save(next, `${mode} upload (${imp.items.length} items, ${photosSaved} photos)`);
    res.json({
      ok: true, mode, format: imp.format, added, updated, total: next.length,
      photos: photosSaved, errors, warnings,
      ids: imp.items.map((it) => it.product.id),
      ...sync,
    });
  } catch (err) {
    console.error('Upload failed', err);
    res.status(500).json({ error: `Upload failed: ${err.message}` });
  } finally {
    cleanupFiles(req);
  }
});

// Per-card photos: multipart "photos" (1..20), mode=append (default) | replace
router.post('/products/:id/images', multipart([{ name: 'photos', maxCount: 20 }]), async (req, res) => {
  try {
    const list = store.get();
    const i = list.findIndex((p) => p.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Not found' });
    const files = (req.files && req.files.photos) || [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one photo' });
    const r = await attachPhotos(list[i], files, null, { replaceAll: req.body && req.body.mode === 'replace' });
    if (!r.saved) return res.status(400).json({ error: r.errors.join('\n') || 'No photos saved' });
    const next = list.slice();
    next[i] = r.product;
    const sync = await store.save(next, `photos for ${list[i].id}`);
    res.json({ product: next[i], warnings: r.errors, ...sync });
  } catch (err) {
    res.status(500).json({ error: `Photo upload failed: ${err.message}` });
  } finally {
    cleanupFiles(req);
  }
});

// Bulk photos for cards that already exist (sent in small batches by the admin page).
router.post('/photos/bulk', multipart([{ name: 'photos', maxCount: 20 }]), async (req, res) => {
  try {
    const files = (req.files && req.files.photos) || [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one photo' });
    let list = store.get().slice();
    const results = [];
    const groups = new Map();
    for (const f of files) {
      const p = matchPhoto(list, f.originalname);
      if (!p) { results.push({ name: f.originalname, card: null, error: 'No card uses this photo name' }); continue; }
      if (!groups.has(p.id)) groups.set(p.id, []);
      groups.get(p.id).push(f);
    }
    let saved = 0;
    for (const [id, group] of groups) {
      const i = list.findIndex((p) => p.id === id);
      const r = await attachPhotos(list[i], group);
      list[i] = r.product;
      saved += r.saved;
      group.forEach((f) => {
        const err = r.errors.find((e) => e.startsWith(f.originalname));
        results.push({ name: f.originalname, card: id, title: list[i].title, error: err && !/GitHub copy failed/.test(err) ? err : null, warning: err && /GitHub/.test(err) ? err : null });
      });
    }
    const sync = saved ? await store.save(list, `bulk photos (${saved})`) : { github: false };
    res.json({ ok: true, saved, results, ...sync });
  } catch (err) {
    res.status(500).json({ error: `Photo upload failed: ${err.message}` });
  } finally {
    cleanupFiles(req);
  }
});

module.exports = { router, _tokens: TOKENS };
