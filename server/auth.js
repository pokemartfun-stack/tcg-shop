/**
 * Simple local auth: JSON user store + scrypt password hashes.
 * Guest checkout needs no account.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_PATH = path.join(__dirname, '..', 'data', 'users.json');

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_PATH)) {
      fs.writeFileSync(USERS_PATH, '[]', 'utf8');
    }
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
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
    name: String(name || '').trim() || e.split('@')[0],
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return { ok: true, user: publicUser(user) };
}

function login(email, password) {
  const e = normalizeEmail(email);
  const users = loadUsers();
  const user = users.find((u) => u.email === e);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { ok: false, error: 'Invalid email or password' };
  }
  return { ok: true, user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function findById(id) {
  const users = loadUsers();
  const user = users.find((u) => u.id === id);
  return user ? publicUser(user) : null;
}

module.exports = {
  register,
  login,
  findById,
  publicUser,
  hashPassword,
  verifyPassword,
};
