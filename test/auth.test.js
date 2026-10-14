const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate users file by pointing auth at a temp copy via monkeypatch is heavy;
// instead test hash helpers and register against data/users.json carefully.

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
