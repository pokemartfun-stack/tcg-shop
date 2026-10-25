'use strict';
// Sales figures for the admin "Sales" section: monthly / custom-range / tax-year summaries and a
// CSV of order lines for self-assessment records. All dates are UK time (Europe/London).
// Payment fees are ESTIMATES from the rates set in admin (defaults: Stripe standard UK card
// 1.5% + 20p, stripe.com/gb/pricing; PayPal UK commercial 2.9% + 30p, paypal.com/uk/business/paypal-business-fees).

const DEFAULT_FEES = {
  stripe: { percent: 1.5, fixed: 0.2 },
  paypal: { percent: 2.9, fixed: 0.3 },
};

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** { date: 'YYYY-MM-DD', time: 'HH:MM', month: 'YYYY-MM' } in UK time. */
function ukParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '', month: '' };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`, month: `${g('year')}-${g('month')}` };
}

const todayUk = (now = new Date()) => ukParts(now.toISOString()).date;

/** UK tax year starting 6 April of startYear: 6 Apr YYYY – 5 Apr YYYY+1. */
function taxYear(startYear) {
  const y = Number(startYear);
  return { id: `tax-${y}`, label: `Tax year ${y}/${String((y + 1) % 100).padStart(2, '0')} (6 Apr ${y} – 5 Apr ${y + 1})`, from: `${y}-04-06`, to: `${y + 1}-04-05` };
}

/** Start year of the tax year a date (YYYY-MM-DD) falls in: 2026-04-05 -> 2025, 2026-04-06 -> 2026. */
function taxYearStart(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return m > 4 || (m === 4 && d >= 6) ? y : y - 1;
}

const pad = (n) => String(n).padStart(2, '0');
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** Ready-made ranges for the admin dropdown, based on today's UK date. */
function presets(now = new Date()) {
  const today = todayUk(now);
  const [y, m] = today.split('-').map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const ty = taxYearStart(today);
  return [
    { id: 'this-month', label: 'This month', from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` },
    { id: 'last-month', label: 'Last month', from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDayOfMonth(py, pm))}` },
    { id: 'ytd', label: `Year to date (${y})`, from: `${y}-01-01`, to: today },
    { ...taxYear(ty), label: `This ${taxYear(ty).label.replace(/^T/, 't')}` },
    { ...taxYear(ty - 1), label: `Last ${taxYear(ty - 1).label.replace(/^T/, 't')}` },
    { id: 'all', label: 'All time', from: '2000-01-01', to: '2999-12-31' },
  ];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanRange(from, to) {
  const f = DATE_RE.test(String(from || '')) ? from : '2000-01-01';
  const t = DATE_RE.test(String(to || '')) ? to : '2999-12-31';
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

function validateFees(input, base = DEFAULT_FEES) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Fees must be an object' };
  const out = { stripe: { ...DEFAULT_FEES.stripe, ...(base && base.stripe) }, paypal: { ...DEFAULT_FEES.paypal, ...(base && base.paypal) } };
  for (const k of ['stripe', 'paypal']) {
    if (input[k] === undefined) continue;
    for (const f of ['percent', 'fixed']) {
      const v = input[k] && input[k][f];
      if (v === undefined) continue;
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < 0 || n > (f === 'percent' ? 20 : 5)) return { error: `${k === 'stripe' ? 'Stripe' : 'PayPal'} fee ${f === 'percent' ? '%' : '£'} is not valid` };
      out[k][f] = f === 'percent' ? Math.round(n * 1000) / 1000 : money(n);
    }
  }
  return { fees: out };
}

/** Estimated processing fee for one order (0 for demo orders). */
function estimateFee(order, fees = DEFAULT_FEES) {
  if (!order || order.demo) return 0;
  const rate = fees[order.method === 'stripe' ? 'stripe' : order.method === 'paypal' ? 'paypal' : ''];
  if (!rate) return 0;
  return money((Number(order.total) || 0) * rate.percent / 100 + rate.fixed);
}

/** Money figures for one order. Postage paid defaults to the postage charged. */
function orderFigures(order, fees = DEFAULT_FEES) {
  const items = (order.items || []).reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const sales = money(order.subtotal);
  const postage = money(order.postage && order.postage.amount);
  const fee = estimateFee(order, fees);
  const net = money(sales + postage - fee);
  let cost = 0;
  let missingCost = 0;
  for (const l of order.items || []) {
    if (Number.isFinite(l.cost_gbp)) cost += l.cost_gbp * (Number(l.qty) || 0);
    else missingCost += Number(l.qty) || 0;
  }
  cost = money(cost);
  const postagePaid = money(order.postage_paid != null && order.postage_paid !== '' ? order.postage_paid : postage);
  return { items, sales, postage, fee, net, cost, postagePaid, profit: money(net - cost - postagePaid), missingCost };
}

const ZERO = () => ({ orders: 0, items: 0, sales: 0, postage: 0, fees: 0, net: 0, cost: 0, postage_paid: 0, profit: 0, missing_cost_items: 0 });
function addTo(t, f) {
  t.orders += 1; t.items += f.items;
  t.sales = money(t.sales + f.sales); t.postage = money(t.postage + f.postage); t.fees = money(t.fees + f.fee);
  t.net = money(t.net + f.net); t.cost = money(t.cost + f.cost); t.postage_paid = money(t.postage_paid + f.postagePaid);
  t.profit = money(t.profit + f.profit); t.missing_cost_items += f.missingCost;
}

/** Orders whose UK date is in [from, to] (inclusive), newest first. */
function ordersInRange(orders, from, to) {
  const r = cleanRange(from, to);
  return (orders || [])
    .filter((o) => { const d = ukParts(o.createdAt).date; return d && d >= r.from && d <= r.to; })
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = String(ym).split('-'); return `${MONTHS[Number(m) - 1] || m} ${y}`; };

const counts = (o, includeDemo) => !['refunded', 'cancelled'].includes(o.status) && (includeDemo || !o.demo);

/**
 * Summary for a date range. Refunded / cancelled orders are left out of the money totals
 * (counted separately); demo orders are left out unless includeDemo.
 */
function summarise(orders, { from, to, includeDemo = false, fees = DEFAULT_FEES } = {}) {
  const r = cleanRange(from, to);
  const list = ordersInRange(orders, r.from, r.to);
  const totals = ZERO();
  const months = new Map();
  const excluded = { demo: 0, refunded: 0, cancelled: 0 };
  for (const o of list) {
    if (o.status === 'refunded' || o.status === 'cancelled') { excluded[o.status] += 1; continue; }
    if (o.demo && !includeDemo) { excluded.demo += 1; continue; }
    const f = orderFigures(o, fees);
    addTo(totals, f);
    const m = ukParts(o.createdAt).month;
    if (!months.has(m)) months.set(m, { month: m, ...ZERO() });
    addTo(months.get(m), f);
  }
  return {
    from: r.from, to: r.to, includeDemo: Boolean(includeDemo), fees,
    totals, months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ ...m, label: monthLabel(m.month) })), excluded,
    to_post: list.filter((o) => o.status === 'paid' && counts(o, includeDemo)).length,
  };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s; // plain numbers (profit can be negative)
  const formula = /^[=+\-@\t\r]/.test(s); // stop spreadsheet formula injection from customer text
  return formula || /[",\r\n]/.test(s) ? `"${(formula ? "'" : '') + s.replace(/"/g, '""')}"` : s;
}
const fx = (n) => (n === null || n === undefined || n === '' ? '' : money(n).toFixed(2));

const CSV_COLUMNS = [
  'order_date_uk', 'order_time_uk', 'order_id', 'status', 'payment_method', 'demo', 'customer_name', 'customer_email', 'postcode',
  'line', 'product_id', 'item', 'qty', 'unit_price_gbp', 'line_total_gbp', 'unit_cost_gbp', 'line_cost_gbp',
  'order_items_gbp', 'postage_service', 'postage_band', 'postage_charged_gbp', 'postage_paid_gbp', 'order_total_gbp',
  'est_payment_fee_gbp', 'est_net_received_gbp', 'order_cost_of_goods_gbp', 'est_profit_gbp', 'tracking_number', 'posted_date_uk',
];

const MONEY_COLUMNS = new Set(CSV_COLUMNS.filter((c) => /_gbp$/.test(c)));

/**
 * One record per order line (oldest first), keyed by CSV_COLUMNS; money as numbers ('' = blank).
 * Order-level money (postage, total, fee, net, profit) is only on line 1 of each order, so
 * summing a column never double counts. Used by both the CSV and the Excel export.
 */
function lineRecords(orders, { from, to, includeDemo = false, fees = DEFAULT_FEES } = {}) {
  const out = [];
  const list = ordersInRange(orders, from, to).filter((o) => includeDemo || !o.demo).reverse(); // oldest first
  const m = (n) => (n === null || n === undefined || n === '' ? '' : money(n));
  for (const o of list) {
    const p = ukParts(o.createdAt);
    const f = orderFigures(o, fees);
    const a = o.shipping_address || {};
    const counted = !['refunded', 'cancelled'].includes(o.status);
    (o.items && o.items.length ? o.items : [{}]).forEach((l, i) => {
      const first = i === 0;
      const hasCost = Number.isFinite(l.cost_gbp);
      out.push({
        _createdAt: o.createdAt, _postedAt: first && o.posted_at ? o.posted_at : null,
        order_date_uk: p.date, order_time_uk: p.time, order_id: o.id, status: o.status, payment_method: o.method || '',
        demo: o.demo ? 'yes' : 'no', customer_name: a.name || '', customer_email: o.email || '', postcode: a.postcode || '',
        line: i + 1, product_id: l.productId || '', item: l.title || '', qty: l.qty || '',
        unit_price_gbp: m(l.price_gbp), line_total_gbp: m(l.line_total),
        unit_cost_gbp: hasCost ? m(l.cost_gbp) : '', line_cost_gbp: hasCost ? m(l.cost_gbp * (l.qty || 0)) : '',
        order_items_gbp: first ? f.sales : '', postage_service: first ? (o.postage && o.postage.service) || '' : '',
        postage_band: first ? (o.postage && o.postage.band) || '' : '',
        postage_charged_gbp: first ? f.postage : '', postage_paid_gbp: first ? f.postagePaid : '', order_total_gbp: first ? m(o.total) : '',
        est_payment_fee_gbp: first && counted ? f.fee : '', est_net_received_gbp: first && counted ? f.net : '',
        order_cost_of_goods_gbp: first ? f.cost : '', est_profit_gbp: first && counted ? f.profit : '',
        tracking_number: first ? o.tracking_number || '' : '', posted_date_uk: first && o.posted_at ? ukParts(o.posted_at).date : '',
      });
    });
  }
  return out;
}

/** CSV, one row per order line (see lineRecords). */
function toCsv(orders, opts = {}) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const r of lineRecords(orders, opts)) {
    rows.push(CSV_COLUMNS.map((c) => csvCell(MONEY_COLUMNS.has(c) ? fx(r[c]) : r[c])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * Date range chosen by the admin (UK dates, both days included). Missing = 1st of this month
 * to today. Returns { from, to } or { error }.
 */
function parseRange(from, to, now = new Date()) {
  const today = todayUk(now);
  const f = from === undefined || from === '' ? `${today.slice(0, 8)}01` : String(from);
  const t = to === undefined || to === '' ? today : String(to);
  const valid = (d) => DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
  if (!valid(f)) return { error: 'The From date is not a valid date' };
  if (!valid(t)) return { error: 'The To date is not a valid date' };
  if (f > t) return { error: `The From date (${ukDate(f)}) must be on or before the To date (${ukDate(t)})` };
  return { from: f, to: t };
}

/** 'YYYY-MM-DD' -> 'dd/mm/yyyy' */
function ukDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d);
}

module.exports = { lineRecords, parseRange, ukDate, MONEY_COLUMNS, monthLabel, DEFAULT_FEES, ukParts, todayUk, taxYear, taxYearStart, presets, cleanRange, validateFees, estimateFee, orderFigures, ordersInRange, summarise, toCsv, CSV_COLUMNS };
