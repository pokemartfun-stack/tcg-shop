'use strict';
// Customer order emails (order confirmation + "shipped" with Royal Mail tracking), sent from the
// shop Gmail account through Gmail SMTP (nodemailer).
//
// Configuration comes from environment variables ONLY (set them on Render yourself):
//   GMAIL_USER          the shop Gmail address   (blank = emails are off)
//   GMAIL_APP_PASSWORD  a Google "app password"  (blank = emails are off) — never logged
//   MAIL_FROM_NAME      optional, default "Po-ke Mart Fun"
//   SHOP_URL            optional, default https://tcg-shop-1.onrender.com (used in links)
//   CONTACT_EMAIL       optional, shown as the contact address (default: GMAIL_USER)
//
// Emails are best-effort: they are sent in the background and can NEVER fail or delay an order, the
// Stripe webhook or the admin. Each kind is sent at most once per order (marker saved on the order).
const ordersStore = require('./orders-store');

const DEFAULT_FROM_NAME = 'Po-ke Mart Fun';
const DEFAULT_SHOP_URL = 'https://tcg-shop-1.onrender.com';
const EMAIL_RE = /^[^\s@<>"'(),;:\\]+@[^\s@<>"'(),;:\\]+\.[A-Za-z]{2,}$/;
const KINDS = {
  confirmation: { field: 'confirmation_emailed_at', error: 'confirmation_email_error', label: 'Confirmation email' },
  shipped: { field: 'shipped_emailed_at', error: 'shipped_email_error', label: 'Shipped email' },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => '£' + (Number(n) || 0).toFixed(2);
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();

// ---------------- configuration ----------------
function config() {
  const user = oneLine(process.env.GMAIL_USER);
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''); // Google shows it in 4 groups
  const fromName = oneLine(process.env.MAIL_FROM_NAME).replace(/["<>]/g, '') || DEFAULT_FROM_NAME;
  const shopUrl = (oneLine(process.env.SHOP_URL) || DEFAULT_SHOP_URL).replace(/\/+$/, '');
  const contactRaw = oneLine(process.env.CONTACT_EMAIL);
  const contact = EMAIL_RE.test(contactRaw) ? contactRaw : user;
  return { enabled: Boolean(user && pass && EMAIL_RE.test(user)), user, pass, fromName, shopUrl, contact };
}
function enabled() { return config().enabled; }
/** Safe to show in the admin: never includes the password. */
function status() {
  const c = config();
  return { enabled: c.enabled, from: c.enabled ? c.user : null };
}

let loggedOff = false;
let announced = false;
/** One log line at startup (or on first use): on/off. Never prints the password. */
function logStatus() {
  if (enabled()) {
    if (!announced) { announced = true; console.log(`Order emails: on (from ${config().user})`); }
  } else if (!loggedOff) {
    loggedOff = true;
    console.log('order emails off');
  }
}

// ---------------- transport ----------------
let transport = null;
let transportKey = '';
/** Gmail SMTP transport (created lazily, rebuilt if the env vars change). Tests replace it with setTransport(). */
function getTransport() {
  const c = config();
  const key = `${c.user}\n${c.pass}`;
  if (!transport || transportKey !== key) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    transportKey = key;
  }
  return transport;
}
let override = null;
/** For tests: use a fake transport ({ sendMail(msg) }). Pass null to go back to Gmail. */
function setTransport(t) { override = t; transport = null; }

// ---------------- content ----------------
function orderNumber(o) { return oneLine(o.order_number || o.id); }
function trackUrl(o, cfg) { return `${cfg.shopUrl}/track?number=${encodeURIComponent(orderNumber(o))}`; }
function royalMailUrl(n) { return `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`; }
function firstName(o) { return oneLine(o.shipping_address && o.shipping_address.name).split(' ')[0] || ''; }
function addressLines(a) {
  if (!a) return [];
  return [a.name, a.line1, a.line2, a.town, a.county, a.postcode, a.country].map(oneLine).filter(Boolean);
}
function itemRows(o) {
  return (o.items || []).map((l) => {
    const qty = Number(l.qty) || 1;
    const line = Number.isFinite(l.line_total) ? l.line_total : (Number(l.price_gbp) || 0) * qty;
    return { qty, title: oneLine(l.title || l.productId), condition: oneLine(l.condition), line, each: Number(l.price_gbp) || 0 };
  });
}
function totals(o) {
  const postage = o.postage ? Number(o.postage.amount) || 0 : 0;
  const subtotal = Number.isFinite(o.subtotal) ? o.subtotal : itemRows(o).reduce((s, r) => s + r.line, 0);
  const total = Number.isFinite(o.total) ? o.total : Math.round((subtotal + postage) * 100) / 100;
  return { subtotal, postage, free: Boolean(o.postage && o.postage.free), service: (o.postage && o.postage.service) || 'Royal Mail Tracked 48', total };
}

// Simple, table-based, inline-styled HTML: works in Gmail/Outlook/Apple Mail, fluid on phones.
const C = { red: '#e3350d', yellow: '#ffcb05', blue: '#2a75bb', ink: '#1d2230', muted: '#667085', line: '#e5e7ee', bg: '#f3f4f8' };
function layout(cfg, preheader, bodyHtml) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(cfg.fromName)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};">
<tr><td style="background:${C.red};padding:20px 24px;border-bottom:4px solid ${C.yellow};"><div style="font-size:22px;line-height:1.2;font-weight:700;color:#ffffff;">${esc(cfg.fromName)}</div><div style="font-size:13px;color:#ffe9e3;margin-top:2px;">Trading cards, shipped with care</div></td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid ${C.line};font-size:13px;line-height:1.5;color:${C.muted};">Questions? Just reply to this email${cfg.contact ? ` or write to <a href="mailto:${esc(cfg.contact)}" style="color:${C.blue};">${esc(cfg.contact)}</a>` : ''}.<br><a href="${esc(cfg.shopUrl)}" style="color:${C.blue};">${esc(cfg.shopUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
}
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:${C.blue};border-radius:8px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 22px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
}
function itemsTableHtml(o) {
  const rows = itemRows(o).map((r) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line};vertical-align:top;">${esc(r.title)}${r.condition ? `<div style="font-size:13px;color:${C.muted};">${esc(r.condition)}</div>` : ''}<div style="font-size:13px;color:${C.muted};">Qty ${esc(r.qty)}${r.qty > 1 ? ` × ${gbp(r.each)}` : ''}</div></td><td align="right" style="padding:10px 0 10px 12px;border-bottom:1px solid ${C.line};vertical-align:top;white-space:nowrap;">${gbp(r.line)}</td></tr>`).join('');
  const t = totals(o);
  const sumRow = (label, val, strong) => `<tr><td style="padding:6px 0;${strong ? 'font-weight:700;font-size:17px;' : 'color:' + C.muted + ';'}">${label}</td><td align="right" style="padding:6px 0 6px 12px;white-space:nowrap;${strong ? 'font-weight:700;font-size:17px;' : ''}">${val}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">${rows}${sumRow('Items', gbp(t.subtotal))}${sumRow(esc(t.service), t.free ? 'Free' : gbp(t.postage))}${sumRow('Total', gbp(t.total), true)}</table>`;
}
function addressBlockHtml(o) {
  const lines = addressLines(o.shipping_address);
  return lines.length ? `<div style="font-size:15px;">${lines.map(esc).join('<br>')}</div>` : `<div style="font-size:15px;color:${C.muted};">We'll be in touch if we need your address.</div>`;
}
const h2 = (t) => `<h2 style="margin:24px 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:${C.muted};">${esc(t)}</h2>`;

function confirmationEmail(order, cfg = config()) {
  const num = orderNumber(order);
  const name = firstName(order);
  const t = totals(order);
  const url = trackUrl(order, cfg);
  const subject = `Your ${cfg.fromName} order ${num} is confirmed`;
  const rows = itemRows(order);
  const text = [
    `Hi ${name || 'there'},`, '',
    `Thank you for your order with ${cfg.fromName}! Your payment is confirmed and we'll get your cards packed and posted soon.`, '',
    `Order number: ${num}`, '',
    'Your items:',
    ...rows.map((r) => `  ${r.qty} x ${r.title}${r.condition ? ` (${r.condition})` : ''} - ${gbp(r.line)}`),
    `  Items: ${gbp(t.subtotal)}`,
    `  ${t.service}: ${t.free ? 'Free' : gbp(t.postage)}`,
    `  Total: ${gbp(t.total)}`, '',
    'Delivering to:',
    ...(addressLines(order.shipping_address).length ? addressLines(order.shipping_address).map((l) => `  ${l}`) : ['  (no address on the order - we will contact you)']), '',
    `Track your order: ${url}`,
    '(You will need the email address you used at checkout.)', '',
    "We'll email you again with your Royal Mail tracking number as soon as your order is posted.", '',
    `Questions? Reply to this email${cfg.contact ? ` or write to ${cfg.contact}` : ''}.`, '',
    `${cfg.fromName}`, cfg.shopUrl,
  ].join('\n');
  const html = layout(cfg, `Order ${num} is confirmed — thank you!`, `
<h1 style="margin:0 0 8px;font-size:24px;line-height:1.25;">Thank you${name ? ', ' + esc(name) : ''}!</h1>
<p style="margin:0 0 4px;">Your payment is confirmed and we'll get your cards packed and posted soon.</p>
<p style="margin:12px 0 0;padding:12px 14px;background:${C.bg};border-left:4px solid ${C.yellow};border-radius:6px;font-size:15px;">Order number<br><strong style="font-size:18px;letter-spacing:.02em;">${esc(num)}</strong></p>
${h2('Your items')}${itemsTableHtml(order)}
${h2('Delivering to')}${addressBlockHtml(order)}
${button(url, 'Track your order')}
<p style="margin:0;font-size:14px;color:${C.muted};">You'll need the email address you used at checkout. We'll email you again with your Royal Mail tracking number as soon as your order is posted.</p>`);
  return { subject, text, html };
}

function shippedEmail(order, cfg = config()) {
  const num = orderNumber(order);
  const name = firstName(order);
  const tn = oneLine(order.tracking_number);
  const rm = royalMailUrl(tn);
  const url = trackUrl(order, cfg);
  const subject = `Your ${cfg.fromName} order ${num} has been posted`;
  const rows = itemRows(order);
  const text = [
    `Hi ${name || 'there'},`, '',
    `Good news - your ${cfg.fromName} order ${num} has been posted with ${totals(order).service}.`, '',
    `Royal Mail tracking number: ${tn}`,
    `Track it with Royal Mail: ${rm}`, '',
    'In this parcel:',
    ...rows.map((r) => `  ${r.qty} x ${r.title}`), '',
    'Delivering to:',
    ...addressLines(order.shipping_address).map((l) => `  ${l}`), '',
    `Your order page: ${url}`, '',
    'Royal Mail can take a day to show the first scan after posting.', '',
    `Questions? Reply to this email${cfg.contact ? ` or write to ${cfg.contact}` : ''}.`, '',
    `${cfg.fromName}`, cfg.shopUrl,
  ].join('\n');
  const html = layout(cfg, `Order ${num} is on its way — tracking ${tn}`, `
<h1 style="margin:0 0 8px;font-size:24px;line-height:1.25;">Your order is on its way${name ? ', ' + esc(name) : ''}!</h1>
<p style="margin:0;">Order <strong>${esc(num)}</strong> has been posted with ${esc(totals(order).service)}.</p>
<p style="margin:16px 0 0;padding:12px 14px;background:${C.bg};border-left:4px solid ${C.yellow};border-radius:6px;font-size:15px;">Royal Mail tracking number<br><strong style="font-size:18px;letter-spacing:.04em;word-break:break-all;">${esc(tn)}</strong></p>
${button(rm, 'Track with Royal Mail')}
${h2('In this parcel')}<div style="font-size:15px;">${rows.map((r) => `${esc(r.qty)} × ${esc(r.title)}`).join('<br>')}</div>
${h2('Delivering to')}${addressBlockHtml(order)}
<p style="margin:20px 0 0;font-size:14px;color:${C.muted};">Royal Mail can take a day to show the first scan after posting. You can also see your order any time on <a href="${esc(url)}" style="color:${C.blue};">our tracking page</a> (use the email address from checkout).</p>`);
  return { subject, text, html };
}

// ---------------- sending ----------------
const IN_FLIGHT = new Set(); // `${kind}:${orderId}` — stops two simultaneous sends for the same order

function scrubError(err, cfg) {
  let m = oneLine(err && err.message ? err.message : err).slice(0, 200);
  if (cfg.pass) m = m.split(cfg.pass).join('***');
  return m;
}

/** Why this order can't get this email (null = fine). `force` = admin pressed Resend. */
function blocker(kind, o, force) {
  if (!o) return 'order not found';
  if (o.demo) return 'demo order';
  if (!EMAIL_RE.test(oneLine(o.email))) return 'no valid customer email on the order';
  if (!force && o[KINDS[kind].field]) return 'already sent';
  if (kind === 'shipped' && !oneLine(o.tracking_number)) return 'no tracking number';
  if (kind === 'confirmation' && !force && o.status !== 'paid') return `order is ${o.status}`;
  return null;
}

/**
 * Send one email for an order and record when. Resolves { sent, skipped?, error? } — never rejects.
 * Re-reads the order from the store so a stale object can't cause a second send.
 */
async function send(kind, orderOrId, { force = false } = {}) {
  const cfg = config();
  const id = typeof orderOrId === 'string' ? orderOrId : orderOrId && orderOrId.id;
  const key = `${kind}:${id}`;
  try {
    if (!cfg.enabled) { logStatus(); return { sent: false, skipped: 'emails are off' }; }
    const o = ordersStore.find(id) || (typeof orderOrId === 'object' ? orderOrId : null);
    const why = blocker(kind, o, force);
    if (why) return { sent: false, skipped: why };
    if (IN_FLIGHT.has(key)) return { sent: false, skipped: 'already sending' };
    IN_FLIGHT.add(key);
    try {
      const mail = kind === 'shipped' ? shippedEmail(o, cfg) : confirmationEmail(o, cfg);
      const to = oneLine(o.email);
      await (override || getTransport()).sendMail({
        from: { name: cfg.fromName, address: cfg.user },
        replyTo: cfg.user,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      const meta = KINDS[kind];
      const at = new Date().toISOString();
      await ordersStore.update(o.id, (cur) => ({
        [meta.field]: at,
        [meta.error]: null,
        history: [...(cur.history || []), { at, event: force && cur[meta.field] ? `${meta.label} resent` : `${meta.label} sent`, note: `to ${to}` }],
      }));
      return { sent: true, at };
    } finally {
      IN_FLIGHT.delete(key);
    }
  } catch (err) {
    const msg = scrubError(err, cfg);
    console.error(`${KINDS[kind] ? KINDS[kind].label : kind} for order ${id} not sent: ${msg}`);
    try { if (ordersStore.find(id)) await ordersStore.update(id, { [KINDS[kind].error]: msg }); } catch { /* best effort */ }
    return { sent: false, error: msg };
  }
}

/** Fire and forget: call from the order / webhook / admin code. Returns nothing, throws nothing. */
function fireAndForget(kind, order) {
  try {
    if (!enabled()) { logStatus(); return; }
    // setImmediate: the caller (webhook, checkout, admin) finishes its own work first.
    setImmediate(() => { send(kind, order).catch((err) => console.error('order email error:', scrubError(err, config()))); });
  } catch (err) {
    console.error('order email error:', scrubError(err, config()));
  }
}
/** A new order has been saved. Only paid, real orders get a confirmation (sent once). */
function onOrderPaid(order) { if (order && !order.demo && order.status === 'paid') fireAndForget('confirmation', order); }
/** An order has just been marked posted with a tracking number (call only on the paid -> posted change). */
function onOrderShipped(order) { if (order && order.status === 'posted' && order.tracking_number) fireAndForget('shipped', order); }

module.exports = { config, enabled, status, logStatus, setTransport, send, onOrderPaid, onOrderShipped, confirmationEmail, shippedEmail, KINDS, esc };
