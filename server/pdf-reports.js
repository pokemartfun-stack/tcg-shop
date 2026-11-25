'use strict';
// PDFs for the back office (pdfkit): the accounts report (sales summary, refunds, ledger) for a date
// range, and a receipt / order record for one order. Business details that are not confirmed yet are
// shown as "[… — to confirm]" placeholders — nothing is invented. Set COMPANY_ADDRESS / VAT_NUMBER on
// Render to fill them in.
const PDFDocument = require('pdfkit');
const sales = require('./sales');
const ledger = require('./ledger');
const { refundList } = require('./accounts-export');

const COMPANY_NAME = 'PO-KE-MART-FUN LIMITED';
const TRADING_AS = 'Po-ke Mart Fun';
const INK = '#1d2230'; const MUTED = '#667085'; const RED = '#e3350d'; const LINE = '#d9dce5'; const HEAD = '#eef1f8';

function company(env = process.env) {
  const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  return {
    name: COMPANY_NAME, tradingAs: TRADING_AS,
    address: oneLine(env.COMPANY_ADDRESS) || '[REGISTERED ADDRESS — to confirm]',
    vat: oneLine(env.VAT_NUMBER) || '[VAT STATUS / NUMBER — to confirm]',
    email: oneLine(env.CONTACT_EMAIL) || '[CONTACT EMAIL — to confirm]',
  };
}

// pdfkit's built-in fonts only cover Latin-1 (+ a few punctuation marks): replace anything else.
const safe = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u20AC]/g, '?');
const block = (lines) => lines.filter(Boolean).map(safe).join('\n'); // keeps line breaks between lines
const gbp = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return (v < 0 ? '-£' : '£') + Math.abs(v).toFixed(2); };
const ukDateTime = (iso) => { const p = sales.ukParts(iso); return p.date ? `${sales.ukDate(p.date)} ${p.time}` : ''; };

function newDoc(title) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: title, Author: TRADING_AS, Creator: 'Po-ke Mart Fun shop' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  return { doc, done };
}
function footers(doc, co, label) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - 30;
    const keep = doc.page.margins.bottom; doc.page.margins.bottom = 0; // writing in the bottom margin must not add a page
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(safe(`${co.name} · ${label}`), 40, y, { width: doc.page.width - 160, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - 120, y, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
}
function heading(doc, text) {
  if (doc.y > doc.page.height - 110) doc.addPage();
  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(INK).text(safe(text), 40);
  doc.moveDown(0.3);
}
const note = (doc, text) => doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(safe(text), 40, doc.y, { width: doc.page.width - 80 });

/** Simple table: cols = [{ label, width, align?, key? }]; rows = arrays of strings. Repeats the header on a new page. */
function table(doc, cols, rows, { fontSize = 8.5, boldLast = false } = {}) {
  const x0 = 40;
  const drawHead = () => {
    const y = doc.y;
    doc.rect(x0, y - 2, cols.reduce((s, c) => s + c.width, 0), 15).fill(HEAD);
    let x = x0;
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(INK);
    for (const c of cols) { doc.text(safe(c.label), x + 2, y + 1, { width: c.width - 4, align: c.align || 'left', lineBreak: false }); x += c.width; }
    doc.y = y + 15;
  };
  drawHead();
  if (!rows.length) { doc.font('Helvetica-Oblique').fontSize(fontSize).fillColor(MUTED).text('Nothing in this period.', x0 + 2, doc.y + 2); doc.moveDown(0.5); return; }
  rows.forEach((row, ri) => {
    doc.font(boldLast && ri === rows.length - 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    const heights = row.map((cell, i) => doc.heightOfString(safe(cell), { width: cols[i].width - 4 }));
    const h = Math.max(...heights, 10) + 4;
    if (doc.y + h > doc.page.height - 50) { doc.addPage(); drawHead(); doc.font(boldLast && ri === rows.length - 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize); }
    const y = doc.y;
    let x = x0;
    doc.fillColor(INK);
    row.forEach((cell, i) => { doc.text(safe(cell), x + 2, y + 2, { width: cols[i].width - 4, align: cols[i].align || 'left' }); x += cols[i].width; });
    doc.moveTo(x0, y + h).lineTo(x0 + cols.reduce((s, c) => s + c.width, 0), y + h).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.y = y + h;
  });
}

function letterhead(doc, co, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 8).fill(RED);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(safe(title), 40, 28);
  if (subtitle) doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(safe(subtitle), 40);
  doc.moveDown(0.4).font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(safe(`${co.name} (trading as ${co.tradingAs})`), 40)
    .text(safe(`Registered office: ${co.address}`), 40)
    .text(safe(`VAT: ${co.vat}`), 40);
}

/**
 * Accounts report. data = { from, to, orders, entries (ledger entries in range), includeDemo, fees }.
 */
async function reportPdf({ from, to, orders, entries, includeDemo = false, fees = sales.DEFAULT_FEES }, env = process.env) {
  const co = company(env);
  const { doc, done } = newDoc('Accounts report');
  const s = sales.summarise(orders, { from, to, includeDemo, fees });
  const t = s.totals;
  letterhead(doc, co, 'Accounts report', `${sales.ukDate(s.from)} to ${sales.ukDate(s.to)} (UK dates, both included) · generated ${ukDateTime(new Date().toISOString())} UK time`);

  heading(doc, '1. Sales summary (by order date)');
  const sumRows = [
    ['Orders counted', String(t.orders)], ['Items sold', String(t.items)], ['Sales (items)', gbp(t.sales)], ['Postage charged to customers', gbp(t.postage)],
    ['Takings (sales + postage)', gbp(t.sales + t.postage)], ['Estimated payment fees (ESTIMATE)', gbp(-t.fees)], ['Part refunds on orders still counted', gbp(-t.refunds)],
    ['Net received (after fees and part refunds)', gbp(t.net)], ['Cost of goods', gbp(-t.cost)], ['Postage paid', gbp(-t.postage_paid)], ['Profit (estimate)', gbp(t.profit)],
    ['Not counted: fully refunded / cancelled orders', `${s.excluded.refunded} / ${s.excluded.cancelled}`],
    ['All refunds on orders in this range (full + part)', gbp(s.refunds.amount)],
  ];
  table(doc, [{ label: 'Item', width: 380 }, { label: 'Amount', width: 135, align: 'right' }], sumRows);
  if (t.missing_cost_items) note(doc, `${t.missing_cost_items} item line(s) have no cost price, so profit is overstated.`);
  note(doc, 'Fully refunded and cancelled orders are left out of the money totals. Payment fees are estimates from the rates in admin; exact figures are in the Stripe / PayPal reports.');

  heading(doc, '2. Refunds (by refund date)');
  const rl = refundList(orders, from, to, includeDemo).slice().reverse();
  table(doc, [
    { label: 'Date (UK)', width: 62 }, { label: 'Order', width: 78 }, { label: 'Customer', width: 90 }, { label: 'Amount', width: 52, align: 'right' },
    { label: 'Method', width: 44 }, { label: 'Reason', width: 140 }, { label: 'By', width: 49 },
  ], rl.map((r) => [`${sales.ukDate(r.date_uk)} ${r.time_uk}`, r.order_number, r.customer, gbp(r.amount), r.method === 'manual' ? 'manual' : 'Stripe', r.reason, r.by]));
  if (rl.length) note(doc, `Total refunded in this range: ${gbp(rl.reduce((a, r) => a + r.amount, 0))}. "manual" = recorded by the owner; no money was moved by the shop.`);

  heading(doc, '3. Ledger (append-only record of money events)');
  const lt = ledger.totals(entries);
  table(doc, [
    { label: 'Date (UK)', width: 62 }, { label: 'Type', width: 44 }, { label: 'Order', width: 74 }, { label: 'Customer', width: 78 },
    { label: 'Amount', width: 54, align: 'right' }, { label: 'Method', width: 40 }, { label: 'Reference / note', width: 163 },
  ], [...entries.map((e) => [`${sales.ukDate(e.date_uk)} ${e.time_uk}`, e.type, e.order_number, e.customer, gbp(e.amount), e.method, [e.reference, e.note].filter(Boolean).join(' — ')]),
    ...(entries.length ? [['', 'TOTAL', '', '', gbp(lt.net), '', `sales ${gbp(lt.sale)}, postage ${gbp(lt.postage)}, fees ${gbp(lt.fee)}, refunds ${gbp(lt.refund)}, adjustments ${gbp(lt.adjustment)}`]] : [])], { fontSize: 7.5, boldLast: true });
  note(doc, 'Entries are never edited or deleted; a correction is a new entry. Refunds are negative. Fee entries are estimates.');

  footers(doc, co, `Accounts report ${sales.ukDate(s.from)} – ${sales.ukDate(s.to)}`);
  doc.end();
  return done;
}

/** Receipt / order record for one order (invoice-style; not a VAT invoice until VAT details are confirmed). */
async function receiptPdf(o, env = process.env) {
  const co = company(env);
  const { doc, done } = newDoc(`Receipt ${o.order_number || o.id}`);
  const a = o.shipping_address || {};
  letterhead(doc, co, 'Receipt / order record', `Order ${o.order_number || o.id}${o.demo ? ' — DEMO ORDER (no money taken)' : ''}`);
  doc.moveDown(0.8);
  const y0 = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('CUSTOMER', 40, y0).text('ORDER', 320, y0);
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  const cust = block([a.name, a.line1, a.line2, a.town, a.county, a.postcode, a.country, o.email]);
  doc.text(cust || '(no address on the order)', 40, y0 + 13, { width: 260 });
  const yLeft = doc.y;
  doc.text(block([`Order no.: ${o.order_number || o.id}`, `Order id: ${o.id}`, `Date (UK): ${ukDateTime(o.createdAt)}`, `Paid by: ${o.method === 'stripe' ? 'Card (Stripe)' : o.method === 'paypal' ? 'PayPal' : o.method || 'n/a'}`, o.payment_ref ? `Payment ref: ${o.payment_ref}` : '', o.tracking_number ? `Royal Mail tracking: ${o.tracking_number}` : '']), 320, y0 + 13, { width: 235 });
  doc.y = Math.max(yLeft, doc.y) + 14;

  const items = (o.items || []).map((l) => {
    const qty = Number(l.qty) || 1; const line = Number.isFinite(l.line_total) ? l.line_total : (Number(l.price_gbp) || 0) * qty;
    return [`${l.title || l.productId}${l.condition ? ` (${l.condition})` : ''}`, String(qty), gbp(l.price_gbp), gbp(line)];
  });
  const postage = o.postage ? Number(o.postage.amount) || 0 : 0;
  items.push([`${(o.postage && o.postage.service) || 'Postage'}${o.postage && o.postage.free ? ' (free)' : ''}`, '', '', gbp(postage)]);
  table(doc, [{ label: 'Description', width: 305 }, { label: 'Qty', width: 40, align: 'right' }, { label: 'Unit price', width: 80, align: 'right' }, { label: 'Amount', width: 90, align: 'right' }], items, { fontSize: 9 });
  doc.moveDown(0.5);
  const refunded = sales.refundedOf(o);
  const tot = [['Order total', gbp(o.total)]];
  if (refunded > 0) { tot.push(['Refunded', gbp(-refunded)]); tot.push(['Net after refunds', gbp(Number(o.total) - refunded)]); }
  table(doc, [{ label: 'Totals', width: 425 }, { label: 'Amount', width: 90, align: 'right' }], tot, { fontSize: 9.5, boldLast: true });

  if ((o.refunds || []).length) {
    heading(doc, 'Refunds');
    table(doc, [{ label: 'Date (UK)', width: 85 }, { label: 'Amount', width: 55, align: 'right' }, { label: 'Method', width: 55 }, { label: 'Reason', width: 230 }, { label: 'Reference', width: 90 }],
      o.refunds.map((r) => [ukDateTime(r.at), gbp(r.amount), r.method === 'manual' ? 'manual*' : 'Stripe', r.reason, r.stripe_refund_id || r.id]), { fontSize: 8.5 });
    if (o.refunds.some((r) => r.method === 'manual')) note(doc, '* manual = recorded by the owner; no money was moved by the shop system.');
  } else if (o.status === 'refunded') note(doc, 'This order was marked as refunded; no refund details were recorded.');
  doc.moveDown(1);
  note(doc, 'This is a receipt / record of the order. It is not a VAT invoice unless the VAT details above are confirmed.');
  footers(doc, co, `Receipt ${o.order_number || o.id}`);
  doc.end();
  return done;
}

module.exports = { reportPdf, receiptPdf, company, COMPANY_NAME };
