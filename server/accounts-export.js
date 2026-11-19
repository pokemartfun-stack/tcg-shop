'use strict';
// Ledger exports for the Accounts tab: CSV and Excel for a UK date range. Amounts are signed pounds.
const ExcelJS = require('exceljs');
const ledger = require('./ledger');
const sales = require('./sales');
const { ukExcelDate, GBP, UK_DATETIME } = require('./sales-xlsx');

const COLUMNS = ['entry_id', 'date_uk', 'time_uk', 'type', 'order_number', 'order_id', 'customer', 'amount_gbp', 'method', 'reference', 'note', 'by'];
const row = (e) => ({ entry_id: e.id, date_uk: e.date_uk, time_uk: e.time_uk, type: e.type, order_number: e.order_number, order_id: e.order_id, customer: e.customer, amount_gbp: e.amount, method: e.method, reference: e.reference, note: e.note, by: e.by });

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  const formula = /^[=+\-@\t\r]/.test(s); // spreadsheet formula injection from customer text
  return formula || /[",\r\n]/.test(s) ? `"${(formula ? "'" : '') + s.replace(/"/g, '""')}"` : s;
}

function ledgerCsv(entries) {
  const lines = [COLUMNS.join(',')];
  for (const e of entries) { const r = row(e); lines.push(COLUMNS.map((c) => csvCell(c === 'amount_gbp' ? r[c].toFixed(2) : r[c])).join(',')); }
  return lines.join('\r\n') + '\r\n';
}

async function ledgerXlsx(entries, { from, to } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Po-ke Mart Fun shop';
  wb.created = new Date();
  const ws = wb.addWorksheet('Ledger', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = { entry_id: 30, date_uk: 17, time_uk: 8, type: 11, order_number: 17, order_id: 26, customer: 24, amount_gbp: 13, method: 10, reference: 30, note: 60, by: 10 };
  ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: widths[c] }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDFE7F5' } }; });
  for (const e of entries) {
    const r = ws.addRow({ ...row(e), date_uk: ukExcelDate(e.at, true) });
    r.getCell('date_uk').numFmt = UK_DATETIME;
    r.getCell('amount_gbp').numFmt = GBP;
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: COLUMNS.length } };
  const sum = wb.addWorksheet('Totals');
  sum.columns = [{ width: 34 }, { width: 14 }];
  sum.addRow(['Po-ke Mart Fun — ledger totals']).font = { bold: true, size: 14 };
  sum.addRow(['From (UK)', from || '']); sum.addRow(['To (UK)', to || '']);
  sum.addRow(['Fees are ESTIMATES; refunds are negative; entries are never edited — corrections are new entries.']);
  sum.addRow([]);
  const t = ledger.totals(entries);
  for (const [k, v] of [['Sales (items)', t.sale], ['Postage charged', t.postage], ['Est. payment fees', t.fee], ['Refunds', t.refund], ['Adjustments', t.adjustment], ['Net', t.net]]) {
    const r = sum.addRow([k, v]); r.getCell(2).numFmt = GBP; if (k === 'Net') r.font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** All refunds recorded on orders, flattened for lists / the PDF. Within [from, to] by refund date (UK). */
function refundList(orders, from, to, includeDemo = false) {
  const range = sales.cleanRange(from, to);
  const out = [];
  for (const o of orders || []) {
    if (o.demo && !includeDemo) continue;
    for (const r of o.refunds || []) {
      const d = sales.ukParts(r.at).date;
      if (d >= range.from && d <= range.to) out.push({ ...r, date_uk: d, time_uk: sales.ukParts(r.at).time, order_id: o.id, order_number: o.order_number || o.id, customer: (o.shipping_address && o.shipping_address.name) || o.email || '', order_total: o.total, remaining: Math.round((Number(o.total) - sales.refundedOf(o)) * 100) / 100 });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

module.exports = { COLUMNS, ledgerCsv, ledgerXlsx, refundList };
