const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyCart,
  addToCart,
  setQty,
  removeFromCart,
  cartSubtotal,
  enrichCart,
} = require('../server/cart');

const products = [
  { id: 'a', title: 'A', price_gbp: 2.5, stock: 5, condition: 'NM', image: '/a.svg' },
  { id: 'b', title: 'B', price_gbp: 10, stock: 1, condition: 'NM', image: '/b.svg' },
];

describe('cart', () => {
  it('adds items and computes subtotal', () => {
    let cart = emptyCart();
    let r = addToCart(cart, products, 'a', 2);
    assert.equal(r.ok, true);
    r = addToCart(cart, products, 'b', 1);
    assert.equal(r.ok, true);
    assert.equal(cartSubtotal(cart, products), 15);
    const enriched = enrichCart(cart, products);
    assert.equal(enriched.count, 3);
    assert.equal(enriched.subtotal, 15);
  });

  it('rejects overstock', () => {
    const cart = emptyCart();
    const r = addToCart(cart, products, 'b', 2);
    assert.equal(r.ok, false);
  });

  it('updates qty and removes', () => {
    const cart = emptyCart();
    addToCart(cart, products, 'a', 1);
    setQty(cart, products, 'a', 3);
    assert.equal(cart.items[0].qty, 3);
    removeFromCart(cart, 'a');
    assert.equal(cart.items.length, 0);
  });
});
