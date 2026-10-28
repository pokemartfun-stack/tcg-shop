'use strict';
// Customer reviews (1–5 stars). Shoppers post a review from the shop page; it stays PENDING
// (not shown) until the owner approves it in /admin → Customer reviews. The owner can also hide,
// delete or feature (pin to the top) reviews, and switch the whole section on or off.
//
// Storage: one file, reviews.json = { enabled, reviews: [...] }, kept in the PRIVATE orders repo
// (ORDERS_GITHUB_REPO, "[skip render]" commits — no redeploy), with a local copy (REVIEWS_FILE or
// data/reviews.json) as the cache and as the fallback when no private repo is set (Render wipes it).
// Shoppers' IP addresses are never stored: the spam limits below only keep a short-lived hash in memory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ordersStore = require('./orders-store');

const REPO_FILE = 'reviews.json';
const PENDING_KEY = '__reviews__';
const STATUSES = ['pending', 'approved', 'hidden'];
const LIMITS = { name: 40, comment: 1000, commentMin: 10, order: 60 };
const MAX_PENDING = 200; // stop accepting new reviews if this many are waiting (spam flood)
const PUBLIC_MAX = 60; // reviews sent to the shop page (featured first, then newest)
const ID_RE = /^rv_[a-f0-9]{8,32}$/;

function filePath() {
  return process.env.REVIEWS_FILE || path.join(__dirname, '..', 'data', 'reviews.json');
}

let cache = null;

function clean(data) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    enabled: d.enabled === true,
    reviews: (Array.isArray(d.reviews) ? d.reviews : []).filter((r) => r && ID_RE.test(String(r.id))).map((r) => ({
      ...r,
      rating: Math.min(5, Math.max(1, Math.round(Number(r.rating) || 1))),
      status: STATUSES.includes(r.status) ? r.status : 'pending',
      featured: r.featured === true,
    })),
  };
}

function data() {
  if (!cache) {
    try { cache = clean(JSON.parse(fs.readFileSync(filePath(), 'utf8'))); } catch { cache = clean({}); }
  }
  return cache;
}

function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Could not write local reviews file:', err.message);
  }
}

ordersStore.registerFile(PENDING_KEY, REPO_FILE, () => data(), 'reviews');

async function save(message) {
  writeLocal();
  return ordersStore.pushFile(REPO_FILE, data(), message, PENDING_KEY);
}

/** Load reviews.json from the private repo (startup). Local changes not yet pushed win. */
async function pullFromGitHub() {
  const remote = await ordersStore.pullFile(REPO_FILE);
  if (!remote) return false;
  const r = clean(remote);
  if (ordersStore.status().pending && cache) {
    const byId = new Map(r.reviews.map((x) => [x.id, x]));
    for (const x of data().reviews) byId.set(x.id, x);
    cache = { enabled: data().enabled, reviews: [...byId.values()] };
  } else {
    cache = r;
  }
  writeLocal();
  return true;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Summary + approved reviews for the shop page (no order numbers, no internal fields). */
function publicView() {
  const d = data();
  if (!d.enabled) return { enabled: false, average: null, count: 0, breakdown: null, reviews: [] };
  const shown = d.reviews.filter((r) => r.status === 'approved');
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  shown.forEach((r) => { breakdown[r.rating]++; });
  const sorted = shown.slice().sort((a, b) => (b.featured - a.featured) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    enabled: true,
    average: shown.length ? round1(shown.reduce((s, r) => s + r.rating, 0) / shown.length) : null,
    count: shown.length,
    breakdown,
    reviews: sorted.slice(0, PUBLIC_MAX).map((r) => ({
      id: r.id, name: r.name, rating: r.rating, comment: r.comment, createdAt: r.createdAt,
      featured: r.featured, verified: r.verified === true,
    })),
  };
}

// Plain text only: strip control characters (keep line breaks), collapse long runs of blank lines.
function text(v, max) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max + 1);
}

/** Validate a shopper's review. Returns { review } or { error, field }. */
function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = text(b.name, LIMITS.name).replace(/\s+/g, ' ');
  if (!name) return { error: 'Please enter your name (first name is fine)', field: 'name' };
  if (name.length > LIMITS.name) return { error: `Name must be ${LIMITS.name} characters or fewer`, field: 'name' };
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'Please choose 1 to 5 stars', field: 'rating' };
  const comment = text(b.comment, LIMITS.comment);
  if (comment.length < LIMITS.commentMin) return { error: `Please write at least ${LIMITS.commentMin} characters`, field: 'comment' };
  if (comment.length > LIMITS.comment) return { error: `Review must be ${LIMITS.comment} characters or fewer`, field: 'comment' };
  if (/(https?:\/\/|www\.)/i.test(comment + ' ' + name)) return { error: 'Please leave out web links', field: 'comment' };
  const order = text(b.order, LIMITS.order).replace(/^#/, '');
  if (order && (order.length > LIMITS.order || !/^[A-Za-z0-9_-]+$/.test(order))) {
    return { error: 'Order number can only contain letters, numbers, - and _', field: 'order' };
  }
  return { review: { name, rating, comment, order: order || null } };
}

// ---------------- Spam limits (memory only) ----------------
const RATE = { perClient: 3, clientWindowMs: 10 * 60 * 1000, global: 30, globalWindowMs: 60 * 60 * 1000 };
const hits = new Map(); // hashed client -> [timestamps]
let globalHits = [];
const SALT = crypto.randomBytes(16).toString('hex'); // new each start, so hashes can't be linked to IPs later

function clientKey(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  return crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 24);
}

function rateLimited(req) {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < RATE.globalWindowMs);
  if (globalHits.length >= RATE.global) return true;
  const key = clientKey(req);
  const list = (hits.get(key) || []).filter((t) => now - t < RATE.clientWindowMs);
  if (list.length >= RATE.perClient) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  globalHits.push(now);
  if (hits.size > 5000) hits.clear(); // keep memory bounded
  return false;
}

async function add(input) {
  const v = validate(input);
  if (v.error) return v;
  const d = data();
  if (d.reviews.filter((r) => r.status === 'pending').length >= MAX_PENDING) {
    return { error: 'We have lots of reviews waiting to be checked — please try again in a few days', status: 503 };
  }
  const now = new Date().toISOString();
  const order = v.review.order;
  const review = {
    id: 'rv_' + crypto.randomBytes(8).toString('hex'),
    name: v.review.name,
    rating: v.review.rating,
    comment: v.review.comment,
    order,
    // "Verified purchase" only when the order number matches a real (non-demo) order
    verified: Boolean(order && (() => { const o = ordersStore.find(order); return o && !o.demo; })()),
    status: 'pending',
    featured: false,
    createdAt: now,
    updatedAt: now,
  };
  d.reviews.push(review);
  const r = await save(`review ${review.id} (new, pending)`);
  return { review, ...r };
}

async function update(id, patch) {
  const d = data();
  const rv = d.reviews.find((r) => r.id === id);
  if (!rv) return { error: 'Review not found', status: 404 };
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.status !== undefined && !STATUSES.includes(p.status)) return { error: 'Status must be pending, approved or hidden', status: 400 };
  if (p.featured !== undefined && typeof p.featured !== 'boolean') return { error: 'featured must be true or false', status: 400 };
  if (p.status === undefined && p.featured === undefined) return { error: 'Nothing to change', status: 400 };
  if (p.status !== undefined) rv.status = p.status;
  if (p.featured !== undefined) rv.featured = p.featured;
  if (rv.featured && p.featured === true && rv.status !== 'approved') rv.status = 'approved'; // featuring shows it
  rv.updatedAt = new Date().toISOString();
  const r = await save(`review ${rv.id}: ${rv.status}${rv.featured ? ', featured' : ''}`);
  return { review: rv, ...r };
}

async function remove(id) {
  const d = data();
  const i = d.reviews.findIndex((r) => r.id === id);
  if (i < 0) return { error: 'Review not found', status: 404 };
  d.reviews.splice(i, 1);
  const r = await save(`review ${id} deleted`);
  return { deleted: id, ...r };
}

async function setEnabled(on) {
  data().enabled = on === true;
  const r = await save(`reviews section ${on ? 'on' : 'off'}`);
  return { enabled: data().enabled, ...r };
}

function adminView() {
  const d = data();
  const counts = { pending: 0, approved: 0, hidden: 0, featured: 0 };
  d.reviews.forEach((r) => { counts[r.status]++; if (r.featured) counts.featured++; });
  return {
    enabled: d.enabled,
    counts,
    reviews: d.reviews.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    storage: ordersStore.status(),
  };
}

function reset() {
  cache = null; hits.clear(); globalHits = [];
}

// ---------------- Routes ----------------
const publicRouter = express.Router();
publicRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(publicView());
});
publicRouter.post('/', async (req, res) => {
  if (!data().enabled) return res.status(403).json({ error: 'Reviews are switched off at the moment' });
  const b = req.body || {};
  // Honeypot: a hidden "website" box real shoppers never see. Bots that fill it get a normal
  // looking reply, but nothing is saved.
  if (b.website) return res.json({ ok: true, pending: true });
  if (rateLimited(req)) return res.status(429).json({ error: 'Thanks! You have sent a few reviews already — please try again later' });
  try {
    const r = await add(b);
    if (r.error) return res.status(r.status || 400).json({ error: r.error, field: r.field });
    res.json({ ok: true, pending: true });
  } catch (err) {
    console.error('Could not save review:', err.message);
    res.status(500).json({ error: 'Could not save your review, please try again' });
  }
});

const adminRouter = express.Router();
adminRouter.get('/', (_req, res) => res.json(adminView()));
adminRouter.put('/settings', async (req, res) => {
  const on = req.body && req.body.enabled;
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  const r = await setEnabled(on);
  res.json({ ...r, ...adminView() });
});
adminRouter.patch('/:id', async (req, res) => {
  const r = await update(req.params.id, req.body);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json({ ...r, ...adminView() });
});
adminRouter.delete('/:id', async (req, res) => {
  const r = await remove(req.params.id);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json({ ...r, ...adminView() });
});

module.exports = {
  publicRouter, adminRouter, publicView, adminView, validate, add, update, remove, setEnabled,
  pullFromGitHub, reset, data, filePath, LIMITS, RATE, STATUSES, REPO_FILE,
};
