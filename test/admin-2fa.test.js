'use strict';
// Two-factor admin login: TOTP, drift, replay, backup codes, emergency reset, and the login flow.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateSync } = require('otplib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-2fa-'));
const P = (f) => path.join(tmpDir, f);
fs.writeFileSync(P('products.json'), JSON.stringify([
  { id: '2fa-card', title: '2FA test card', price_gbp: 4, stock: 5, condition: 'Near mint', category: 'Trading cards', image: '/images/tauros-ar.svg' },
]));
process.env.PRODUCTS_FILE = P('products.json');
process.env.SETTINGS_FILE = P('settings.json');
process.env.ORDERS_FILE = P('orders.json');
process.env.COSTS_FILE = P('costs.json');
process.env.SECURITY_FILE = P('security.json');
process.env.ADMIN_PASSWORD = 'owner-secret';
delete process.env.ADMIN_2FA_RESET;
delete process.env.GITHUB_TOKEN;
delete process.env.ORDERS_GITHUB_REPO;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PUBLISHABLE_KEY;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.BASE_URL;
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;

const totp = require('../server/totp');
const security = require('../server/security-store');
const app = require('../server/index');
const admin = require('../server/admin');

function codeAt(secret, offsetSec = 0, now = Math.floor(Date.now() / 1000)) {
  return generateSync({
    secret,
    epoch: now + offsetSec,
    period: 30,
    digits: 6,
    algorithm: 'sha1',
  });
}

let server, base;
before(async () => {
  security.reset();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.admin) headers.Authorization = `Bearer ${opts.admin}`;
  if (opts.ip) headers['X-Forwarded-For'] = opts.ip;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const cookie = res.headers.get('set-cookie') || '';
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers, cookie };
}

function resetAuth() {
  admin._resetLoginAttempts();
  admin._resetPendingLogins();
}

describe('TOTP verification', () => {
  it('accepts a current 6-digit code and rejects a wrong one', () => {
    const secret = totp.newSecret();
    const now = 1_700_000_000; // fixed unix time so the test is stable
    const token = codeAt(secret, 0, now);
    const ok = totp.verify(secret, token, { now });
    assert.equal(ok.ok, true);
    assert.equal(typeof ok.timeStep, 'number');
    const bad = totp.verify(secret, '000000', { now });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /wrong or expired/i);
  });

  it('accepts a code from the previous or next 30-second step (clock drift)', () => {
    const secret = totp.newSecret();
    const now = 1_700_000_015;
    const prev = codeAt(secret, -30, now);
    const next = codeAt(secret, 30, now);
    assert.equal(totp.verify(secret, prev, { now }).ok, true);
    assert.equal(totp.verify(secret, next, { now }).ok, true);
    const far = codeAt(secret, -90, now);
    assert.equal(totp.verify(secret, far, { now }).ok, false);
  });

  it('rejects reuse of the same code within its window', () => {
    const secret = totp.newSecret();
    const now = 1_700_000_000;
    const token = codeAt(secret, 0, now);
    const first = totp.verify(secret, token, { now });
    assert.equal(first.ok, true);
    const replay = totp.verify(secret, token, { now, lastTimeStep: first.timeStep });
    assert.equal(replay.ok, false);
    assert.match(replay.error, /already been used/i);
  });

  it('ignores spaces in a typed code and refuses non-6-digit input', () => {
    const secret = totp.newSecret();
    const now = 1_700_000_000;
    const token = codeAt(secret, 0, now);
    assert.equal(totp.verify(secret, token.slice(0, 3) + ' ' + token.slice(3), { now }).ok, true);
    assert.equal(totp.verify(secret, '12', { now }).ok, false);
  });
});

describe('backup codes', () => {
  it('generates 10 codes, accepts one, and then refuses that same code', () => {
    const codes = totp.generateBackupCodes();
    assert.equal(codes.length, 10);
    for (const c of codes) assert.match(c, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const unique = new Set(codes);
    assert.equal(unique.size, 10);
    let hashes = codes.map(totp.hashBackup);
    const first = totp.consumeBackup(codes[0].toLowerCase(), hashes); // dashes / case should not matter
    assert.equal(first.ok, true);
    assert.equal(first.hashes.length, 9);
    const again = totp.consumeBackup(codes[0], first.hashes);
    assert.equal(again.ok, false);
    const other = totp.consumeBackup(codes[3], first.hashes);
    assert.equal(other.ok, true);
    assert.equal(other.hashes.length, 8);
  });
});

describe('emergency reset env var', () => {
  afterEach(() => {
    delete process.env.ADMIN_2FA_RESET;
    security.reset();
    fs.writeFileSync(P('security.json'), '{}\n');
  });

  it('wipes the secret and backup codes, leaves 2FA off, and logs a warning with no secrets', async () => {
    const secret = totp.newSecret();
    const hashes = totp.generateBackupCodes().map(totp.hashBackup);
    fs.writeFileSync(P('security.json'), JSON.stringify({
      enabled: true, secret, lastTimeStep: 99, backupHashes: hashes, resetNotice: false,
    }, null, 2));
    security.reset();
    process.env.ADMIN_2FA_RESET = 'yes';

    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const spy = (...args) => { logs.push(args.map(String).join(' ')); };
    console.log = spy; console.error = spy; console.warn = spy; console.info = spy;
    let result;
    try {
      result = await security.applyEmergencyReset();
    } finally {
      Object.assign(console, orig);
    }
    assert.equal(result.applied, true);
    const st = security.publicStatus();
    assert.equal(st.enabled, false);
    assert.equal(st.backupCodesRemaining, 0);
    assert.equal(st.resetNotice, true);
    assert.equal(st.resetVarSet, true);
    const saved = JSON.parse(fs.readFileSync(P('security.json'), 'utf8'));
    assert.equal(saved.secret, null);
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.backupHashes, []);
    assert.ok(logs.some((line) => /ADMIN_2FA_RESET/i.test(line)), `expected a warning, got: ${logs.join(' | ')}`);
    assert.ok(!logs.some((line) => line.includes(secret)), 'secret leaked in logs');
  });

  it('keeps 2FA off while the variable stays set, so setup is refused', async () => {
    process.env.ADMIN_2FA_RESET = 'yes';
    security.reset();
    await security.applyEmergencyReset();
    const start = await security.startSetup('test-token');
    assert.ok(start.error);
    assert.match(start.error, /ADMIN_2FA_RESET/);
  });
});

describe('admin login with 2FA', () => {
  beforeEach(() => {
    delete process.env.ADMIN_2FA_RESET;
    resetAuth();
    fs.writeFileSync(P('security.json'), '{}\n');
    security.reset();
  });
  afterEach(() => {
    delete process.env.ADMIN_2FA_RESET;
    resetAuth();
    fs.writeFileSync(P('security.json'), '{}\n');
    security.reset();
  });

  async function enable2fa() {
    const login = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.40' });
    assert.equal(login.status, 200);
    assert.ok(login.data.token);
    const setup = await call('POST', '/api/admin/security/2fa/setup', {}, { admin: login.data.token });
    assert.equal(setup.status, 200);
    assert.ok(setup.data.secret);
    assert.match(setup.data.qrDataUrl, /^data:image\/png;base64,/);
    const now = Math.floor(Date.now() / 1000);
    const confirm = await call('POST', '/api/admin/security/2fa/confirm', { code: codeAt(setup.data.secret, 0, now) }, { admin: login.data.token });
    assert.equal(confirm.status, 200, confirm.data && confirm.data.error);
    assert.equal((confirm.data.backupCodes || []).length, 10);
    return { token: login.data.token, secret: setup.data.secret, backupCodes: confirm.data.backupCodes, confirmTime: now };
  }

  it('signs in with only the password when 2FA is not set up, and has no 2FA cookie side effects', async () => {
    const r = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.41' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.needs2fa, undefined);
    assert.ok(r.data.token);
    assert.match(r.cookie, /admin=/);
    const products = await call('GET', '/api/admin/products', null, { admin: r.data.token });
    assert.equal(products.status, 200);
  });

  it('asks for a 6-digit code after the password once 2FA is on, and rejects a reused or wrong code', async () => {
    const { secret } = await enable2fa();
    resetAuth();
    const step1 = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.42' });
    assert.equal(step1.status, 200);
    assert.equal(step1.data.needs2fa, true);
    assert.ok(step1.data.pending);
    assert.equal(step1.data.token, undefined);
    assert.doesNotMatch(step1.cookie || '', /admin=/);

    const blocked = await call('GET', '/api/admin/products', null, { admin: step1.data.pending });
    assert.equal(blocked.status, 401);

    const wrong = await call('POST', '/api/admin/login/2fa', { pending: step1.data.pending, code: '000000' }, { ip: '198.51.100.42' });
    assert.equal(wrong.status, 401);

    // Confirm used the current step, so a code from the next step should succeed.
    const next = codeAt(secret, 30);
    const ok = await call('POST', '/api/admin/login/2fa', { pending: step1.data.pending, code: next }, { ip: '198.51.100.42' });
    assert.equal(ok.status, 200, ok.data && ok.data.error);
    assert.ok(ok.data.token);
    assert.match(ok.cookie, /admin=/);

    // New password step, then try the same next-step code again (replay).
    const step1b = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.42' });
    assert.equal(step1b.status, 200);
    const replay = await call('POST', '/api/admin/login/2fa', { pending: step1b.data.pending, code: next }, { ip: '198.51.100.42' });
    assert.equal(replay.status, 401);
    assert.match(replay.data.error, /already been used|wrong or expired/i);
  });

  it('lets the owner sign in with a backup code once, then refuses that code', async () => {
    const { backupCodes } = await enable2fa();
    resetAuth();
    const step1 = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.43' });
    const used = backupCodes[0];
    const ok = await call('POST', '/api/admin/login/2fa', { pending: step1.data.pending, backupCode: used.toLowerCase() }, { ip: '198.51.100.43' });
    assert.equal(ok.status, 200, ok.data && ok.data.error);
    assert.ok(ok.data.token);
    const st = await call('GET', '/api/admin/security', null, { admin: ok.data.token });
    assert.equal(st.data.backupCodesRemaining, 9);

    const step1b = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.43' });
    const again = await call('POST', '/api/admin/login/2fa', { pending: step1b.data.pending, backupCode: used }, { ip: '198.51.100.43' });
    assert.equal(again.status, 401);
  });

  it('keeps the 5-fail-per-15-min limit across the password and code steps', async () => {
    const { secret } = await enable2fa();
    resetAuth();
    const ip = '198.51.100.44';
    for (let i = 0; i < 2; i++) {
      assert.equal((await call('POST', '/api/admin/login', { password: 'nope' }, { ip })).status, 401);
    }
    const step1 = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip });
    assert.equal(step1.status, 200);
    assert.equal(step1.data.needs2fa, true);
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/api/admin/login/2fa', { pending: step1.data.pending, code: '000000' }, { ip });
      assert.equal(r.status, 401, `code fail ${i + 1}`);
    }
    const blocked = await call('POST', '/api/admin/login/2fa', { pending: step1.data.pending, code: codeAt(secret, 30) }, { ip });
    assert.equal(blocked.status, 429);
    const blockedPw = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip });
    assert.equal(blockedPw.status, 429);
  });

  it('turns 2FA off with the password plus a current code', async () => {
    const { token, secret } = await enable2fa();
    const off = await call('POST', '/api/admin/security/2fa/disable', {
      password: 'owner-secret',
      code: codeAt(secret, 30),
    }, { admin: token, ip: '198.51.100.45' });
    assert.equal(off.status, 200, off.data && off.data.error);
    const st = await call('GET', '/api/admin/security', null, { admin: token });
    assert.equal(st.data.enabled, false);
    resetAuth();
    const login = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.45' });
    assert.equal(login.status, 200);
    assert.ok(login.data.token);
    assert.equal(login.data.needs2fa, undefined);
  });

  it('never logs a TOTP code or backup code', async () => {
    const { secret, backupCodes } = await enable2fa();
    resetAuth();
    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const spy = (...args) => { logs.push(args.map(String).join(' ')); };
    console.log = spy; console.error = spy; console.warn = spy; console.info = spy;
    try {
      const step1 = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.46' });
      const token = codeAt(secret, 30);
      await call('POST', '/api/admin/login/2fa', { pending: step1.data.pending, code: token }, { ip: '198.51.100.46' });
      const step1b = await call('POST', '/api/admin/login', { password: 'owner-secret' }, { ip: '198.51.100.47' });
      await call('POST', '/api/admin/login/2fa', { pending: step1b.data.pending, backupCode: backupCodes[1] }, { ip: '198.51.100.47' });
      assert.ok(!logs.some((line) => line.includes(token)), `TOTP leaked: ${logs.join(' | ')}`);
      assert.ok(!logs.some((line) => line.includes(backupCodes[1])), `backup code leaked: ${logs.join(' | ')}`);
      assert.ok(!logs.some((line) => line.includes(secret)), `secret leaked: ${logs.join(' | ')}`);
    } finally {
      Object.assign(console, orig);
    }
  });
});
