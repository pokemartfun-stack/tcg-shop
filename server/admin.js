'use strict';
const crypto = require('crypto');
const express = require('express');
const store = require('./products-store');
const settings = require('./settings-store');

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

router.post('/upload', async (req, res) => {
  const { mode, products } = req.body || {};
  if (mode !== 'merge' && mode !== 'replace') return res.status(400).json({ error: 'mode must be merge or replace' });
  const v = store.validateList(products);
  if (v.error) return res.status(400).json({ error: v.error });
  let next;
  let added = 0, updated = 0;
  const now = Date.now();
  const existing = new Map(store.get().map((p) => [p.id, p]));
  v.products.forEach((p, idx) => {
    if (!p.added_at) {
      const prev = existing.get(p.id);
      // keep original date for known cards; new cards keep file order (later in file = newer)
      p.added_at = prev && prev.added_at ? prev.added_at : new Date(now + idx).toISOString();
    }
  });
  if (mode === 'replace') {
    next = v.products;
    added = next.length;
  } else {
    next = store.get().slice();
    for (const p of v.products) {
      const i = next.findIndex((x) => x.id === p.id);
      if (i >= 0) { next[i] = p; updated++; } else { next.push(p); added++; }
    }
  }
  const sync = await store.save(next, `${mode} upload (${v.products.length} items)`);
  res.json({ ok: true, mode, added, updated, total: next.length, ...sync });
});

module.exports = { router, _tokens: TOKENS };
