const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Users go to a temp file (USERS_FILE), never data/users.json; no private repo in this test.
process.env.USERS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-auth-')), 'users.json');
delete process.env.ORDERS_GITHUB_REPO;

const auth = require('../server/auth');

describe('auth', () => {
  it('hashes and verifies passwords', () => {
    const stored = auth.hashPassword('secretpass');
    assert.equal(auth.verifyPassword('secretpass', stored), true);
    assert.equal(auth.verifyPassword('wrong', stored), false);
  });

  it('registers and logs in a unique user', () => {
    const email = `test_${Date.now()}@example.com`;
    const reg = auth.register(email, 'password123', 'Tester');
    assert.equal(reg.ok, true);
    assert.equal(reg.user.email, email);
    const login = auth.login(email, 'password123');
    assert.equal(login.ok, true);
    const bad = auth.login(email, 'nope');
    assert.equal(bad.ok, false);
  });
});
