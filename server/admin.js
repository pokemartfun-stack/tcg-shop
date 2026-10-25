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
const photoOrder = require('./photo-order');
const ordersStore = require('./orders-store');
const sales = require('./sales');

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
  res.json({ ok: true, github: cfg ? { repo: cfg.repo, branch: cfg.branch } : null, orders: ordersStore.status() });
});

// admin list includes the private cost prices (kept in the orders store, never in products.json)
const withCost = (p) => { const c = ordersStore.getCost(p.id); return c === null ? p : { ...p, cost_gbp: c }; };
router.get('/products', (_req, res) => res.json(store.get().map(withCost)));

router.post('/products', async (req, res) => {
  const { cost_gbp: costIn, ...body } = req.body || {};
  const cost = ordersStore.parseCost(costIn);
  if (cost.error) return res.status(400).json({ error: cost.error });
  const r = store.normalise(body);
  if (r.error) return res.status(400).json({ error: r.error });
  const list = store.get();
  if (list.some((p) => p.id === r.product.id)) return res.status(409).json({ error: `id ${r.product.id} already exists` });
  if (!r.product.added_at) r.product.added_at = new Date().toISOString();
  const sync = await store.save([...list, r.product], `add ${r.product.id}`);
  if (cost.value !== null) await ordersStore.setCosts({ [r.product.id]: cost.value });
  res.json({ product: withCost(r.product), ...sync });
});

router.patch('/products/:id', async (req, res) => {
  const list = store.get();
  const i = list.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const { cost_gbp: costIn, ...body } = req.body || {};
  const cost = costIn === undefined ? null : ordersStore.parseCost(costIn);
  if (cost && cost.error) return res.status(400).json({ error: cost.error });
  const merged = { ...list[i], ...body, id: list[i].id };
  const r = store.normalise(merged);
  if (r.error) return res.status(400).json({ error: r.error });
  const next = list.slice();
  next[i] = r.product;
  // only rewrite products.json (public repo commit + redeploy) when something there changed
  const changed = JSON.stringify(list[i]) !== JSON.stringify(r.product);
  const sync = changed ? await store.save(next, `update ${r.product.id}`) : { github: false, unchanged: true };
  if (cost) await ordersStore.setCosts({ [r.product.id]: cost.value });
  res.json({ product: withCost(r.product), ...sync });
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

// postage_bands: the Royal Mail formats on offer (name + size limits + default price) for the admin form
router.get('/settings', (_req, res) => res.json({ ...settings.get(), postage_bands: require('./postage').BANDS }));

// Banner image upload (multipart field "banner"): public/images/banner.jpg, or banner.gif for GIFs
// (kept animated), saved locally + committed to the repo.
router.post('/settings/banner', (req, res, next) => multipart([{ name: 'banner', maxCount: 1 }])(req, res, next), async (req, res) => {
  try {
    const f = req.files && req.files.banner && req.files.banner[0];
    if (!f) return res.status(400).json({ error: 'Choose a banner image (JPG, PNG, WebP, HEIC or GIF)' });
    const saved = await images.saveBanner(fs.readFileSync(f.path), f.originalname);
    const r = await settings.update({ banner_image: saved.url });
    if (r.error) return res.status(400).json({ error: r.error });
    const githubError = saved.githubError || r.githubError;
    res.json({ settings: r.settings, bytes: saved.bytes, format: saved.ext, ...(saved.frames ? { frames: saved.frames, animated: saved.animated } : {}), github: Boolean(saved.github && r.github), ...(githubError ? { githubError } : {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    cleanupFiles(req);
  }
});

// Shop logo upload (multipart field "logo"): public/images/logo.png (or logo.gif) + favicon, + repo.
router.post('/settings/logo', (req, res, next) => multipart([{ name: 'logo', maxCount: 1 }])(req, res, next), async (req, res) => {
  try {
    const f = req.files && req.files.logo && req.files.logo[0];
    if (!f) return res.status(400).json({ error: 'Choose a logo image (JPG, PNG, WebP, HEIC or GIF)' });
    const saved = await images.saveLogo(fs.readFileSync(f.path), f.originalname);
    const r = await settings.update({ logo_image: saved.url });
    if (r.error) return res.status(400).json({ error: r.error });
    const githubError = saved.githubError || r.githubError;
    res.json({ settings: r.settings, bytes: saved.bytes, format: saved.ext, ...(saved.frames ? { frames: saved.frames, animated: saved.animated } : {}), github: Boolean(saved.github && r.github), ...(githubError ? { githubError } : {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    cleanupFiles(req);
  }
});

// Back to the bundled default logo (public/images/logo-default.png, never overwritten by uploads);
// the favicon is regenerated from it too.
router.delete('/settings/logo', async (_req, res) => {
  const fav = await images.resetFaviconToDefault();
  const r = await settings.update({ logo_image: images.DEFAULT_LOGO_URL });
  const githubError = fav.githubError || r.githubError;
  res.json({ ...r, github: Boolean(fav.github && r.github), ...(githubError ? { githubError } : {}) });
});

// Page background upload (multipart field "background"): public/images/background.jpg (or .gif) + repo.
router.post('/settings/background', (req, res, next) => multipart([{ name: 'background', maxCount: 1 }])(req, res, next), async (req, res) => {
  try {
    const f = req.files && req.files.background && req.files.background[0];
    if (!f) return res.status(400).json({ error: 'Choose a background image (JPG, PNG, WebP, HEIC or GIF)' });
    const saved = await images.saveBackground(fs.readFileSync(f.path), f.originalname);
    const r = await settings.update({ background_image: saved.url, background_last: saved.path });
    if (r.error) return res.status(400).json({ error: r.error });
    const githubError = saved.githubError || r.githubError;
    res.json({ settings: r.settings, bytes: saved.bytes, format: saved.ext, ...(saved.frames ? { frames: saved.frames, animated: saved.animated } : {}), github: Boolean(saved.github && r.github), ...(githubError ? { githubError } : {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    cleanupFiles(req);
  }
});

// Remove page background: plain dark page (the file stays in the repo, so it can be restored).
router.delete('/settings/background', async (_req, res) => {
  const r = await settings.update({ background_image: '' });
  res.json(r);
});

// Restore the last saved page background (background.jpg or background.gif) after a remove.
router.post('/settings/background/restore', async (_req, res) => {
  const last = settings.get().background_last || '/images/background.jpg';
  const r = await settings.update({ background_image: `${last}?v=${Date.now()}` });
  res.json(r);
});

// Remove banner image: back to the coloured pattern (the file stays in the repo for history).
router.delete('/settings/banner', async (_req, res) => {
  const r = await settings.update({ banner_image: '' });
  res.json(r);
});

router.put('/settings', async (req, res) => {
  const r = await settings.update(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// ---------------- Sales: orders, status updates, summaries, CSV ----------------
// Admin-chosen date range (UK dates, both days included; default 1st of this month -> today).
function salesOpts(req, res) {
  const r = sales.parseRange(req.query.from, req.query.to);
  if (r.error) { res.status(400).json({ error: r.error }); return null; }
  return { ...r, includeDemo: req.query.demo === '1' || req.query.demo === 'true', fees: settings.get().fees || sales.DEFAULT_FEES };
}

router.get('/orders', (req, res) => {
  const o = salesOpts(req, res);
  if (!o) return;
  const list = sales.ordersInRange(ordersStore.all(), o.from, o.to)
    .filter((x) => o.includeDemo || !x.demo)
    .map((x) => ({ ...x, figures: sales.orderFigures(x, o.fees), uk: sales.ukParts(x.createdAt) }));
  res.json({ from: o.from, to: o.to, orders: list, storage: ordersStore.status() });
});

router.get('/sales/summary', (req, res) => {
  const o = salesOpts(req, res);
  if (!o) return;
  res.json({ ...sales.summarise(ordersStore.all(), o), today: sales.todayUk(), storage: ordersStore.status() });
});

router.get('/sales/csv', (req, res) => {
  const o = salesOpts(req, res);
  if (!o) return;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="po-ke-mart-fun-orders-${o.from}-to-${o.to}.csv"`);
  res.send('\uFEFF' + sales.toCsv(ordersStore.all(), o)); // BOM so Excel reads £ / accents correctly
});

router.get('/sales/xlsx', async (req, res) => {
  const o = salesOpts(req, res);
  if (!o) return;
  try {
    const buf = await require('./sales-xlsx').toXlsx(ordersStore.all(), o);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="po-ke-mart-fun-sales-${o.from}-to-${o.to}.xlsx"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Could not build the Excel file: ' + err.message });
  }
});

// Status workflow: paid -> posted (tracking number) -> optionally refunded / cancelled
router.patch('/orders/:id', async (req, res) => {
  const cur = ordersStore.find(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Order not found' });
  const b = req.body || {};
  const patch = {};
  if (b.status !== undefined) {
    if (!ordersStore.STATUSES.includes(b.status)) return res.status(400).json({ error: 'Status must be paid, posted, refunded or cancelled' });
    patch.status = b.status;
    if (b.status === 'posted' && !cur.posted_at) patch.posted_at = new Date().toISOString();
    if (b.status === 'refunded' || b.status === 'cancelled') patch[`${b.status}_at`] = new Date().toISOString();
  }
  if (b.tracking_number !== undefined) {
    const t = String(b.tracking_number).toUpperCase().replace(/\s+/g, '').slice(0, 40);
    if (t && !/^[A-Z0-9-]{6,40}$/.test(t)) return res.status(400).json({ error: 'Tracking number can only contain letters and numbers' });
    patch.tracking_number = t;
  }
  if ((patch.status || cur.status) === 'posted' && !(patch.tracking_number !== undefined ? patch.tracking_number : cur.tracking_number)) {
    return res.status(400).json({ error: 'Add the Royal Mail tracking number to mark the order as posted' });
  }
  if (b.postage_paid !== undefined) {
    if (b.postage_paid === '' || b.postage_paid === null) patch.postage_paid = null;
    else {
      const n = Number(b.postage_paid);
      if (!Number.isFinite(n) || n < 0 || n > 200) return res.status(400).json({ error: 'Postage paid must be an amount in £' });
      patch.postage_paid = Math.round(n * 100) / 100;
    }
  }
  if (b.note !== undefined) patch.note = String(b.note).slice(0, 500);
  const r = await ordersStore.update(cur.id, patch);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ order: r.order, github: r.github, githubError: r.githubError, storage: ordersStore.status() });
});

router.post('/orders/retry-sync', async (_req, res) => {
  res.json({ ...(await ordersStore.retryPending()), storage: ordersStore.status() });
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
 * Convert + store uploaded files for one card. Does NOT touch the product list
 * (so slow image work never overwrites changes made meanwhile).
 * Each photo is stored as /uploads/<id>-<photo name>-<hash>.jpg.
 * @returns {{ saved: Array<{stem, url, name}>, errors: string[] }}
 */
async function processPhotos(id, files, cache) {
  const saved = [];
  const errors = [];
  for (const f of files) {
    try {
      const st = images.stem(f.originalname);
      const key = `${id}|${f.path}`;
      let r = cache && cache.get(key);
      if (!r) {
        r = await images.savePhoto(fs.readFileSync(f.path), f.originalname, '=' + images.photoBase(id, st));
        if (cache) cache.set(key, r);
      }
      saved.push({ stem: st, url: r.url, name: f.originalname });
      if (r.githubError) errors.push(`${f.originalname}: saved, but GitHub copy failed (${r.githubError})`);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { saved, errors };
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
      let finalP = p;
      if (matched.length) {
        // photos came with the JSON: they replace any old uploads / svg placeholders
        const r = await processPhotos(p.id, matched, cache);
        photosSaved += r.saved.length;
        finalP = photoOrder.applyPhotos(p, r.saved, { replaceAll: true });
        r.errors.forEach((e) => warnings.push(`${p.title}: ${e}`));
      }
      if (missing.length && !photosFollow) waiting.push({ title: p.title, missing });
      const prev = existing.get(p.id);
      if (!finalP.images.length || (!matched.length && finalP.images.every((u) => photoOrder.PLACEHOLDER_RE.test(u)) && prev)) {
        // no photos yet in this upload: keep the card's existing photos (they get re-sorted by the new JSON order)
        const keep = prev && prev.images && prev.images.length ? prev.images : [store.PLACEHOLDER_IMAGE];
        finalP = photoOrder.orderImages({ ...finalP, images: [...new Set([...finalP.images.filter((u) => !photoOrder.PLACEHOLDER_RE.test(u)), ...keep])], photo_map: prev && prev.photo_map }).product;
      }
      Object.assign(p, finalP);
      if (!p.images.length) p.images = [store.PLACEHOLDER_IMAGE];
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
    if (!store.get().some((p) => p.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
    const files = (req.files && req.files.photos) || [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one photo' });
    const r = await processPhotos(req.params.id, files);
    if (!r.saved.length) return res.status(400).json({ error: r.errors.join('\n') || 'No photos saved' });
    // re-read after the (slow) image work so concurrent edits/batches are not lost
    const next = store.get().slice();
    const i = next.findIndex((p) => p.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Card was removed meanwhile' });
    next[i] = photoOrder.applyPhotos(next[i], r.saved, { replaceAll: req.body && req.body.mode === 'replace' });
    const sync = await store.save(next, `photos for ${next[i].id}`);
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
    const results = [];
    const groups = new Map();
    for (const f of files) {
      const p = matchPhoto(store.get(), f.originalname);
      if (!p) { results.push({ name: f.originalname, card: null, error: 'No card uses this photo name' }); continue; }
      if (!groups.has(p.id)) groups.set(p.id, []);
      groups.get(p.id).push(f);
    }
    const processed = [];
    for (const [id, group] of groups) processed.push({ id, group, r: await processPhotos(id, group) });
    // apply to a fresh copy of the list, then sort each card by its JSON photo order
    const list = store.get().slice();
    let saved = 0;
    for (const { id, group, r } of processed) {
      const i = list.findIndex((p) => p.id === id);
      if (i < 0) { group.forEach((f) => results.push({ name: f.originalname, card: null, error: 'Card was removed meanwhile' })); continue; }
      list[i] = photoOrder.applyPhotos(list[i], r.saved);
      saved += r.saved.length;
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

// One-click repair: sort every card's photos by its stored JSON photo order (no re-upload needed).
router.post('/photos/fix-order', async (_req, res) => {
  const list = store.get();
  let changed = 0;
  const noNames = [];
  const unresolved = [];
  const next = list.map((p) => {
    const hasUploads = (p.images || [p.image]).some((u) => /^\/uploads\//.test(u || ''));
    if (!(p.photo_files && p.photo_files.length)) {
      if (hasUploads) noNames.push(p.title);
      return p;
    }
    const r = photoOrder.orderImages(p);
    if (r.changed) changed++;
    if (r.unresolved) unresolved.push(p.title);
    return r.product;
  });
  const sync = changed ? await store.save(next, `fix photo order (${changed} cards)`) : { github: false };
  res.json({ ok: true, changed, checked: list.length, noPhotoNames: noNames, unresolved, ...sync });
});

module.exports = { router, _tokens: TOKENS };
