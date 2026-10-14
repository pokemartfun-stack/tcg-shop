const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('products seed', () => {
  it('has 4–6 products with required fields', () => {
    const products = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'data', 'products.json'), 'utf8')
    );
    assert.ok(products.length >= 4 && products.length <= 6);
    for (const p of products) {
      assert.ok(p.id && p.title);
      assert.equal(typeof p.price_gbp, 'number');
      assert.ok(p.condition);
      assert.ok(p.image);
      assert.ok(p.stock >= 0);
    }
  });
});
