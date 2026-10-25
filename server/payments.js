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

async function createStripeCheckoutSession({ stripe, lineItems, shipping, address, successUrl, cancelUrl, customerEmail }) {
  const shippingOption = buildStripeShipping(shipping);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    // Apple Pay / Google Pay appear automatically when domain is verified + HTTPS
    line_items: lineItems,
    shipping_options: shippingOption ? [shippingOption] : undefined,
    metadata: addressMetadata(address),
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
  createDemoOrder,
};
