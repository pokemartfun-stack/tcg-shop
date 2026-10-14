'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const {
  emptyCart,
  addToCart,
  setQty,
  removeFromCart,
  enrichCart,
} = require('./cart');
const auth = require('./auth');
const {
  paymentMode,
  createStripeCheckoutSession,
  buildStripeLineItems,
  createDemoOrder,
} = require('./payments');

const PORT = Number(process.env.PORT) || 3847;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PRODUCTS_PATH = path.join(__dirname, '..', 'data', 'products.json');
const ORDERS_PATH = path.join(__dirname, '..', 'data', 'orders.json');
const SESSIONS = new Map(); // token -> { userId, cart, createdAt }

function loadProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
}

function loadOrders() {
  try {
    if (!fs.existsSync(ORDERS_PATH)) return [];
    return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveOrder(order) {
  const orders = loadOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2), 'utf8');
}

function getSession(req) {
  const token =
    (req.headers['x-session-token'] && String(req.headers['x-session-token'])) ||
    (req.cookies && req.cookies.session) ||
    null;
  if (token && SESSIONS.has(token)) {
    return { token, data: SESSIONS.get(token) };
  }
  const newToken = crypto.randomUUID();
  const data = { userId: null, cart: emptyCart(), createdAt: Date.now() };
  SESSIONS.set(newToken, data);
  return { token: newToken, data };
}

function parseCookies(req, _res, next) {
  const header = req.headers.cookie || '';
  req.cookies = {};
  header.split(';').forEach((part) => {
    const [k, ...rest] = part.trim().split('=');
    if (k) req.cookies[k] = decodeURIComponent(rest.join('=') || '');
  });
  next();
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
  );
}

const app = express();
app.use(express.json());
app.use(parseCookies);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  const session = getSession(req);
  req.sessionToken = session.token;
  req.session = session.data;
  if (!req.cookies.session || req.cookies.session !== session.token) {
    setSessionCookie(res, session.token);
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: paymentMode(process.env) });
});

app.get('/api/config', (req, res) => {
  const mode = paymentMode(process.env);
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  res.json({
    mode,
    user,
    baseUrl: BASE_URL,
  });
});

app.get('/api/products', (_req, res) => {
  res.json(loadProducts());
});

app.get('/api/products/:id', (req, res) => {
  const p = loadProducts().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.get('/api/cart', (req, res) => {
  const products = loadProducts();
  res.json(enrichCart(req.session.cart, products));
});

app.post('/api/cart/add', (req, res) => {
  const products = loadProducts();
  const { productId, qty } = req.body || {};
  const result = addToCart(req.session.cart, products, productId, qty);
  if (!result.ok) return res.status(400).json({ error: result.error, cart: enrichCart(req.session.cart, products) });
  res.json(enrichCart(req.session.cart, products));
});

app.post('/api/cart/set-qty', (req, res) => {
  const products = loadProducts();
  const { productId, qty } = req.body || {};
  const result = setQty(req.session.cart, products, productId, qty);
  if (!result.ok) return res.status(400).json({ error: result.error, cart: enrichCart(req.session.cart, products) });
  res.json(enrichCart(req.session.cart, products));
});

app.post('/api/cart/remove', (req, res) => {
  const products = loadProducts();
  const { productId } = req.body || {};
  removeFromCart(req.session.cart, productId);
  res.json(enrichCart(req.session.cart, products));
});

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  const result = auth.register(email, password, name);
  if (!result.ok) return res.status(400).json({ error: result.error });
  req.session.userId = result.user.id;
  res.json({ user: result.user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const result = auth.login(email, password);
  if (!result.ok) return res.status(401).json({ error: result.error });
  req.session.userId = result.user.id;
  res.json({ user: result.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.userId = null;
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  res.json({ user });
});

app.post('/api/checkout/demo', (req, res) => {
  const products = loadProducts();
  const enriched = enrichCart(req.session.cart, products);
  if (!enriched.items.length) {
    return res.status(400).json({ error: 'Your cart is empty' });
  }
  const mode = paymentMode(process.env);
  if (!mode.demo && (mode.stripe || mode.paypal)) {
    // Still allow demo if explicitly requested, but note live keys exist
  }
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  const email = (req.body && req.body.email) || (user && user.email) || null;
  const order = createDemoOrder({
    enriched,
    method: (req.body && req.body.method) || 'demo',
    email,
    userId: user && user.id,
  });
  saveOrder(order);
  req.session.cart = emptyCart();
  res.json({ order });
});

app.post('/api/checkout/stripe', async (req, res) => {
  const mode = paymentMode(process.env);
  if (!mode.stripe) {
    return res.status(400).json({
      error: 'Stripe keys not configured. Use demo checkout or add STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY.',
      demo: true,
    });
  }
  const products = loadProducts();
  const enriched = enrichCart(req.session.cart, products);
  if (!enriched.items.length) {
    return res.status(400).json({ error: 'Your cart is empty' });
  }
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const user = req.session.userId ? auth.findById(req.session.userId) : null;
    const email = (req.body && req.body.email) || (user && user.email) || undefined;
    const session = await createStripeCheckoutSession({
      stripe,
      lineItems: buildStripeLineItems(enriched),
      successUrl: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${BASE_URL}/cart.html`,
      customerEmail: email,
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Stripe error', err);
    res.status(500).json({ error: err.message || 'Stripe checkout failed' });
  }
});

app.get('/api/checkout/stripe/session/:id', async (req, res) => {
  const mode = paymentMode(process.env);
  if (!mode.stripe) {
    return res.status(400).json({ error: 'Stripe not configured' });
  }
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    if (session.payment_status === 'paid') {
      req.session.cart = emptyCart();
    }
    res.json({
      id: session.id,
      status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PayPal: client-side SDK uses PAYPAL_CLIENT_ID; capture is simulated in demo,
// or client redirects. Server records order after client confirms.
app.post('/api/checkout/paypal/record', (req, res) => {
  const mode = paymentMode(process.env);
  const products = loadProducts();
  const enriched = enrichCart(req.session.cart, products);
  if (!enriched.items.length) {
    return res.status(400).json({ error: 'Your cart is empty' });
  }
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  const email = (req.body && req.body.email) || (user && user.email) || null;
  const order = {
    id: (req.body && req.body.paypalOrderId) || `pp_${crypto.randomUUID().slice(0, 8)}`,
    status: mode.paypal ? 'paypal_client_complete' : 'demo_complete',
    method: 'paypal',
    email,
    userId: user && user.id,
    items: enriched.items,
    subtotal: enriched.subtotal,
    currency: 'GBP',
    message: mode.paypal
      ? 'PayPal payment recorded from client SDK.'
      : 'Demo PayPal — no money taken. Set PAYPAL_CLIENT_ID for live PayPal buttons.',
    createdAt: new Date().toISOString(),
  };
  saveOrder(order);
  req.session.cart = emptyCart();
  res.json({ order });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    const mode = paymentMode(process.env);
    console.log(`TCG Shop running at ${BASE_URL}`);
    console.log(
      mode.demo
        ? 'Payment mode: DEMO (no Stripe/PayPal keys)'
        : `Payment mode: stripe=${mode.stripe} paypal=${mode.paypal}`
    );
  });
}

module.exports = app;
