'use strict';
// Printable packing slips (items + delivery address), A4 or A6 (4×6" thermal label printers).
// Works with no Royal Mail key. Opened from admin and printed straight away.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => '£' + (Number(n) || 0).toFixed(2);
const SHOP = 'Po-ke Mart Fun';

function ukDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric' }); } catch { return ''; }
}

function addressLines(a) {
  if (!a) return ['(no delivery address — check the order)'];
  return [a.name, a.line1, a.line2, a.town, a.county, a.postcode].filter(Boolean);
}

function slipHtml(o, size) {
  const a = o.shipping_address;
  const band = (o.postage && o.postage.band) || '';
  const items = (o.items || []).map((l) => `<tr><td class="q">${esc(l.qty)} ×</td><td>${esc(l.title || l.productId)}${l.condition ? `<div class="c">${esc(l.condition)}</div>` : ''}</td><td class="tick">☐</td></tr>`).join('');
  const ref = o.royalmail && o.royalmail.orderReference ? `<div>Royal Mail ref: <strong>${esc(o.royalmail.orderReference)}</strong></div>` : '';
  const demo = o.demo ? '<div class="demo">DEMO ORDER — do not post</div>' : '';
  if (size === 'a6') {
    return `<section class="page a6">${demo}
      <div class="to-l">DELIVER TO</div>
      <div class="to">${addressLines(a).map(esc).join('<br>')}</div>
      ${a && a.phone ? `<div class="ph">☎ ${esc(a.phone)}</div>` : ''}
      <div class="meta">Order <strong>${esc(o.id)}</strong> · ${esc(ukDate(o.createdAt))}<br>Royal Mail Tracked 48 · ${esc(band)}${o.tracking_number ? ` · ${esc(o.tracking_number)}` : ''}</div>
      <table class="items">${items}</table>
      <div class="from">From: ${SHOP}</div></section>`;
  }
  return `<section class="page a4">${demo}
    <header><img src="/images/logo.png" alt="" onerror="this.remove()"><div><h1>${SHOP}</h1><div class="sub">Packing slip</div></div>
      <div class="ord">Order <strong>${esc(o.id)}</strong><br>${esc(ukDate(o.createdAt))}${ref}</div></header>
    <div class="cols"><div><h2>Deliver to</h2><address>${addressLines(a).map(esc).join('<br>')}</address>${a && a.phone ? `<div>☎ ${esc(a.phone)}</div>` : ''}${o.email ? `<div>${esc(o.email)}</div>` : ''}</div>
      <div><h2>Postage</h2><div>Royal Mail Tracked 48 — ${esc(band)}</div>${o.tracking_number ? `<div>Tracking: <strong>${esc(o.tracking_number)}</strong></div>` : '<div class="muted">Tracking number: ____________________</div>'}</div></div>
    <h2>Items</h2><table class="items a4i"><thead><tr><th>Qty</th><th>Item</th><th>Packed</th></tr></thead><tbody>${items}</tbody></table>
    <div class="tot">Items ${gbp(o.subtotal)} · Postage ${gbp(o.postage && o.postage.amount)} · <strong>Total ${gbp(o.total)}</strong></div>
    <p class="thanks">Thank you for shopping with ${SHOP}! If anything is wrong with your order, reply to your order email and we'll sort it out.</p>
    <div class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>
    <div class="label"><div class="to-l">DELIVER TO</div><div class="to">${addressLines(a).map(esc).join('<br>')}</div><div class="from">Order ${esc(o.id)} · From: ${SHOP}</div></div>
  </section>`;
}

/** Full HTML document for one or more orders. size: 'a4' (default) or 'a6'. */
function render(orders, size = 'a4', { autoPrint = true } = {}) {
  const s = size === 'a6' ? 'a6' : 'a4';
  const pageCss = s === 'a6' ? '@page { size: 105mm 148mm; margin: 5mm; }' : '@page { size: A4; margin: 12mm; }';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Packing slip${orders.length > 1 ? 's' : ''} — ${SHOP}</title>
<style>${pageCss}
*{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;background:#fff}
.page{page-break-after:always;break-after:page} .page:last-child{page-break-after:auto;break-after:auto}
.a4{padding:4mm 2mm} header{display:flex;align-items:center;gap:12px;border-bottom:2px solid #111;padding-bottom:8px}
header img{height:48px} h1{font-size:22px;margin:0} .sub{color:#555} .ord{margin-left:auto;text-align:right;font-size:13px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#444;margin:14px 0 6px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px} address{font-style:normal;font-size:16px;line-height:1.4}
.items{width:100%;border-collapse:collapse;font-size:14px} .items td,.items th{border-bottom:1px solid #ccc;padding:6px 4px;text-align:left;vertical-align:top}
.items .q{white-space:nowrap;width:40px;font-weight:bold} .items .tick{width:50px;text-align:center;font-size:18px} .items .c{font-size:11px;color:#555}
.tot{text-align:right;margin-top:8px} .thanks{font-size:12px;color:#444} .muted{color:#666}
.cut{margin:16px 0 10px;color:#888;font-size:12px;white-space:nowrap;overflow:hidden}
.label{border:2px dashed #111;width:110mm;padding:6mm} .to-l{font-size:11px;font-weight:bold;letter-spacing:.1em}
.to{font-size:18px;line-height:1.35;font-weight:bold;margin:4px 0 8px} .from{font-size:11px;color:#333}
.a6{width:95mm;min-height:138mm;padding:2mm} .a6 .to{font-size:20px} .a6 .meta{font-size:11px;border-top:1px solid #111;border-bottom:1px solid #111;padding:4px 0;margin:6px 0}
.a6 .items{font-size:12px} .a6 .items td{padding:3px 2px} .ph{font-size:13px}
.demo{background:#111;color:#fff;text-align:center;font-weight:bold;padding:3px;margin-bottom:6px}
@media screen{body{background:#e5e7eb} .page{background:#fff;margin:12px auto;box-shadow:0 2px 8px #0003} .a4{width:210mm;min-height:280mm;padding:12mm} .a6{width:105mm;min-height:148mm;padding:5mm}}
</style></head><body>${orders.map((o) => slipHtml(o, s)).join('')}${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''}</body></html>`;
}

module.exports = { render, slipHtml, addressLines };
