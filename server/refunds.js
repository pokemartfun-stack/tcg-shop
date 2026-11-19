'use strict';
/**
 * Refunds. A refund is recorded on the order (order.refunds[]) AND as an append-only ledger entry.
 *   { id, amount, reason, method: 'stripe'|'manual', stripe_refund_id, stripe_status, at, by, source, restock:[{productId,qty}] }
 * - method 'stripe': money is really returned through the Stripe Refunds API (the key already set in
 *   STRIPE_SECRET_KEY, so test keys stay test mode), with an idempotency key.
 * - method 'manual': nothing is sent anywhere — "record a refund that was already done another way"
 *   (PayPal, bank transfer, cash …). Clearly labelled as manual everywhere.
 * - Refunds made in the Stripe dashboard arrive through the charge.refunded webhook and are recorded
 *   too (de-duplicated by Stripe refund id).
 * Everything for one order runs through a queue, so a webhook and an admin click can't double-record.
 */
const crypto = require('crypto');
const ordersStore = require('./orders-store');
const productStore = require('./products-store');
const payments = require('./payments');
const ledger = require('./ledger');
const sales = require('./sales');
const royalmail = require('./royalmail');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pence = (n) => Math.round(money(n) * 100);

const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  next.then(() => {}, () => {}).then(() => { if (locks.get(id) === next) locks.delete(id); });
  return next;
}

const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);
const refundedTotal = (o) => sales.refundedOf(o);
const remaining = (o) => Math.max(0, money(Number(o.total) - refundedTotal(o)));
/** 'none' | 'partial' | 'full' */
function refundState(o) {
  const r = refundedTotal(o);
  if (r <= 0) return 'none';
  return remaining(o) <= 0 || o.status === 'refunded' ? 'full' : 'partial';
}
/** What the admin can do for this order. */
function options(o) {
  const stripeOk = o.method === 'stripe' && stripeConfigured() && !o.demo;
  return { stripe: stripeOk, manual: !o.demo, remaining: remaining(o), refunded: refundedTotal(o), state: refundState(o), demo: Boolean(o.demo) };
}

function parseRestock(o, input) {
  const have = {};
  for (const l of o.items || []) have[l.productId] = (have[l.productId] || 0) + (Number(l.qty) || 0);
  const done = sales.restockedOf(o);
  const out = [];
  for (const l of Array.isArray(input) ? input : []) {
    const qty = Number(l && l.qty);
    if (!l || !l.productId || !qty) continue;
    if (!Number.isInteger(qty) || qty < 0) return { error: 'Put-back-in-stock quantities must be whole numbers' };
    const free = (have[l.productId] || 0) - (done[l.productId] || 0);
    if (!(l.productId in have)) return { error: `${l.productId} is not on this order` };
    if (qty > free) return { error: `Only ${Math.max(0, free)} of ${l.productId} can still be put back in stock` };
    if (qty > 0) out.push({ productId: String(l.productId), qty });
  }
  return { restock: out };
}

async function paymentIntentOf(o) {
  if (o.stripe_payment_intent) return o.stripe_payment_intent;
  // orders saved before the payment id was stored: ask Stripe for the checkout session
  const s = await payments.getStripe().checkout.sessions.retrieve(o.id);
  const pi = s && (typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent && s.payment_intent.id);
  if (!pi) throw new Error('Stripe has no payment for this order');
  await ordersStore.update(o.id, { stripe_payment_intent: pi, payment_ref: o.payment_ref || pi });
  return pi;
}

/**
 * Add a refund to an order (status, history, ledger, stock). Shared by the admin action and the
 * Stripe webhook. Must run inside withLock(). Returns { order, refund }.
 */
async function applyRefund(orderId, rec) {
  const cur = ordersStore.find(orderId);
  const refund = { id: rec.id || `rf_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`, amount: money(rec.amount), reason: String(rec.reason || '').slice(0, 300), method: rec.method === 'stripe' ? 'stripe' : 'manual',
    stripe_refund_id: rec.stripe_refund_id || null, stripe_status: rec.stripe_status || null, at: rec.at || new Date().toISOString(), by: rec.by || 'admin', source: rec.source || 'admin', restock: rec.restock || [] };
  const total = money(refundedTotal(cur) + refund.amount);
  const full = total >= money(cur.total);
  const r = await ordersStore.update(orderId, (now) => ({
    refunds: [...(now.refunds || []), refund],
    refunded_gbp: money((now.refunds || []).reduce((s, x) => s + x.amount, 0) + refund.amount),
    ...(full ? { status: 'refunded', refunded_at: refund.at } : {}),
    history: [...(now.history || []), royalmail.historyEntry(full ? 'Refunded' : 'Part refund',
      `£${refund.amount.toFixed(2)} ${refund.method === 'stripe' ? 'via Stripe' : 'recorded manually (no money moved by the shop)'}${refund.reason ? ' — ' + refund.reason : ''}${refund.by ? ` (by ${refund.by})` : ''}`)],
  }));
  ledger.recordRefund(r.order, refund);
  let restockResult = null;
  if (refund.restock.length) {
    try {
      restockResult = await productStore.incrementStock(refund.restock, `refund ${r.order.order_number || r.order.id}`);
    } catch (err) {
      console.error('Refund recorded but stock could not be put back:', err.message);
      await ordersStore.update(orderId, (now) => ({ history: [...(now.history || []), royalmail.historyEntry('Restock failed', err.message)] }));
    }
  }
  return { order: ordersStore.find(orderId), refund, restock: restockResult, github: r.github, githubError: r.githubError };
}

/** Admin refund. input: { amount, reason, method?, restock?: [{productId, qty}], by? } -> { order, refund } | { error, status } */
function refundOrder(orderId, input = {}) {
  return withLock(orderId, async () => {
    const o = ordersStore.find(orderId);
    if (!o) return { error: 'Order not found', status: 404 };
    if (o.demo) return { error: 'This is a demo order — no money was taken, so there is nothing to refund.', status: 400 };
    if (o.status === 'cancelled') return { error: 'This order is cancelled.', status: 400 };
    const left = remaining(o);
    if (left <= 0) return { error: 'This order has already been refunded in full.', status: 400 };
    const amount = money(input.amount);
    if (!Number.isFinite(Number(input.amount)) || amount <= 0) return { error: 'Enter the amount to refund in £ (more than 0).', status: 400 };
    if (pence(amount) > pence(left)) return { error: `You can't refund more than the remaining £${left.toFixed(2)}.`, status: 400 };
    const reason = String(input.reason || '').replace(/\s+/g, ' ').trim();
    if (!reason) return { error: 'A reason is required.', status: 400 };
    const opts = options(o);
    const method = input.method === 'manual' ? 'manual' : input.method === 'stripe' ? 'stripe' : (opts.stripe ? 'stripe' : 'manual');
    if (method === 'stripe' && !opts.stripe) return { error: 'This order was not paid with Stripe (or Stripe is not set up), so it can only be recorded as a manual refund.', status: 400 };
    const rs = parseRestock(o, input.restock);
    if (rs.error) return { error: rs.error, status: 400 };
    const rec = { amount, reason, method, by: input.by || 'admin', source: 'admin', restock: rs.restock };
    if (method === 'stripe') {
      try {
        const pi = await paymentIntentOf(o);
        const sr = await payments.getStripe().refunds.create({
          payment_intent: pi,
          amount: pence(amount),
          metadata: { order_id: o.id, order_number: o.order_number || o.id, reason: reason.slice(0, 480) },
        }, { idempotencyKey: `pmf-refund-${o.id}-${(o.refunds || []).length}-${pence(amount)}` });
        if (sr.status === 'failed' || sr.status === 'canceled') return { error: `Stripe could not refund this payment (${sr.status}${sr.failure_reason ? ': ' + sr.failure_reason : ''}).`, status: 502 };
        rec.stripe_refund_id = sr.id; rec.stripe_status = sr.status || null;
      } catch (err) {
        console.error(`Stripe refund failed for order ${o.id}:`, err.message);
        return { error: `Stripe refused the refund: ${String(err.message || err).slice(0, 200)}`, status: 502 };
      }
    }
    const out = await applyRefund(o.id, rec);
    return { ...out, status: 200 };
  });
}

/**
 * Stripe webhook charge.refunded: record any Stripe refund we don't have yet (made in the Stripe
 * dashboard, or by the shop but not saved). Returns { recorded: n, orderId|null }.
 */
async function handleChargeRefunded(charge) {
  const pi = charge && (typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent && charge.payment_intent.id);
  if (!pi) return { recorded: 0, orderId: null, reason: 'no payment intent' };
  let order = ordersStore.all().find((o) => o.stripe_payment_intent === pi);
  const stripe = payments.getStripe();
  if (!order) { // older order without a stored payment id: the checkout session id is the order id
    try {
      const l = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
      const sid = l && l.data && l.data[0] && l.data[0].id;
      if (sid) order = ordersStore.find(sid);
    } catch (err) { console.error('charge.refunded: could not look up the checkout session:', err.message); }
  }
  if (!order) return { recorded: 0, orderId: null, reason: 'order not found' };
  return withLock(order.id, async () => {
    let list = [];
    try { list = ((await stripe.refunds.list({ payment_intent: pi, limit: 100 })) || {}).data || []; } catch (err) { console.error('charge.refunded: could not list refunds:', err.message); }
    if (!list.length && charge.refunds && Array.isArray(charge.refunds.data)) list = charge.refunds.data;
    let recorded = 0;
    for (const sr of list.slice().sort((a, b) => (a.created || 0) - (b.created || 0))) {
      if (!sr || !sr.id || ['failed', 'canceled'].includes(sr.status)) continue;
      const cur = ordersStore.find(order.id);
      if ((cur.refunds || []).some((r) => r.stripe_refund_id === sr.id)) continue;
      const left = remaining(cur);
      if (left <= 0) break;
      const amount = Math.min(left, money((sr.amount || 0) / 100));
      if (amount <= 0) continue;
      await applyRefund(cur.id, {
        amount, method: 'stripe', stripe_refund_id: sr.id, stripe_status: sr.status || null,
        reason: (sr.metadata && sr.metadata.reason) || sr.reason || 'Refunded in the Stripe dashboard',
        at: sr.created ? new Date(sr.created * 1000).toISOString() : undefined, by: 'Stripe dashboard', source: 'stripe_webhook', restock: [],
      });
      recorded++;
    }
    return { recorded, orderId: order.id };
  });
}

module.exports = { refundOrder, handleChargeRefunded, applyRefund, options, remaining, refundedTotal, refundState, withLock };
