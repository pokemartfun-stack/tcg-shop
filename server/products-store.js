'use strict';
// Product catalogue store: in-memory copy + local file + optional GitHub sync.
const fs = require('fs');
const path = require('path');
const sync = require('./github-sync');
const { normaliseCategory } = require('../public/js/categories');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'products.json');
const REPO_FILE = 'data/products.json';

function filePath() {
  return process.env.PRODUCTS_FILE || DEFAULT_PATH;
}

let cache = null;

function get() {
  if (!cache) cache = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  return cache;
}

function reset() {
  cache = null;
}

const PLACEHOLDER_IMAGE = '/images/lot-bulk-commons.svg';
const ID_RE = /^[a-z0-9][a-z0-9-_]{0,79}$/i;

function normalise(p, idx = 0) {
  const where = `Item ${idx + 1}`;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: `${where}: not an object` };
  const id = String(p.id || '').trim();
  if (!ID_RE.test(id)) return { error: `${where}: id must be letters, numbers, - or _` };
  const title = String(p.title || '').trim();
  if (!title) return { error: `${where} (${id}): title is required` };
  const price = Number(p.price_gbp);
  if (!Number.isFinite(price) || price < 0) return { error: `${where} (${id}): price_gbp must be a number ≥ 0` };
  const stock = Number(p.stock ?? 0);
  if (!Number.isInteger(stock) || stock < 0) return { error: `${where} (${id}): stock must be a whole number ≥ 0` };
  const isUrl = (u) => /^(https?:\/\/|\/)[^\s"'<>\\]*$/i.test(u);
  let images = Array.isArray(p.images) ? p.images.map((u) => String(u || '').trim()).filter(Boolean) : [];
  const first = String(p.image || '').trim();
  if (first && !images.includes(first)) images.unshift(first);
  const bad = images.find((u) => !isUrl(u));
  if (bad) return { error: `${where} (${id}): image must be a URL or /path (got "${bad.slice(0, 80)}")` };
  images = [...new Set(images)].slice(0, 20);
  if (!images.length) images = ['/images/lot-bulk-commons.svg'];
  const image = images[0];
  const product = {
    id,
    title,
    description: String(p.description || '').trim(),
    price_gbp: Math.round(price * 100) / 100,
    condition: String(p.condition || 'Near mint').trim(),
    category: normaliseCategory(p.category), // one of the 4 shop categories (decides the shop tab)
    image,
    images,
    stock,
  };
  if (Array.isArray(p.photo_files)) {
    // lower-case file names (no extension) from the Vinted export, used to match bulk photo uploads
    const pf = [...new Set(p.photo_files.map((x) => String(x).toLowerCase().trim()).filter((x) => /^[^\\/:*?"<>|]{1,120}$/.test(x)))].slice(0, 30);
    if (pf.length) product.photo_files = pf;
  }
  if (p.photo_map && typeof p.photo_map === 'object' && !Array.isArray(p.photo_map)) {
    // photo name -> uploaded file, so photos can always be sorted in JSON order
    const pm = {};
    for (const [k, v] of Object.entries(p.photo_map).slice(0, 40)) {
      const key = String(k).toLowerCase().trim();
      if (/^[^\\/:*?"<>|]{1,120}$/.test(key) && typeof v === 'string' && isUrl(v)) pm[key] = v;
    }
    if (Object.keys(pm).length) product.photo_map = pm;
  }
  if (p.added_at && !Number.isNaN(Date.parse(p.added_at))) product.added_at = new Date(p.added_at).toISOString();
  return { product };
}

function validateList(list) {
  if (!Array.isArray(list)) return { error: 'JSON must be an array of products' };
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const r = normalise(list[i], i);
    if (r.error) return r;
    if (seen.has(r.product.id)) return { error: `Duplicate id in file: ${r.product.id}` };
    seen.add(r.product.id);
    out.push(r.product);
  }
  return { products: out };
}

async function pullFromGitHub() {
  const list = await sync.pullJson(REPO_FILE);
  if (!list) return false;
  const v = validateList(list);
  if (v.error) throw new Error(`GitHub products.json invalid: ${v.error}`);
  cache = v.products;
  try { fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2) + '\n'); } catch { /* ignore */ }
  return true;
}

async function save(list, message) {
  cache = list;
  fs.writeFileSync(filePath(), JSON.stringify(list, null, 2) + '\n', 'utf8');
  return sync.safePush(REPO_FILE, list, message);
}

/**
 * Check every line against current stock. Returns array of problems (empty = ok).
 */
function checkStock(items) {
  const list = get();
  const problems = [];
  for (const line of items) {
    const p = list.find((x) => x.id === line.productId);
    if (!p) problems.push({ productId: line.productId, error: 'No longer available' });
    else if (line.qty > p.stock) {
      problems.push({
        productId: p.id,
        error: p.stock < 1 ? `${p.title} is out of stock` : `Only ${p.stock} of ${p.title} left`,
      });
    }
  }
  return problems;
}

/**
 * Atomically (single-threaded JS, no await before mutation) verify and take stock.
 * Returns { ok, problems, sync }.
 */
async function decrementStock(items, reason) {
  const problems = checkStock(items);
  if (problems.length) return { ok: false, problems };
  const next = get().map((p) => {
    const line = items.find((l) => l.productId === p.id);
    return line ? { ...p, stock: p.stock - line.qty } : p;
  });
  const syncResult = await save(next, `stock: ${reason}`);
  return { ok: true, problems: [], sync: syncResult };
}

module.exports = {
  get, reset, save, normalise, validateList, pullFromGitHub, checkStock, decrementStock,
  ghConfig: sync.ghConfig, PLACEHOLDER_IMAGE, ID_RE,
};
