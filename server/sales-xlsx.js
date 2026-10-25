'use strict';
// Excel (.xlsx) export of the Sales section: sheet "Summary" (range, totals, per month) and sheet
// "Orders" (one row per order line, same columns as the CSV). Money cells are real numbers with a
// £ format; dates are real Excel dates shown as dd/mm/yyyy (hh:mm), UK time.
const ExcelJS = require('exceljs');
const sales = require('./sales');

const GBP = '"£"#,##0.00;[Red]-"£"#,##0.00';
const UK_DATETIME = 'dd/mm/yyyy hh:mm';
const UK_DATE = 'dd/mm/yyyy';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDFE7F5' } };

/** A JS Date whose UTC fields are the UK wall-clock time (Excel has no time zones). */
function ukExcelDate(iso, withTime = true) {
  const p = sales.ukParts(iso);
  if (!p.date) return null;
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm] = withTime ? p.time.split(':').map(Number) : [0, 0];
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}
const plainDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

function boldHeader(row) {
  row.font = { bold: true };
  row.eachCell((c) => { c.fill = HEAD_FILL; c.border = { bottom: { style: 'thin', color: { argb: 'FF8899AA' } } }; });
}

/** Build the workbook; returns a Buffer. opts = { from, to, includeDemo, fees } */
async function toXlsx(orders, opts) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Po-ke Mart Fun shop';
  wb.created = new Date();
  const s = sales.summarise(orders, opts);
  const t = s.totals;

  // ---------- Summary ----------
  const ws = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 26 }, { width: 14 }, { width: 10 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 15 }, { width: 14 }, { width: 13 }];
  const title = ws.addRow(['Po-ke Mart Fun — sales summary']);
  title.font = { bold: true, size: 14 };
  const r1 = ws.addRow(['From (UK)', plainDate(s.from)]); r1.getCell(2).numFmt = UK_DATE;
  const r2 = ws.addRow(['To (UK, inclusive)', plainDate(s.to)]); r2.getCell(2).numFmt = UK_DATE;
  ws.addRow(['Demo / test orders', s.includeDemo ? 'Included' : 'Not included']);
  ws.addRow(['Payment fees', `ESTIMATED: Stripe ${s.fees.stripe.percent}% + £${s.fees.stripe.fixed.toFixed(2)}, PayPal ${s.fees.paypal.percent}% + £${s.fees.paypal.fixed.toFixed(2)} (exact figures are in your Stripe / PayPal reports)`]);
  ws.addRow(['Not counted in totals', `${s.excluded.refunded} refunded, ${s.excluded.cancelled} cancelled${s.includeDemo ? '' : `, ${s.excluded.demo} demo`}`]);
  if (t.missing_cost_items) ws.addRow(['Note', `${t.missing_cost_items} item line(s) have no cost price, so profit is overstated`]);
  ws.addRow([]);
  boldHeader(ws.addRow(['Totals', 'Amount']));
  const totals = [
    ['Orders', t.orders, '0'], ['Items sold', t.items, '0'],
    ['Sales (items)', t.sales, GBP], ['Postage charged', t.postage, GBP],
    ['Takings (sales + postage)', Math.round((t.sales + t.postage) * 100) / 100, GBP],
    ['Est. payment fees', t.fees, GBP], ['Net received', t.net, GBP],
    ['Cost of goods', t.cost, GBP], ['Postage paid', t.postage_paid, GBP], ['Profit', t.profit, GBP],
  ];
  for (const [k, v, fmt] of totals) {
    const r = ws.addRow([k, v]);
    r.getCell(2).numFmt = fmt;
    if (k === 'Profit' || k === 'Net received') r.font = { bold: true };
  }
  ws.addRow([]);
  boldHeader(ws.addRow(['Month', 'Orders', 'Items', 'Sales', 'Postage', 'Est. fees', 'Net', 'Cost of goods', 'Postage paid', 'Profit']));
  const monthRow = (label, m) => {
    const r = ws.addRow([label, m.orders, m.items, m.sales, m.postage, m.fees, m.net, m.cost, m.postage_paid, m.profit]);
    for (let c = 4; c <= 10; c++) r.getCell(c).numFmt = GBP;
    return r;
  };
  for (const m of s.months) monthRow(m.label, m);
  if (s.months.length) monthRow('Total', t).font = { bold: true };
  else ws.addRow(['No orders in this period']);

  // ---------- Orders ----------
  const wo = wb.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = sales.CSV_COLUMNS;
  const width = (c) => (c === 'item' ? 44 : c === 'customer_email' ? 30 : c === 'product_id' ? 30 : c === 'order_date_uk' ? 17
    : c === 'customer_name' || c === 'postage_service' ? 22 : c === 'tracking_number' ? 17 : sales.MONEY_COLUMNS.has(c) ? Math.max(12, c.length + 2) : Math.max(8, c.length + 2));
  wo.columns = cols.map((c) => ({ header: c, key: c, width: width(c) }));
  boldHeader(wo.getRow(1));
  for (const rec of sales.lineRecords(orders, opts)) {
    const row = wo.addRow({ ...rec, order_date_uk: ukExcelDate(rec._createdAt), posted_date_uk: rec._postedAt ? ukExcelDate(rec._postedAt, false) : '' });
    row.getCell('order_date_uk').numFmt = UK_DATETIME;
    if (rec._postedAt) row.getCell('posted_date_uk').numFmt = UK_DATE;
    for (const c of sales.MONEY_COLUMNS) {
      const cell = row.getCell(c);
      if (cell.value === '') cell.value = null; else cell.numFmt = GBP;
    }
  }
  wo.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, wo.rowCount), column: cols.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { toXlsx, ukExcelDate, GBP, UK_DATETIME, UK_DATE };
