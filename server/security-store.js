'use strict';
// Admin two-factor login settings. The TOTP secret and hashed backup codes live in
// security.json in the PRIVATE orders repo (ORDERS_GITHUB_REPO), with a local copy
// (SECURITY_FILE or data/security.json) as the cache and as the fallback in demo mode.
// This file must never be committed to the public shop repo.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const ordersStore = require('./orders-store');
const settings = require('./settings-store');
const totp = require('./totp');

const REPO_FILE = 'security.json';
const PENDING_KEY = '__security__';
const SETUP_TTL_MS = 15 * 60 * 1000;

function filePath() {
  return process.env.SECURITY_FILE || path.join(__dirname, '..', 'data', 'security.json');
}

const EMPTY = () => ({
  enabled: false,
  secret: null,
  lastTimeStep: null,
  backupHashes: [],
  resetNotice: false,
  updatedAt: null,
});

function clean(data) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const hashes = Array.isArray(d.backupHashes) ? d.backupHashes.filter((h) => typeof h === 'string' && h.includes(':')) : [];
  const step = Number(d.lastTimeStep);
  return {
    enabled: d.enabled === true && Boolean(d.secret),
    secret: typeof d.secret === 'string' && d.secret ? d.secret : null,
    lastTimeStep: Number.isFinite(step) ? step : null,
    backupHashes: hashes,
    resetNotice: d.resetNotice === true,
    updatedAt: d.updatedAt || null,
  };
}

let cache = null;
const pendingSetups = new Map(); // adminToken -> { secret, expires }
let resetLogged = false;

function get() {
  if (!cache) {
    try { cache = clean(JSON.parse(fs.readFileSync(filePath(), 'utf8'))); } catch { cache = EMPTY(); }
  }
  return cache;
}

function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(get(), null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Could not write local security file:', err.message);
  }
}

ordersStore.registerFile(PENDING_KEY, REPO_FILE, () => get(), 'admin 2FA settings');

async function save(message) {
  get().updatedAt = new Date().toISOString();
  writeLocal();
  return ordersStore.pushFile(REPO_FILE, get(), message, PENDING_KEY);
}

function reset() {
  cache = null;
  pendingSetups.clear();
  resetLogged = false;
}

function isResetVarSet() {
  const v = String(process.env.ADMIN_2FA_RESET || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'on';
}

/**
 * If ADMIN_2FA_RESET is set (yes/true/1/on), switch 2FA off and wipe the secret
 * and backup codes. Logs a warning with no secrets in it. While the variable
 * stays set, 2FA cannot be turned back on.
 */
async function applyEmergencyReset() {
  if (!isResetVarSet()) return { applied: false };
  const s = get();
  const alreadyClean = !s.enabled && !s.secret && s.backupHashes.length === 0 && s.lastTimeStep == null;
  if (!alreadyClean) {
    cache = { ...EMPTY(), resetNotice: true, updatedAt: new Date().toISOString() };
    await save('2FA emergency reset');
  } else if (!s.resetNotice) {
    s.resetNotice = true;
    await save('2FA emergency reset notice');
  }
  if (!resetLogged) {
    resetLogged = true;
    console.warn('ADMIN_2FA_RESET is set: two-factor login has been switched off and the authenticator secret and backup codes have been wiped. Remove ADMIN_2FA_RESET from Render, restart, and set 2FA up again on the admin page.');
  }
  return { applied: !alreadyClean, reset: true };
}

function publicStatus() {
  const s = get();
  return {
    enabled: s.enabled === true,
    backupCodesRemaining: s.backupHashes.length,
    resetNotice: s.resetNotice === true,
    resetVarSet: isResetVarSet(),
  };
}

function issuerName() {
  try {
    const name = settings.get().shop_name;
    return (name && String(name).trim()) || 'Po-ke Mart Fun';
  } catch {
    return 'Po-ke Mart Fun';
  }
}

async function startSetup(adminToken) {
  if (isResetVarSet()) {
    return { error: '2FA cannot be turned on while ADMIN_2FA_RESET is still set. Remove that variable from Render and restart first.', status: 400 };
  }
  const secret = totp.newSecret();
  pendingSetups.set(adminToken, { secret, expires: Date.now() + SETUP_TTL_MS });
  const issuer = issuerName();
  const account = 'admin';
  const otpauth = totp.otpauthUrl(secret, { issuer, account });
  const qrDataUrl = await QRCode.toDataURL(otpauth, {
    width: 240,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
  return { ok: true, secret, qrDataUrl, issuer, account };
}

async function confirmSetup(adminToken, code) {
  if (isResetVarSet()) {
    pendingSetups.delete(adminToken);
    return { error: '2FA cannot be turned on while ADMIN_2FA_RESET is still set. Remove that variable from Render and restart first.', status: 400 };
  }
  const pending = pendingSetups.get(adminToken);
  if (!pending || pending.expires < Date.now()) {
    pendingSetups.delete(adminToken);
    return { error: 'The setup expired. Click Turn on 2FA again and scan a new QR code.', status: 400 };
  }
  const v = totp.verify(pending.secret, code);
  if (!v.ok) return { error: v.error, status: 400 };
  const plain = totp.generateBackupCodes();
  cache = {
    enabled: true,
    secret: pending.secret,
    lastTimeStep: v.timeStep,
    backupHashes: plain.map(totp.hashBackup),
    resetNotice: false,
    updatedAt: new Date().toISOString(),
  };
  pendingSetups.delete(adminToken);
  const sync = await save('enable two-factor login');
  return { ok: true, backupCodes: plain, ...sync };
}

async function verifyLoginTotp(code) {
  const s = get();
  if (!s.enabled || !s.secret) return { ok: false, error: 'Two-factor login is not turned on' };
  const v = totp.verify(s.secret, code, { lastTimeStep: s.lastTimeStep });
  if (!v.ok) return v;
  s.lastTimeStep = v.timeStep;
  await save('2FA sign-in');
  return { ok: true };
}

async function consumeBackupCode(code) {
  const s = get();
  if (!s.enabled) return { ok: false, error: 'Two-factor login is not turned on' };
  const r = totp.consumeBackup(code, s.backupHashes);
  if (!r.ok) return r;
  s.backupHashes = r.hashes;
  await save('2FA backup code used');
  return { ok: true, remaining: s.backupHashes.length };
}

async function regenerateBackupCodes(code) {
  if (isResetVarSet()) return { error: '2FA is switched off because ADMIN_2FA_RESET is set.', status: 400 };
  const s = get();
  if (!s.enabled || !s.secret) return { error: 'Turn on two-factor login first', status: 400 };
  const v = totp.verify(s.secret, code, { lastTimeStep: s.lastTimeStep });
  if (!v.ok) return { error: v.error, status: 401 };
  s.lastTimeStep = v.timeStep;
  const plain = totp.generateBackupCodes();
  s.backupHashes = plain.map(totp.hashBackup);
  const sync = await save('regenerate 2FA backup codes');
  return { ok: true, backupCodes: plain, ...sync };
}

async function disable({ password, code, backupCode }) {
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!pw || !totp.safeEqual(password || '', pw)) return { error: 'Wrong password', status: 401 };
  const s = get();
  if (!s.enabled) return { error: 'Two-factor login is already off', status: 400 };
  if (backupCode) {
    const r = totp.consumeBackup(backupCode, s.backupHashes);
    if (!r.ok) return { error: r.error, status: 401 };
  } else {
    const v = totp.verify(s.secret, code, { lastTimeStep: s.lastTimeStep });
    if (!v.ok) return { error: v.error, status: 401 };
  }
  cache = { ...EMPTY(), updatedAt: new Date().toISOString() };
  pendingSetups.clear();
  const sync = await save('disable two-factor login');
  return { ok: true, ...sync };
}

/** Load security.json from the private repo (startup). Local unsaved changes win. */
async function pullFromGitHub() {
  const remote = await ordersStore.pullFile(REPO_FILE);
  if (!remote) {
    await applyEmergencyReset();
    return false;
  }
  const r = clean(remote);
  if (ordersStore.status().pending && cache) {
    // keep the in-memory (not-yet-pushed) copy
  } else {
    cache = r;
  }
  writeLocal();
  await applyEmergencyReset();
  return true;
}

module.exports = {
  REPO_FILE,
  get,
  reset,
  save,
  publicStatus,
  isResetVarSet,
  applyEmergencyReset,
  startSetup,
  confirmSetup,
  verifyLoginTotp,
  consumeBackupCode,
  regenerateBackupCodes,
  disable,
  pullFromGitHub,
  filePath,
};
