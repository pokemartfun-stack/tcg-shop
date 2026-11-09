'use strict';
const crypto = require('crypto');
const orders = require('./orders-store');
const royalmail = require('./royalmail');
const router = require('express').Router();
const geoCache = new Map();
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function limit(req, res, next) {
  const now = Date.now();
  for (const [key, v] of attempts) if (v.until <= now) attempts.delete(key);
  const key = req.ip;
  if (!attempts.has(key) && attempts.size >= 5000) return res.status(429).json({ error: 'Please try again shortly.' });
  const entry = attempts.get(key) || { count: 0, until: now + WINDOW };
  attempts.set(key, entry);
  if (++entry.count > 20) { res.set('Retry-After', String(Math.ceil((entry.until - now) / 1000))); return res.status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' }); }
  next();
}
function identity() { return { access_token: crypto.randomBytes(32).toString('hex'), order_number: 'PMF-' + crypto.randomBytes(5).toString('hex').toUpperCase() }; }
async function geocode(postcode) {
  const pc = String(postcode || '').toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{5,8}$/.test(pc)) return null;
  const hit = geoCache.get(pc);
  if (hit && hit.until > Date.now()) return hit.value;
  let value = null;
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, { signal: AbortSignal.timeout(1800) });
    const d = r.ok && (await r.json()).result;
    if (d && Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) value = { lat: d.latitude, lon: d.longitude };
  } catch { /* A plain address card remains available when geocoding is unavailable. */ }
  if (geoCache.size >= 1000) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(pc, { value, until: Date.now() + (value ? 86400000 : 60000) });
  return value;
}
function safeOrder(o, full = false) {
  const rm = o.royalmail || {};
  const history = royalmail.historyOf(o).filter(h => ['Paid', 'Sent to Royal Mail', 'Label printed', 'Shipped', 'Delivered', 'Refunded', 'Cancelled'].includes(h.event)).map(h => ({ event: h.event, at: h.at }));
  const delivered = o.delivered_at || rm.deliveredAt || history.find(h => h.event === 'Delivered')?.at;
  const stage = delivered ? 'delivered' : royalmail.stageOf(o);
  return {
    number: o.order_number || o.id, demo: !!o.demo, stage, createdAt: o.createdAt,
    history, sentAt: rm.sentAt || null, labelPrintedAt: rm.labelPrintedAt || o.label_printed_at || null,
    shippedAt: o.posted_at || null, deliveredAt: delivered || null,
    tracking_number: o.tracking_number || null,
    tracking_url: o.tracking_number ? royalmail.trackingUrl(o.tracking_number) : null,
    items: (o.items || []).map(i => ({ title: i.title, qty: i.qty, image: /^\/[^/]/.test(i.image || '') ? i.image : null, line_total: i.line_total })),
    subtotal: o.subtotal, total: o.total, postage: o.postage ? { service: o.postage.service, band: o.postage.band, amount: o.postage.amount } : null,
    town: o.shipping_address?.town || '',
    ...(full ? { email: o.email, first_name: String(o.shipping_address?.name || '').split(' ')[0], shipping_address: o.shipping_address ? Object.fromEntries(['name','line1','line2','town','county','postcode','country'].map(k => [k, o.shipping_address[k] || ''])) : null } : {}),
  };
}
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
router.post('/track', limit, async (req, res) => {
  const number = String(req.body?.number || '').trim().replace(/^#/, '').slice(0, 120).toLowerCase();
  const email = String(req.body?.email || '').trim().slice(0, 120).toLowerCase();
  const o = number && email && orders.all().find(x => (x.order_number || x.id).toLowerCase() === number && String(x.email || '').trim().toLowerCase() === email);
  if (!o) return res.status(404).json({ error: 'We couldn’t find that order. Check your order number and the email used at checkout.' });
  res.json({ order: safeOrder(o), map: await geocode(o.shipping_address?.postcode) });
});
router.post('/confirmation', limit, async (req, res) => {
  const token = String(req.body?.token || '');
  const o = /^[a-f0-9]{64}$/.test(token) && orders.all().find(x => x.access_token === token);
  if (!o) return res.status(404).json({ error: 'Order confirmation not found. Please use your confirmation link or track your order.' });
  res.json({ order: safeOrder(o, true), map: await geocode(o.shipping_address?.postcode) });
});
module.exports = { router, identity, safeOrder, geocode, _reset: () => { attempts.clear(); geoCache.clear(); } };
