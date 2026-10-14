/**
 * Pure cart helpers — unit-testable, no Express dependency.
 */

function findProduct(products, id) {
  return products.find((p) => p.id === id) || null;
}

function emptyCart() {
  return { items: [] };
}

function cartSubtotal(cart, products) {
  let total = 0;
  for (const line of cart.items) {
    const p = findProduct(products, line.productId);
    if (!p) continue;
    total += p.price_gbp * line.qty;
  }
  return Math.round(total * 100) / 100;
}

function addToCart(cart, products, productId, qty = 1) {
  const product = findProduct(products, productId);
  if (!product) {
    return { ok: false, error: 'Product not found', cart };
  }
  const n = Math.max(1, Math.min(99, Number(qty) || 1));
  const existing = cart.items.find((i) => i.productId === productId);
  const currentQty = existing ? existing.qty : 0;
  const nextQty = currentQty + n;
  if (nextQty > product.stock) {
    return { ok: false, error: `Only ${product.stock} in stock`, cart };
  }
  if (existing) {
    existing.qty = nextQty;
  } else {
    cart.items.push({ productId, qty: n });
  }
  return { ok: true, cart };
}

function setQty(cart, products, productId, qty) {
  const product = findProduct(products, productId);
  if (!product) {
    return { ok: false, error: 'Product not found', cart };
  }
  const n = Number(qty);
  if (!Number.isFinite(n) || n < 1) {
    cart.items = cart.items.filter((i) => i.productId !== productId);
    return { ok: true, cart };
  }
  if (n > product.stock) {
    return { ok: false, error: `Only ${product.stock} in stock`, cart };
  }
  const existing = cart.items.find((i) => i.productId === productId);
  if (existing) {
    existing.qty = Math.min(99, Math.floor(n));
  } else {
    cart.items.push({ productId, qty: Math.min(99, Math.floor(n)) });
  }
  return { ok: true, cart };
}

function removeFromCart(cart, productId) {
  cart.items = cart.items.filter((i) => i.productId !== productId);
  return { ok: true, cart };
}

function enrichCart(cart, products) {
  const lines = [];
  for (const line of cart.items) {
    const p = findProduct(products, line.productId);
    if (!p) continue;
    lines.push({
      productId: p.id,
      title: p.title,
      price_gbp: p.price_gbp,
      condition: p.condition,
      image: p.image,
      qty: line.qty,
      line_total: Math.round(p.price_gbp * line.qty * 100) / 100,
      stock: p.stock,
    });
  }
  return {
    items: lines,
    subtotal: cartSubtotal(cart, products),
    count: lines.reduce((s, l) => s + l.qty, 0),
  };
}

module.exports = {
  emptyCart,
  cartSubtotal,
  addToCart,
  setQty,
  removeFromCart,
  enrichCart,
  findProduct,
};
