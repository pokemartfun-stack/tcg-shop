'use strict';
// Admin 2FA HTTP routes, mounted from server/admin.js.
// Login step 2 is public (pending token). Setup / disable require a full admin session.
const crypto = require('crypto');
const security = require('./security-store');

const PENDING = new Map(); // pending token -> { exp }
const PENDING_TTL_MS = 5 * 60 * 1000;

function prunePending(now = Date.now()) {
  for (const [k, v] of PENDING) if (v.exp <= now) PENDING.delete(k);
}

function issuePending() {
  prunePending();
  const token = crypto.randomBytes(24).toString('hex');
  PENDING.set(token, { exp: Date.now() + PENDING_TTL_MS });
  return token;
}

function takePending(token) {
  prunePending();
  const entry = token && PENDING.get(token);
  if (!entry) return false;
  PENDING.delete(token);
  return true;
}

function peekPending(token) {
  prunePending();
  return Boolean(token && PENDING.get(token));
}

function resetPending() {
  PENDING.clear();
}

function afterPassword(req, res, issueSession) {
  // 2FA is off (or was just emergency-reset): full session, same as today.
  if (!security.get().enabled) {
    return issueSession(req, res);
  }
  const pending = issuePending();
  res.json({ ok: true, needs2fa: true, pending });
}

function mountLogin(router, { issueSession, loginLimited, recordLoginFailure }) {
  router.post('/login/2fa', async (req, res) => {
    const limited = loginLimited(req);
    if (limited) {
      const secs = Math.max(1, Math.ceil((limited.until - Date.now()) / 1000));
      res.setHeader('Retry-After', String(secs));
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again in 15 minutes.' });
    }
    const pending = req.body && req.body.pending;
    if (!peekPending(pending)) {
      return res.status(401).json({ error: 'That sign-in step expired. Enter your password again.' });
    }
    if (!security.get().enabled) {
      takePending(pending);
      return res.status(400).json({ error: 'Two-factor login is not turned on. Enter your password again.' });
    }
    const backup = req.body && req.body.backupCode;
    const code = req.body && req.body.code;
    let result;
    try {
      result = backup
        ? await security.consumeBackupCode(backup)
        : await security.verifyLoginTotp(code);
    } catch (err) {
      console.error('2FA verify failed:', err.message);
      return res.status(500).json({ error: 'Could not check the code. Please try again.' });
    }
    if (!result.ok) {
      recordLoginFailure(req);
      return res.status(401).json({ error: result.error });
    }
    takePending(pending);
    issueSession(req, res);
  });
}

function mountSecurity(router, { tokenFrom, loginLimited, recordLoginFailure, clearLoginFailures }) {
  router.get('/security', async (_req, res) => {
    await security.applyEmergencyReset();
    res.json(security.publicStatus());
  });

  router.post('/security/2fa/setup', async (req, res) => {
    await security.applyEmergencyReset();
    const r = await security.startSetup(tokenFrom(req));
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json({
      ok: true,
      secret: r.secret,
      qrDataUrl: r.qrDataUrl,
      issuer: r.issuer,
      account: r.account,
    });
  });

  router.post('/security/2fa/confirm', async (req, res) => {
    const code = req.body && req.body.code;
    const r = await security.confirmSetup(tokenFrom(req), code);
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, backupCodes: r.backupCodes, github: r.github, githubError: r.githubError });
  });

  router.post('/security/2fa/backup-codes', async (req, res) => {
    const limited = loginLimited(req);
    if (limited) {
      const secs = Math.max(1, Math.ceil((limited.until - Date.now()) / 1000));
      res.setHeader('Retry-After', String(secs));
      return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
    }
    const r = await security.regenerateBackupCodes(req.body && req.body.code);
    if (r.error) {
      if ((r.status || 400) === 401) recordLoginFailure(req);
      return res.status(r.status || 400).json({ error: r.error });
    }
    clearLoginFailures(req);
    res.json({ ok: true, backupCodes: r.backupCodes, github: r.github, githubError: r.githubError });
  });

  router.post('/security/2fa/disable', async (req, res) => {
    const limited = loginLimited(req);
    if (limited) {
      const secs = Math.max(1, Math.ceil((limited.until - Date.now()) / 1000));
      res.setHeader('Retry-After', String(secs));
      return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
    }
    const body = req.body || {};
    const r = await security.disable({ password: body.password, code: body.code, backupCode: body.backupCode });
    if (r.error) {
      if ((r.status || 400) === 401) recordLoginFailure(req);
      return res.status(r.status || 400).json({ error: r.error });
    }
    clearLoginFailures(req);
    res.json({ ok: true, github: r.github, githubError: r.githubError });
  });
}

module.exports = { mountLogin, mountSecurity, afterPassword, resetPending, _pending: PENDING };
