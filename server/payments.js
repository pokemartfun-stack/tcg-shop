/**
 * Payment helpers: Stripe Checkout session + demo fake order.
 */
const crypto = require('crypto');

function paymentMode(env) {
  const stripeOk = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY);
  const paypalOk = Boolean(env.PAYPAL_CLIENT_ID);
  return {
    demo: !stripeOk && !paypalOk,
    stripe: stripeOk,
    paypal: paypalOk,
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    paypalClientId: env.PAYPAL_CLIENT_ID || '',
  };
}

/** Stripe shipping option for the server-calculated Royal Mail postage (null when no postage info). */
function buildStripeShipping(q) {
  if (!q || !q.band) return null;
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: Math.round(q.amount * 100), currency: 'gbp' },
      display_name: q.free ? `${q.service} (free)` : `${q.service} — ${q.band}`,
      delivery_estimate: { minimum: { unit: 'business_day', value: 2 }, maximum: { unit: 'business_day', value: 3 } },
    },
  };
}

/** Delivery address as Stripe metadata (shown on the payment in the Stripe dashboard). */
function addressMetadata(a) {
  if (!a) return undefined;
  const one = [a.name, a.line1, a.line2, a.town, a.county, a.postcode].filter(Boolean).join(', ');
  return { ship_to: one.slice(0, 480), ship_phone: a.phone || '' };
}

// ---------------- Order metadata (lets the webhook rebuild the order without the browser) ----------------
// Stripe limits: 50 keys, key names up to 40 characters, values up to 500 characters.
const META_MAX_VALUE = 500;
const META_MAX_CART_KEYS = 30;

const ADDRESS_KEYS = ['name', 'line1', 'line2', 'town', 'county', 'postcode', 'phone'];

/**
 * Everything the order record needs, as Stripe metadata strings:
 *  cart_0..cart_N  "productId:qty:unitPence" lines joined with "|" (split over keys, ≤500 chars each)
 *  a_name … a_phone  delivery address, email, user_id, pst_* postage, subtotal_p
 * Returns null if the cart is too big to fit (then only the success page can record it).
 */
function orderMetadata({ enriched, address, email, userId }) {
  const meta = { ...(addressMetadata(address) || {}), v: '1' };
  const lines = (enriched.items || []).map((l) => `${l.productId}:${l.qty}:${Math.round(l.price_gbp * 100)}`);
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (line.length > META_MAX_VALUE) return null;
    const next = cur ? `${cur}|${line}` : line;
    if (next.length > META_MAX_VALUE) { chunks.push(cur); cur = line; } else cur = next;
  }
  if (cur) chunks.push(cur);
  if (chunks.length > META_MAX_CART_KEYS) return null;
  chunks.forEach((c, i) => { meta[`cart_${i}`] = c; });
  meta.cart_n = String(chunks.length);
  if (address) for (const k of ADDRESS_KEYS) if (address[k]) meta[`a_${k}`] = String(address[k]).slice(0, META_MAX_VALUE);
  if (email) meta.email = String(email).slice(0, META_MAX_VALUE);
  if (userId) meta.user_id = String(userId).slice(0, META_MAX_VALUE);
  const q = enriched.postage;
  if (q) {
    meta.pst_service = String(q.service || '').slice(0, META_MAX_VALUE);
    meta.pst_band = String(q.band || '');
    meta.pst_p = String(Math.round((q.amount || 0) * 100));
    meta.pst_free = q.free ? '1' : '0';
  }
  meta.subtotal_p = String(Math.round((enriched.subtotal || 0) * 100));
  return meta;
}

/**
 * Rebuild { enriched, address, email, userId } from a Checkout Session's metadata.
 * Titles/condition/image come from the current product list when the product still exists;
 * the price is what the customer was charged. Returns null when the metadata has no cart.
 */
function orderFromSessionMetadata(session, products) {
  const m = (session && session.metadata) || {};
  const n = Number(m.cart_n);
  if (!Number.isInteger(n) || n < 1) return null;
  const items = [];
  for (let i = 0; i < n; i++) {
    for (const part of String(m[`cart_${i}`] || '').split('|').filter(Boolean)) {
      const [productId, qtyS, penceS] = part.split(':');
      const qty = Number(qtyS);
      const pence = Number(penceS);
      if (!productId || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(pence)) continue;
      const p = (products || []).find((x) => x.id === productId) || {};
      const price = Math.round(pence) / 100;
      items.push({
        productId,
        title: p.title || productId,
        price_gbp: price,
        condition: p.condition,
        image: p.image,
        qty,
        line_total: Math.round(pence * qty) / 100,
      });
    }
  }
  if (!items.length) return null;
  const subtotal = m.subtotal_p != null ? Number(m.subtotal_p) / 100 : Math.round(items.reduce((s, l) => s + l.line_total * 100, 0)) / 100;
  let postage = null;
  if (m.pst_band || m.pst_p) {
    const amount = Number(m.pst_p || 0) / 100;
    postage = { service: m.pst_service || '', band: m.pst_band || '', amount, free: m.pst_free === '1', total: Math.round((subtotal + amount) * 100) / 100 };
  }
  let address = null;
  if (ADDRESS_KEYS.some((k) => m[`a_${k}`])) {
    address = { country: 'United Kingdom' };
    for (const k of ADDRESS_KEYS) address[k] = m[`a_${k}`] || '';
  }
  const details = session.customer_details || {};
  return {
    enriched: { items, subtotal, count: items.reduce((s, l) => s + l.qty, 0), postage, total: postage ? postage.total : subtotal },
    address,
    email: m.email || session.customer_email || details.email || null,
    userId: m.user_id || null,
  };
}

/** Stripe client (tests replace this to avoid network calls). */
function getStripe() {
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_webhook_only');
}

async function createStripeCheckoutSession({ stripe, lineItems, shipping, address, successUrl, cancelUrl, customerEmail, metadata }) {
  const shippingOption = buildStripeShipping(shipping);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    // Apple Pay / Google Pay appear automatically when domain is verified + HTTPS
    line_items: lineItems,
    shipping_options: shippingOption ? [shippingOption] : undefined,
    metadata: metadata || addressMetadata(address),
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
  });
  return session;
}

function buildStripeLineItems(enriched) {
  return enriched.items.map((line) => ({
    price_data: {
      currency: 'gbp',
      unit_amount: Math.round(line.price_gbp * 100),
      product_data: {
        name: line.title,
        description: line.condition,
        images: [], // relative paths won't work on Stripe; omit placeholders
      },
    },
    quantity: line.qty,
  }));
}

function createDemoOrder({ enriched, method, email, userId, address }) {
  const q = enriched.postage;
  return {
    id: `demo_${crypto.randomUUID().slice(0, 8)}`,
    status: 'paid',
    demo: true,
    method: method || 'demo',
    email: email || null,
    userId: userId || null,
    items: enriched.items,
    subtotal: enriched.subtotal,
    postage: q ? { service: q.service, band: q.band, amount: q.amount, free: q.free } : null,
    total: q ? q.total : enriched.subtotal,
    shipping_address: address || null,
    currency: 'GBP',
    message:
      'Demo order only — no money was taken. Add STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY and/or PAYPAL_CLIENT_ID to .env for live payments.',
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  paymentMode,
  createStripeCheckoutSession,
  buildStripeLineItems,
  buildStripeShipping,
  addressMetadata,
  orderMetadata,
  orderFromSessionMetadata,
  getStripe,
  createDemoOrder,
};
