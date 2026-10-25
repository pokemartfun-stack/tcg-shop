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
const postage = require('./postage');

const PORT = Number(process.env.PORT) || 3847;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSIONS = new Map(); // token -> { userId, cart, createdAt }

const productStore = require('./products-store');
const admin = require('./admin');
const settingsStore = require('./settings-store');
const PENDING_STRIPE = new Map(); // stripe session id -> { items, email, userId, done }

function stockError(res, problems, products, cart) {
  return res.status(409).json({
    error: problems.map((p) => p.error).join('; '),
    problems,
    cart: enrich(cart, products),
  });
}

/** Cart with server-calculated Royal Mail postage + order total (never trusts the browser). */
function enrich(cart, products) {
  return enrichCart(cart, products, settingsStore.get().postage);
}

/**
 * Email + UK delivery address sent by the checkout page. Logged-in users can leave the email
 * blank (their account email is used). Returns { email, address } or { error, field }.
 */
function checkoutDetails(req, user) {
  const body = req.body || {};
  const email = String(body.email || (user && user.email) || '').trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter your email address so we can send the receipt and tracking number', field: 'email' };
  const a = postage.validateAddress(body.address);
  if (a.error) return a;
  return { email, address: a.address };
}

function detailsError(res, d) {
  return res.status(400).json({ error: d.error, field: d.field });
}

/** Postage fields stored on every order record. */
function orderPostage(enriched) {
  const q = enriched.postage;
  return {
    postage: { service: q.service, band: q.band, amount: q.amount, free: q.free },
    total: q.total,
  };
}

function cartLines(enriched) {
  return enriched.items.map((l) => ({ productId: l.productId, qty: l.qty }));
}

function loadProducts() {
  return productStore.get();
}

const ordersStore = require('./orders-store');

/**
 * Save an order: copies each item's cost price (admin only, never shown to shoppers) onto the
 * order lines so profit stays the same even if the cost price is edited later, then stores the
 * order in the private orders repo (or the local file as a fallback).
 */
async function saveOrder(order) {
  const items = (order.items || []).map((l) => ({ ...l, cost_gbp: ordersStore.getCost(l.productId) }));
  const r = await ordersStore.add({ ...order, items });
  return r.order;
}

/** Products as shown to shoppers: no cost prices. */
function publicProduct(p) {
  const { cost_gbp, ...rest } = p; // eslint-disable-line no-unused-vars
  return rest;
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
app.use(express.json({ limit: '5mb' }));
app.use(parseCookies);
app.use('/api/admin', admin.router);
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
// Banner: local file, else fetched from the GitHub repo after a restart.
app.get('/images/banner.jpg', (req, res, next) => require('./images').serveBanner(req, res, next));
app.get('/images/background.jpg', (req, res, next) => require('./images').serveBackground(req, res, next));
// Shop logo (+ favicon regenerated from it): same local-then-repo logic.
app.get('/images/logo.png', (req, res, next) => require('./images').serveLogo(req, res, next));
app.get('/images/logo.gif', (req, res, next) => require('./images').serveLogoGif(req, res, next));
app.get('/favicon.png', (req, res, next) => require('./images').serveFavicon(req, res, next));
// Animated GIF uploads of the same two images (kept as GIF so they stay animated).
app.get('/images/banner.gif', (req, res, next) => require('./images').serveBannerGif(req, res, next));
app.get('/images/background.gif', (req, res, next) => require('./images').serveBackgroundGif(req, res, next));
// Customer pages: HTML with the current banner / background / logo already filled in.
app.use(require('./page-render').handler);
app.use(express.static(path.join(__dirname, '..', 'public')));
// Uploaded photos: local disk (UPLOADS_DIR or public/uploads), then GitHub fallback after a restart.
const images = require('./images');
app.use('/uploads', express.static(images.uploadsDir(), { maxAge: '1d' }));
app.get('/uploads/:file', images.serveFromGitHub);

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

app.get('/api/settings', (_req, res) => {
  res.json(settingsStore.get());
});

app.get('/api/products', (_req, res) => {
  res.json(loadProducts().map(publicProduct));
});

app.get('/api/products/:id', (req, res) => {
  const p = loadProducts().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(publicProduct(p));
});

app.get('/api/cart', (req, res) => {
  const products = loadProducts();
  const enriched = enrich(req.session.cart, products);
  enriched.problems = productStore.checkStock(cartLines(enriched));
  res.json(enriched);
});

app.post('/api/cart/add', (req, res) => {
  const products = loadProducts();
  const { productId, qty } = req.body || {};
  const result = addToCart(req.session.cart, products, productId, qty);
  if (!result.ok) return res.status(400).json({ error: result.error, cart: enrich(req.session.cart, products) });
  res.json(enrich(req.session.cart, products));
});

app.post('/api/cart/set-qty', (req, res) => {
  const products = loadProducts();
  const { productId, qty } = req.body || {};
  const result = setQty(req.session.cart, products, productId, qty);
  if (!result.ok) return res.status(400).json({ error: result.error, cart: enrich(req.session.cart, products) });
  res.json(enrich(req.session.cart, products));
});

app.post('/api/cart/remove', (req, res) => {
  const products = loadProducts();
  const { productId } = req.body || {};
  removeFromCart(req.session.cart, productId);
  res.json(enrich(req.session.cart, products));
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

app.post('/api/checkout/demo', async (req, res) => {
  const products = loadProducts();
  const enriched = enrich(req.session.cart, products);
  if (!enriched.items.length) {
    return res.status(400).json({ error: 'Your cart is empty' });
  }
  const problems = productStore.checkStock(cartLines(enriched));
  if (problems.length) return stockError(res, problems, products, req.session.cart);
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  const details = checkoutDetails(req, user);
  if (details.error) return detailsError(res, details);
  const taken = await productStore.decrementStock(cartLines(enriched), 'demo order');
  if (!taken.ok) return stockError(res, taken.problems, products, req.session.cart);
  const order = createDemoOrder({
    enriched,
    method: (req.body && req.body.method) || 'demo',
    email: details.email,
    userId: user && user.id,
    address: details.address,
  });
  await saveOrder(order);
  req.session.cart = emptyCart();
  res.json({ order });
});

// Server-calculated totals for the checkout page and the PayPal button (amount never comes from the browser).
app.get('/api/checkout/quote', (req, res) => {
  const enriched = enrich(req.session.cart, loadProducts());
  res.json({ subtotal: enriched.subtotal, postage: enriched.postage, total: enriched.total, count: enriched.count });
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
  const enriched = enrich(req.session.cart, products);
  if (!enriched.items.length) {
    return res.status(400).json({ error: 'Your cart is empty' });
  }
  const problems = productStore.checkStock(cartLines(enriched));
  if (problems.length) return stockError(res, problems, products, req.session.cart);
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  const details = checkoutDetails(req, user);
  if (details.error) return detailsError(res, details);
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const email = details.email;
    const session = await createStripeCheckoutSession({
      stripe,
      lineItems: buildStripeLineItems(enriched),
      shipping: enriched.postage, // Royal Mail Tracked 48, calculated on the server
      address: details.address,
      successUrl: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${BASE_URL}/cart.html`,
      customerEmail: email,
    });
    PENDING_STRIPE.set(session.id, {
      enriched,
      email: email || null,
      address: details.address,
      userId: (user && user.id) || null,
      done: false,
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
      const pending = PENDING_STRIPE.get(session.id);
      if (pending && !pending.done) {
        pending.done = true;
        // Paid already, so take whatever stock is left and flag any shortfall for the owner.
        const taken = await productStore.decrementStock(cartLines(pending.enriched), `stripe ${session.id}`);
        await saveOrder({
          id: session.id,
          status: 'paid',
          demo: false,
          stock_conflict: !taken.ok,
          method: 'stripe',
          email: pending.email,
          userId: pending.userId,
          items: pending.enriched.items,
          subtotal: pending.enriched.subtotal,
          ...orderPostage(pending.enriched),
          amount_paid: session.amount_total != null ? session.amount_total / 100 : null,
          shipping_address: pending.address,
          currency: 'GBP',
          stockProblems: taken.problems,
          createdAt: new Date().toISOString(),
        });
      }
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
// Pre-flight stock check used by the PayPal button before it opens the PayPal window.
app.get('/api/checkout/stock-check', (req, res) => {
  const products = loadProducts();
  const enriched = enrich(req.session.cart, products);
  const problems = productStore.checkStock(cartLines(enriched));
  if (problems.length) return stockError(res, problems, products, req.session.cart);
  res.json({ ok: true, subtotal: enriched.subtotal, postage: enriched.postage, total: enriched.total });
});

app.post('/api/checkout/paypal/record', async (req, res) => {
  const mode = paymentMode(process.env);
  const products = loadProducts();
  const enriched = enrich(req.session.cart, products);
  if (!enriched.items.length) {
    return res.status(400).json({ error: 'Your cart is empty' });
  }
  const livePaid = Boolean(mode.paypal && req.body && req.body.paypalOrderId);
  if (!livePaid) {
    const problems = productStore.checkStock(cartLines(enriched));
    if (problems.length) return stockError(res, problems, products, req.session.cart);
  }
  const user = req.session.userId ? auth.findById(req.session.userId) : null;
  const details = checkoutDetails(req, user);
  // The PayPal page only opens after the same check passed in the browser, so a paid order is
  // always recorded; a missing address is flagged on the order instead of losing the payment.
  if (details.error && !livePaid) return detailsError(res, details);
  const taken = await productStore.decrementStock(cartLines(enriched), 'paypal order');
  if (!taken.ok && !livePaid) return stockError(res, taken.problems, products, req.session.cart);
  const order = {
    id: (req.body && req.body.paypalOrderId) || `pp_${crypto.randomUUID().slice(0, 8)}`,
    status: 'paid',
    demo: !livePaid,
    stock_conflict: !taken.ok,
    stockProblems: taken.problems,
    method: 'paypal',
    email: details.email || (req.body && req.body.email) || (user && user.email) || null,
    userId: user && user.id,
    items: enriched.items,
    subtotal: enriched.subtotal,
    ...orderPostage(enriched),
    shipping_address: details.address || null,
    address_problem: details.error || undefined,
    currency: 'GBP',
    message: mode.paypal
      ? 'PayPal payment recorded from client SDK.'
      : 'Demo PayPal — no money taken. Set PAYPAL_CLIENT_ID for live PayPal buttons.',
    createdAt: new Date().toISOString(),
  };
  await saveOrder(order);
  req.session.cart = emptyCart();
  res.json({ order });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

if (require.main === module) {
  Promise.all([
    productStore
      .pullFromGitHub()
      .then((ok) => ok && console.log('Loaded products.json from GitHub'))
      .catch((err) => console.error('Could not load products from GitHub, using local file:', err.message)),
    ordersStore
      .pullFromGitHub()
      .then((ok) => ok && console.log(`Loaded ${ordersStore.all().length} orders from the private orders repo`))
      .catch((err) => console.error('Could not load orders from the orders repo:', err.message)),
    settingsStore
      .pullFromGitHub()
      .then((ok) => ok && console.log('Loaded settings.json from GitHub'))
      .catch((err) => console.error('Could not load settings from GitHub, using local file:', err.message)),
  ]).finally(() => app.listen(PORT, () => {
    const mode = paymentMode(process.env);
    console.log(`TCG Shop running at ${BASE_URL}`);
    console.log(
      mode.demo
        ? 'Payment mode: DEMO (no Stripe/PayPal keys)'
        : `Payment mode: stripe=${mode.stripe} paypal=${mode.paypal}`
    );
    console.log(process.env.ADMIN_PASSWORD ? 'Admin page: /admin' : 'Admin page disabled (set ADMIN_PASSWORD)');
    const ost = ordersStore.status();
    console.log(ost.mode === 'github' ? `Orders: private repo ${ost.repo}${ost.warning ? ' — WARNING: ' + ost.warning : ''}` : 'WARNING: ' + ost.warning);
  }));
}

module.exports = app;
