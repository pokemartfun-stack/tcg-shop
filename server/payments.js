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

async function createStripeCheckoutSession({ stripe, lineItems, successUrl, cancelUrl, customerEmail }) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    // Apple Pay / Google Pay appear automatically when domain is verified + HTTPS
    line_items: lineItems,
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

function createDemoOrder({ enriched, method, email, userId }) {
  return {
    id: `demo_${crypto.randomUUID().slice(0, 8)}`,
    status: 'demo_complete',
    method: method || 'demo',
    email: email || null,
    userId: userId || null,
    items: enriched.items,
    subtotal: enriched.subtotal,
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
  createDemoOrder,
};
