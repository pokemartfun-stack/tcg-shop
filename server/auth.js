'use strict';
/**
 * Customer accounts: scrypt password hashes, guest checkout needs no account.
 *
 * Storage: users.json in the PRIVATE orders repo (ORDERS_GITHUB_REPO, the same store as orders,
 * reviews and the admin 2FA settings), so accounts survive Render restarts and deploys. A local
 * copy (USERS_FILE or data/users.json, git-ignored) is the in-memory cache and the fallback in
 * demo mode / tests. The orders store refuses public repos, so users never go to the shop repo.
 * Password hashes never leave the server: publicUser() / customerList() strip them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ordersStore = require('./orders-store');

const REPO_FILE = 'users.json';
const PENDING_KEY = '__users__';

function filePath() {
  return process.env.USERS_FILE || path.join(__dirname, '..', 'data', 'users.json');
}

function clean(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (!u || typeof u !== 'object' || !u.id || !u.email || typeof u.passwordHash !== 'string') continue;
    const email = normalizeEmail(u.email);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      id: String(u.id),
      email,
      name: String(u.name || '').trim() || email.split('@')[0],
      passwordHash: u.passwordHash,
      createdAt: u.createdAt || null,
    });
  }
  return out;
}

let cache = null;

function loadUsers() {
  if (!cache) {
    try { cache = clean(JSON.parse(fs.readFileSync(filePath(), 'utf8'))); } catch { cache = []; }
  }
  return cache;
}

function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(loadUsers(), null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Could not write local users file:', err.message);
  }
}

// "Retry saving now" in the admin also retries users.json if a save to the repo failed.
ordersStore.registerFile(PENDING_KEY, REPO_FILE, () => loadUsers(), 'customer accounts');

let lastSave = Promise.resolve({ github: false });
/**
 * Save: local copy straight away, then a serialised commit to the private repo (the orders
 * store's queue fetches a fresh sha for every write, so two sign-ups never overwrite each other;
 * the commit always contains the full, current in-memory list).
 */
function save(message) {
  writeLocal();
  lastSave = ordersStore.pushFile(REPO_FILE, loadUsers(), message, PENDING_KEY);
  return lastSave;
}
/** Resolves when the latest save has finished (used by the register route and tests). */
function whenSaved() {
  return lastSave;
}

function reset() {
  cache = null;
  lastSave = Promise.resolve({ github: false });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function register(email, password, name) {
  const e = normalizeEmail(email);
  if (!e || !e.includes('@')) {
    return { ok: false, error: 'Enter a valid email address' };
  }
  if (!password || String(password).length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }
  const users = loadUsers();
  if (users.some((u) => u.email === e)) {
    return { ok: false, error: 'An account with that email already exists' };
  }
  const user = {
    id: crypto.randomUUID(),
    email: e,
    name: String(name || '').trim().slice(0, 80) || e.split('@')[0],
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(user); // in-memory change is synchronous, so concurrent sign-ups can't lose each other
  save(`new customer account ${user.id}`);
  return { ok: true, user: publicUser(user) };
}

function login(email, password) {
  const e = normalizeEmail(email);
  const user = loadUsers().find((u) => u.email === e);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { ok: false, error: 'Invalid email or password' };
  }
  return { ok: true, user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function findById(id) {
  const user = loadUsers().find((u) => u.id === id);
  return user ? publicUser(user) : null;
}

/** Admin "Customers": id, name, email, createdAt only (never the password hash). */
function customerList() {
  return loadUsers().map((u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt || null }));
}

/**
 * Startup: load users.json from the private repo and merge with the local copy by id
 * (accounts created locally and not pushed yet are kept, then pushed).
 */
async function pullFromGitHub() {
  const remote = await ordersStore.pullFile(REPO_FILE);
  if (!remote) return false;
  const merged = clean(remote);
  const ids = new Set(merged.map((u) => u.id));
  const emails = new Set(merged.map((u) => u.email));
  const localOnly = loadUsers().filter((u) => !ids.has(u.id) && !emails.has(u.email));
  cache = clean([...merged, ...localOnly]);
  if (localOnly.length) save(`customer accounts: ${localOnly.length} added while offline`);
  else writeLocal();
  return true;
}

module.exports = {
  REPO_FILE,
  register,
  login,
  findById,
  publicUser,
  customerList,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  pullFromGitHub,
  whenSaved,
  reset,
  filePath,
};
