'use strict';
// TOTP (RFC 6238) helpers for admin 2FA: 6 digits, 30-second steps, ±1 step of clock drift.
// Backup codes are random 8-character codes (shown as XXXX-XXXX) and stored as scrypt hashes.
const crypto = require('crypto');
const { generateSecret, generateURI, verifySync } = require('otplib');
const auth = require('./auth');

const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = 'sha1';
const EPOCH_TOLERANCE = PERIOD; // ±1 step
const BACKUP_COUNT = 10;
const BACKUP_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function newSecret() {
  return generateSecret();
}

function otpauthUrl(secret, { issuer = 'Po-ke Mart Fun', account = 'admin' } = {}) {
  return generateURI({
    issuer,
    label: account,
    secret,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
  });
}

function normaliseCode(token) {
  return String(token || '').replace(/\s+/g, '');
}

/**
 * Verify a 6-digit TOTP code. `lastTimeStep` (if set) rejects reuse of that step or an earlier one.
 * `now` is unix seconds (optional, for tests).
 */
function verify(secret, token, { lastTimeStep = null, now = null } = {}) {
  const code = normaliseCode(token);
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code from your authenticator app' };
  if (!secret) return { ok: false, error: 'Two-factor login is not set up' };
  const opts = {
    secret,
    token: code,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    epochTolerance: EPOCH_TOLERANCE,
  };
  if (now != null) opts.epoch = now;
  let result;
  try {
    result = verifySync(opts);
  } catch {
    return { ok: false, error: 'Enter the 6-digit code from your authenticator app' };
  }
  if (!result || !result.valid) return { ok: false, error: 'Wrong or expired code' };
  if (lastTimeStep != null && Number.isFinite(lastTimeStep) && result.timeStep <= lastTimeStep) {
    return { ok: false, error: 'That code has already been used. Wait for the next one.' };
  }
  return { ok: true, timeStep: result.timeStep };
}

function generateBackupCodes(count = BACKUP_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let raw = '';
    for (let j = 0; j < 8; j++) raw += BACKUP_CHARS[bytes[j] % BACKUP_CHARS.length];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

function normaliseBackup(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashBackup(code) {
  return auth.hashPassword(normaliseBackup(code));
}

function backupMatches(code, storedHash) {
  const norm = normaliseBackup(code);
  if (norm.length !== 8) return false;
  return auth.verifyPassword(norm, storedHash);
}

/** Find and drop the first matching unused hash. Returns { ok, hashes } or { ok: false, error }. */
function consumeBackup(code, hashes) {
  const list = Array.isArray(hashes) ? hashes.slice() : [];
  const norm = normaliseBackup(code);
  if (norm.length !== 8) return { ok: false, error: 'Enter one of your backup codes (eight characters)' };
  for (let i = 0; i < list.length; i++) {
    if (backupMatches(norm, list[i])) {
      list.splice(i, 1);
      return { ok: true, hashes: list };
    }
  }
  return { ok: false, error: 'That backup code is not valid, or it has already been used' };
}

module.exports = {
  DIGITS,
  PERIOD,
  ALGORITHM,
  EPOCH_TOLERANCE,
  BACKUP_COUNT,
  safeEqual,
  newSecret,
  otpauthUrl,
  verify,
  generateBackupCodes,
  normaliseBackup,
  hashBackup,
  backupMatches,
  consumeBackup,
};
