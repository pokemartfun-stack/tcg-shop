'use strict';
// Order storage. Orders contain names, emails and home addresses, so they must NEVER go to the
// public shop repo. With ORDERS_GITHUB_REPO set (a PRIVATE repo), every order is committed as
// its own file  orders/YYYY-MM/<order-id>.json  ("[skip render]" commits): one file per order
// means two orders never fight over the same file, and a status update only rewrites that
// order's file. A local copy (ORDERS_FILE or data/orders.json) is the in-memory cache and the
// fallback when no private repo is configured (Render wipes it on every restart/deploy).
const fs = require('fs');
const path = require('path');
const sync = require('./github-sync');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'orders.json');
const PUBLIC_REPOS = ['pokemartfun-stack/tcg-shop'];
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const STATUSES = ['paid', 'posted', 'refunded', 'cancelled'];

function filePath() {
  return process.env.ORDERS_FILE || DEFAULT_PATH;
}

/** Private-repo config, or null when not configured. */
function ordersConfig() {
  const repo = String(process.env.ORDERS_GITHUB_REPO || '').trim();
  const token = process.env.ORDERS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo) return null;
  return { repo, token: token || '', branch: process.env.ORDERS_GITHUB_BRANCH || 'main' };
}

let cache = null;
const state = { checked: false, private: null, problem: null, lastError: null, pending: new Set(), loadedFromGitHub: false };

/** Is this repo the public shop repo (where orders must never go)? */
function isShopRepo(repo) {
  const r = String(repo || '').toLowerCase();
  const shop = String(process.env.GITHUB_REPO || 'pokemartfun-stack/tcg-shop').toLowerCase();
  return r === shop || PUBLIC_REPOS.includes(r);
}

/** Older orders used status names like 'demo_complete' / 'paypal_client_complete'. */
function normalise(o) {
  if (!o || typeof o !== 'object') return o;
  const out = { ...o };
  const legacy = String(o.status || '');
  if (out.demo === undefined) out.demo = /demo/.test(legacy) || String(o.id || '').startsWith('demo_') || String(o.id || '').startsWith('pp_');
  if (out.stock_conflict === undefined && /stock_conflict/.test(legacy)) out.stock_conflict = true;
  if (!STATUSES.includes(legacy)) out.status = 'paid';
  if (out.total === undefined) out.total = Math.round(((out.subtotal || 0) + ((out.postage && out.postage.amount) || 0)) * 100) / 100;
  return out;
}

function readLocal() {
  try {
    const list = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(list) ? list.map(normalise) : [];
  } catch {
    return [];
  }
}

function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Could not write local orders file:', err.message);
  }
}

function all() {
  if (!cache) cache = readLocal();
  return cache;
}

function find(id) {
  return all().find((o) => o.id === id) || null;
}

/** UK month of an order, used for its folder: orders/2026-10/<id>.json */
function monthOf(iso) {
  const d = new Date(iso || Date.now());
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}`;
}

function repoPath(order) {
  return `orders/${monthOf(order.createdAt)}/${order.id}.json`;
}

/** Check once that the orders repo is set up safely (private, not the shop repo, token works). */
async function checkRepo() {
  const cfg = ordersConfig();
  if (!cfg) return false;
  if (state.checked && !state.problem) return true;
  state.checked = true;
  state.problem = null;
  if (isShopRepo(cfg.repo)) {
    state.problem = `ORDERS_GITHUB_REPO is set to the public shop repo (${cfg.repo}) — orders are NOT saved there. Use a separate private repo.`;
    return false;
  }
  if (!cfg.token) {
    state.problem = 'ORDERS_GITHUB_REPO is set but there is no GITHUB_TOKEN / ORDERS_GITHUB_TOKEN.';
    return false;
  }
  try {
    const info = await sync.repoGet(cfg);
    state.private = Boolean(info.private);
    if (!info.private) {
      state.problem = `The orders repo ${cfg.repo} is PUBLIC — orders are NOT saved there. Make it private in GitHub settings.`;
      return false;
    }
    return true;
  } catch (err) {
    state.checked = false; // try again next time
    state.problem = err.status === 404
      ? `Can't see the orders repo ${cfg.repo}: create it (private) and give the token access to it (Contents: Read and write).`
      : `Can't reach the orders repo ${cfg.repo}: ${err.message}`;
    return false;
  }
}

let chain = Promise.resolve();
/** Commit one file to the private repo (serialised; fresh sha each time so updates never conflict). */
function pushFile(file, data, message, pendingKey) {
  const cfg = ordersConfig();
  if (!cfg) return Promise.resolve({ github: false });
  state.pending.add(pendingKey);
  chain = chain.catch(() => {}).then(async () => {
    try {
      if (!(await checkRepo())) throw new Error(state.problem);
      let sha;
      try { sha = (await sync.gh(cfg, file, 'GET')).sha; } catch (err) { if (err.status !== 404) throw err; }
      await sync.gh(cfg, file, 'PUT', {
        message: `[skip render] ${message}`,
        content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64'),
        branch: cfg.branch,
        ...(sha ? { sha } : {}),
      });
      state.pending.delete(pendingKey);
      state.lastError = null;
      return { github: true };
    } catch (err) {
      state.lastError = err.message;
      console.error(`${file} not saved to the orders repo:`, err.message);
      return { github: false, githubError: err.message };
    }
  });
  return chain;
}

// Other private files kept next to the orders (e.g. reviews.json): key -> { file, data(), message }.
// Registered so "Retry saving now" also retries them if a save to the repo failed.
const EXTRA_FILES = new Map();
function registerFile(key, file, data, message) { EXTRA_FILES.set(key, { file, data, message }); }

/** Read one JSON file from the private repo. null if not configured or the file doesn't exist yet. */
async function pullFile(file) {
  const cfg = ordersConfig();
  if (!cfg) return null;
  if (!(await checkRepo())) throw new Error(state.problem);
  try {
    const d = await sync.gh(cfg, file, 'GET');
    return JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

function pushOrder(order, message) {
  return pushFile(repoPath(order), order, message, order.id);
}

// ---------------- Cost prices ----------------
// What the owner paid for each product. Kept OUT of products.json (that file is synced to the
// PUBLIC shop repo) — stored next to the orders: costs.json in the private repo + local copy.
const COSTS_KEY = '__costs__';
let costCache = null;
function costsPath() {
  return process.env.COSTS_FILE || path.join(path.dirname(filePath()), 'costs.json');
}
function costs() {
  if (!costCache) {
    try { const c = JSON.parse(fs.readFileSync(costsPath(), 'utf8')); costCache = c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch { costCache = {}; }
  }
  return costCache;
}
function getCost(id) {
  const c = costs()[id];
  return Number.isFinite(c) ? c : null;
}
/** '' / null = no cost price. Returns { value } or { error }. */
function parseCost(v) {
  if (v === undefined || v === null || v === '') return { value: null };
  const c = Number(v);
  if (!Number.isFinite(c) || c < 0 || c > 100000) return { error: 'cost price must be a number ≥ 0 (or blank)' };
  return { value: Math.round(c * 100) / 100 };
}
/** Set several cost prices at once: { id: number|null }. Saves locally + to the private repo. */
async function setCosts(changes) {
  const c = { ...costs() };
  let changed = false;
  for (const [id, v] of Object.entries(changes || {})) {
    if (!ID_RE.test(id)) continue;
    if (v === null) { if (id in c) { delete c[id]; changed = true; } } else if (c[id] !== v) { c[id] = v; changed = true; }
  }
  if (!changed) return { github: false, unchanged: true };
  costCache = c;
  try {
    fs.mkdirSync(path.dirname(costsPath()), { recursive: true });
    fs.writeFileSync(costsPath(), JSON.stringify(c, null, 2) + '\n', 'utf8');
  } catch (err) { console.error('Could not write local costs file:', err.message); }
  return pushFile('costs.json', costCache, 'cost prices', COSTS_KEY);
}

/** Save a new order (local copy straight away, then the private repo). */
async function add(order) {
  const o = normalise({ ...order, updatedAt: order.updatedAt || order.createdAt || new Date().toISOString() });
  if (!ID_RE.test(String(o.id))) throw new Error('Bad order id');
  const list = all();
  const i = list.findIndex((x) => x.id === o.id);
  if (i >= 0) list[i] = o; else list.push(o);
  writeLocal();
  const r = await pushOrder(o, `order ${o.id}`);
  return { order: o, ...r };
}

/** Update an order (status, tracking …) and save it again. */
async function update(id, patch) {
  const list = all();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return { error: 'Order not found' };
  const o = { ...list[i], ...patch, id: list[i].id, updatedAt: new Date().toISOString() };
  list[i] = o;
  writeLocal();
  const r = await pushOrder(o, `order ${o.id}: ${o.status}`);
  return { order: o, ...r };
}

/** Retry every order that hasn't reached the repo yet. */
async function retryPending() {
  const ids = [...state.pending];
  let ok = 0;
  for (const id of ids) {
    if (id === COSTS_KEY) { if ((await pushFile('costs.json', costs(), 'cost prices (retry)', COSTS_KEY)).github) ok++; continue; }
    if (EXTRA_FILES.has(id)) { const x = EXTRA_FILES.get(id); if ((await pushFile(x.file, x.data(), `${x.message} (retry)`, id)).github) ok++; continue; }
    const o = find(id);
    if (!o) { state.pending.delete(id); continue; }
    if ((await pushOrder(o, `order ${o.id} (retry)`)).github) ok++;
  }
  return { retried: ids.length, saved: ok, pending: state.pending.size };
}

/** Load all orders from the private repo (startup). Merges with anything already in memory. */
async function pullFromGitHub() {
  const cfg = ordersConfig();
  if (!cfg) return false;
  if (!(await checkRepo())) throw new Error(state.problem);
  let months;
  try { months = await sync.gh(cfg, 'orders', 'GET'); } catch (err) { if (err.status === 404) months = []; else throw err; }
  const remote = [];
  for (const m of (Array.isArray(months) ? months : []).filter((x) => x.type === 'dir')) {
    const files = await sync.gh(cfg, m.path, 'GET');
    for (const f of (Array.isArray(files) ? files : []).filter((x) => x.type === 'file' && x.name.endsWith('.json'))) {
      const data = await sync.gh(cfg, f.path, 'GET');
      try { remote.push(normalise(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')))); } catch { /* skip broken file */ }
    }
  }
  try { // cost prices (local edits not yet pushed win)
    const c = await sync.gh(cfg, 'costs.json', 'GET');
    const remoteCosts = JSON.parse(Buffer.from(c.content, 'base64').toString('utf8'));
    if (remoteCosts && typeof remoteCosts === 'object') {
      costCache = state.pending.has(COSTS_KEY) ? { ...remoteCosts, ...costs() } : { ...costs(), ...remoteCosts };
      fs.mkdirSync(path.dirname(costsPath()), { recursive: true });
      fs.writeFileSync(costsPath(), JSON.stringify(costCache, null, 2) + '\n', 'utf8');
    }
  } catch (err) { if (err.status !== 404) console.error('Could not load cost prices:', err.message); }
  const byId = new Map(remote.map((o) => [o.id, o]));
  for (const o of all()) { // keep local orders/updates that are newer or not yet pushed
    const r = byId.get(o.id);
    if (!r || Date.parse(o.updatedAt || 0) > Date.parse(r.updatedAt || 0)) byId.set(o.id, o);
  }
  cache = [...byId.values()].sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  writeLocal();
  state.loadedFromGitHub = true;
  return true;
}

/** For the admin page: where orders are being saved, and whether that is safe. */
function status() {
  const cfg = ordersConfig();
  if (!cfg) {
    return {
      mode: 'local', safe: false, repo: null, pending: 0,
      warning: 'Orders are not being saved safely — set ORDERS_GITHUB_REPO (a private GitHub repo). Until then orders are only on the server disk, which Render wipes on every restart or deploy.',
    };
  }
  const problem = state.problem || (state.pending.size ? `${state.pending.size} order/cost/review update(s) not saved to ${cfg.repo} yet${state.lastError ? ': ' + state.lastError : ''}.` : null);
  return {
    mode: 'github', repo: cfg.repo, safe: !problem && state.checked && state.private === true,
    checked: state.checked, private: state.private, pending: state.pending.size,
    loaded: state.loadedFromGitHub, warning: problem,
  };
}

function reset() {
  cache = null; costCache = null;
  state.checked = false; state.private = null; state.problem = null; state.lastError = null;
  state.pending.clear(); state.loadedFromGitHub = false;
}

module.exports = { pushFile, pullFile, registerFile, all, find, add, update, costs, getCost, setCosts, parseCost, costsPath, retryPending, pullFromGitHub, status, checkRepo, reset, repoPath, monthOf, normalise, isShopRepo, STATUSES, ordersConfig };
