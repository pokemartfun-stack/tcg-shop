'use strict';
// paymentMode(): test vs live vs none. Dummy key strings only — never real secrets.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { paymentMode } = require('../server/payments');

const TEST_PK = 'pk_test_dummy_publishable_key_for_unit_tests';
const TEST_SK = 'sk_test_dummy_secret_key_for_unit_tests';
const LIVE_PK = 'pk_live_dummy_publishable_key_for_unit_tests';
const LIVE_SK = 'sk_live_dummy_secret_key_for_unit_tests';

describe('paymentMode', () => {
  it('none: no keys means demo, and stripeMode is null (not live)', () => {
    const mode = paymentMode({});
    assert.equal(mode.demo, true);
    assert.equal(mode.stripe, false);
    assert.equal(mode.paypal, false);
    assert.equal(mode.stripeMode, null);
  });

  it('none: only one Stripe key still counts as not configured', () => {
    assert.equal(paymentMode({ STRIPE_PUBLISHABLE_KEY: TEST_PK }).stripeMode, null);
    assert.equal(paymentMode({ STRIPE_SECRET_KEY: TEST_SK }).stripeMode, null);
    assert.equal(paymentMode({ STRIPE_PUBLISHABLE_KEY: TEST_PK }).demo, true);
  });

  it('test: pk_test_ and sk_test_ set stripeMode to test', () => {
    const mode = paymentMode({
      STRIPE_PUBLISHABLE_KEY: TEST_PK,
      STRIPE_SECRET_KEY: TEST_SK,
    });
    assert.equal(mode.demo, false);
    assert.equal(mode.stripe, true);
    assert.equal(mode.stripeMode, 'test');
    assert.notEqual(mode.stripeMode, 'live');
  });

  it('test: a pk_test_ key with a non-test secret is still test', () => {
    const mode = paymentMode({
      STRIPE_PUBLISHABLE_KEY: TEST_PK,
      STRIPE_SECRET_KEY: LIVE_SK,
    });
    assert.equal(mode.stripe, true);
    assert.equal(mode.stripeMode, 'test');
  });

  it('test: a sk_test_ key with a pk_live_ publishable key is still test', () => {
    const mode = paymentMode({
      STRIPE_PUBLISHABLE_KEY: LIVE_PK,
      STRIPE_SECRET_KEY: TEST_SK,
    });
    assert.equal(mode.stripe, true);
    assert.equal(mode.stripeMode, 'test');
  });

  it('test: unknown key prefixes are not treated as live', () => {
    const mode = paymentMode({
      STRIPE_PUBLISHABLE_KEY: 'pk_unknown_dummy_for_unit_tests',
      STRIPE_SECRET_KEY: 'sk_unknown_dummy_for_unit_tests',
    });
    assert.equal(mode.stripe, true);
    assert.equal(mode.stripeMode, 'test');
  });

  it('live: only a pk_live_ key (with no test secret) is live', () => {
    const mode = paymentMode({
      STRIPE_PUBLISHABLE_KEY: LIVE_PK,
      STRIPE_SECRET_KEY: LIVE_SK,
    });
    assert.equal(mode.demo, false);
    assert.equal(mode.stripe, true);
    assert.equal(mode.stripeMode, 'live');
  });

  it('live: PayPal alone does not set stripeMode to live', () => {
    const mode = paymentMode({ PAYPAL_CLIENT_ID: 'paypal_dummy_client_id' });
    assert.equal(mode.demo, false);
    assert.equal(mode.stripe, false);
    assert.equal(mode.paypal, true);
    assert.equal(mode.stripeMode, null);
  });
});
