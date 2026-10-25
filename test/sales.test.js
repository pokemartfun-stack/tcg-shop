// Sales figures: fees, summaries, UK tax years, CSV.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sales = require('../server/sales');

const line = (id, price, qty, cost) => ({ productId: id, title: id, price_gbp: price, qty, line_total: price * qty, cost_gbp: cost });
const order = (o) => ({
  id: o.id, method: 'stripe', status: 'paid', demo: false, email: 'x@example.com',
  shipping_address: { name: 'Test Buyer', postcode: 'SW1A 1AA' },
  postage: { service: 'Royal Mail Tracked 48', band: 'Large Letter', amount: 2.9, free: false },
  ...o,
});

describe('estimated payment fees', () => {
  it('Stripe 1.5% + 20p and PayPal 2.9% + 30p of the order total', () => {
    assert.equal(sales.estimateFee({ method: 'stripe', total: 20 }), 0.5);
    assert.equal(sales.estimateFee({ method: 'paypal', total: 20 }), 0.88);
    assert.equal(sales.estimateFee({ method: 'paypal', total: 20, demo: true }), 0);
    assert.equal(sales.estimateFee({ method: 'demo', total: 20 }), 0);
    assert.equal(sales.estimateFee({ method: 'stripe', total: 100 }, { stripe: { percent: 2.5, fixed: 0.2 } }), 2.7);
  });
  it('fee settings are validated and merged', () => {
    assert.deepEqual(sales.validateFees({ stripe: { percent: 2 } }).fees, { stripe: { percent: 2, fixed: 0.2 }, paypal: { percent: 2.9, fixed: 0.3 } });
    assert.ok(sales.validateFees({ paypal: { fixed: -1 } }).error);
    assert.ok(sales.validateFees({ stripe: { percent: 'x' } }).error);
    assert.ok(sales.validateFees({ stripe: { percent: 50 } }).error);
  });
});

describe('order figures', () => {
  it('net = takings - fee; profit = net - cost of goods - postage paid', () => {
    const f = sales.orderFigures(order({ items: [line('a', 10, 2, 4), line('b', 5, 1, 1.5)], subtotal: 25, total: 27.9 }));
    assert.deepEqual(f, { items: 3, sales: 25, postage: 2.9, fee: 0.62, net: 27.28, cost: 9.5, postagePaid: 2.9, profit: 14.88, missingCost: 0 });
  });
  it('uses the real postage paid when entered, and flags lines without a cost price', () => {
    const f = sales.orderFigures(order({ items: [line('a', 10, 1, null)], subtotal: 10, total: 12.9, postage_paid: 2.7 }));
    assert.equal(f.postagePaid, 2.7);
    assert.equal(f.missingCost, 1);
    assert.equal(f.profit, money(12.9 - 0.39 - 2.7));
  });
});
function money(n) { return Math.round(n * 100) / 100; }

describe('UK dates and tax years', () => {
  it('tax year runs 6 April to 5 April', () => {
    assert.equal(sales.taxYearStart('2026-04-05'), 2025);
    assert.equal(sales.taxYearStart('2026-04-06'), 2026);
    assert.equal(sales.taxYearStart('2027-01-15'), 2026);
    assert.deepEqual(sales.taxYear(2026), { id: 'tax-2026', label: 'Tax year 2026/27 (6 Apr 2026 – 5 Apr 2027)', from: '2026-04-06', to: '2027-04-05' });
  });
  it('dates are UK local time (BST): 23:30 UTC on 5 Apr is 6 Apr in the UK', () => {
    assert.deepEqual(sales.ukParts('2026-04-05T23:30:00Z'), { date: '2026-04-06', time: '00:30', month: '2026-04' });
    assert.deepEqual(sales.ukParts('2026-12-31T23:30:00Z'), { date: '2026-12-31', time: '23:30', month: '2026-12' }); // GMT in winter
    assert.equal(sales.ukParts('2026-10-31T23:30:00Z').month, '2026-10');
  });
  it('presets: this/last month, year to date, this/last tax year', () => {
    const p = Object.fromEntries(sales.presets(new Date('2026-10-25T12:00:00Z')).map((x) => [x.id, x]));
    assert.deepEqual([p['this-month'].from, p['this-month'].to], ['2026-10-01', '2026-10-31']);
    assert.deepEqual([p['last-month'].from, p['last-month'].to], ['2026-09-01', '2026-09-30']);
    assert.deepEqual([p.ytd.from, p.ytd.to], ['2026-01-01', '2026-10-25']);
    assert.deepEqual([p['tax-2026'].from, p['tax-2026'].to], ['2026-04-06', '2027-04-05']);
    assert.deepEqual([p['tax-2025'].from, p['tax-2025'].to], ['2025-04-06', '2026-04-05']);
    const jan = Object.fromEntries(sales.presets(new Date('2027-01-10T12:00:00Z')).map((x) => [x.id, x]));
    assert.deepEqual([jan['last-month'].from, jan['last-month'].to], ['2026-12-01', '2026-12-31']);
    assert.ok(jan['tax-2026']);
  });
  it('admin-chosen range: default 1st of month to today; From must be on/before To', () => {
    const now = new Date('2026-10-25T07:00:00Z');
    assert.deepEqual(sales.parseRange(undefined, undefined, now), { from: '2026-10-01', to: '2026-10-25' });
    assert.deepEqual(sales.parseRange('2026-10-20', '2026-10-20', now), { from: '2026-10-20', to: '2026-10-20' });
    assert.match(sales.parseRange('2026-10-20', '2026-10-01', now).error, /From date \(20\/10\/2026\) must be on or before the To date \(01\/10\/2026\)/);
    assert.match(sales.parseRange('2026-02-30', '2026-03-01', now).error, /From date is not a valid date/);
    assert.match(sales.parseRange('2026-01-01', '01/02/2026', now).error, /To date/);
    assert.equal(sales.ukDate('2026-04-06'), '06/04/2026');
    // just after midnight UK (BST) on 1 Nov -> new month already
    assert.deepEqual(sales.parseRange(undefined, undefined, new Date('2026-04-30T23:30:00Z')), { from: '2026-05-01', to: '2026-05-01' });
  });
  it('range is inclusive of both UK days', () => {
    const o = (id, at) => order({ id, createdAt: at, items: [line('a', 1, 1, 0)], subtotal: 1, total: 3.9 });
    const list = [o('before', '2026-09-30T22:59:00Z'), o('first', '2026-09-30T23:00:00Z'), o('last', '2026-10-25T22:59:00Z'), o('lateLast', '2026-10-25T23:59:00Z'), o('after', '2026-10-26T00:00:00Z')];
    // 23:00 UTC 30 Sep = 00:00 BST 1 Oct; clocks go back 25 Oct, so 23:59 UTC that night is still 25 Oct UK
    assert.deepEqual(sales.ordersInRange(list, '2026-10-01', '2026-10-25').map((x) => x.id).sort(), ['first', 'last', 'lateLast']);
  });
  it('bad or reversed ranges are cleaned up', () => {
    assert.deepEqual(sales.cleanRange('2026-05-01', '2026-04-01'), { from: '2026-04-01', to: '2026-05-01' });
    assert.deepEqual(sales.cleanRange('nope', ''), { from: '2000-01-01', to: '2999-12-31' });
  });
});

const ORDERS = [
  order({ id: 'o1', createdAt: '2026-04-05T22:59:00Z', items: [line('a', 10, 1, 4)], subtotal: 10, total: 12.9 }), // 23:59 BST 5 Apr = old tax year
  order({ id: 'o2', createdAt: '2026-04-05T23:01:00Z', method: 'paypal', items: [line('b', 20, 2, 5)], subtotal: 40, total: 43.75, postage: { service: 'Royal Mail Tracked 48', band: 'Small Parcel', amount: 3.75 } }),
  order({ id: 'o3', createdAt: '2026-05-10T10:00:00Z', items: [line('c', 5, 1, null)], subtotal: 5, total: 7.9, status: 'posted', tracking_number: 'AB123456789GB', posted_at: '2026-05-11T09:00:00Z' }),
  order({ id: 'o4', createdAt: '2026-05-12T10:00:00Z', items: [line('d', 8, 1, 2)], subtotal: 8, total: 10.9, status: 'refunded' }),
  order({ id: 'o5', createdAt: '2026-05-13T10:00:00Z', items: [line('e', 9, 1, 2)], subtotal: 9, total: 11.9, demo: true, method: 'demo' }),
  order({ id: 'o6', createdAt: '2026-06-01T10:00:00Z', items: [line('f', 3, 1, 1)], subtotal: 3, total: 5.9, status: 'cancelled' }),
];

describe('summaries', () => {
  it('tax year 2026/27 starts with the order placed at 00:01 UK time on 6 April', () => {
    const s = sales.summarise(ORDERS, sales.taxYear(2026));
    assert.equal(s.totals.orders, 2); // o2, o3 (o4 refunded, o5 demo, o6 cancelled excluded)
    assert.equal(s.totals.items, 3);
    assert.equal(s.totals.sales, 45);
    assert.equal(s.totals.postage, 6.65);
    assert.equal(s.totals.fees, money(43.75 * 0.029 + 0.3 + 7.9 * 0.015 + 0.2));
    assert.equal(s.totals.cost, 10);
    assert.equal(s.totals.missing_cost_items, 1);
    assert.deepEqual(s.excluded, { demo: 1, refunded: 1, cancelled: 1 });
    assert.deepEqual(s.months.map((m) => [m.month, m.label, m.orders]), [['2026-04', 'Apr 2026', 1], ['2026-05', 'May 2026', 1]]);
    assert.equal(s.to_post, 1); // o2 still to post
    const last = sales.summarise(ORDERS, sales.taxYear(2025));
    assert.deepEqual([last.totals.orders, last.totals.sales], [1, 10]);
  });
  it('profit adds up: net - cost - postage paid', () => {
    const t = sales.summarise(ORDERS, { from: '2026-01-01', to: '2026-12-31' }).totals;
    assert.equal(t.net, money(t.sales + t.postage - t.fees));
    assert.equal(t.profit, money(t.net - t.cost - t.postage_paid));
  });
  it('demo orders only when asked', () => {
    const s = sales.summarise(ORDERS, { from: '2026-05-01', to: '2026-05-31', includeDemo: true });
    assert.equal(s.totals.orders, 2);
    assert.equal(s.excluded.demo, 0);
    assert.equal(sales.summarise(ORDERS, { from: '2026-05-01', to: '2026-05-31' }).totals.orders, 1);
  });
  it('orders are listed newest first', () => {
    assert.deepEqual(sales.ordersInRange(ORDERS, '2026-01-01', '2026-12-31').map((o) => o.id), ['o6', 'o5', 'o4', 'o3', 'o2', 'o1']);
  });
});

describe('CSV for records', () => {
  const parse = (csv) => csv.trim().split('\r\n').map((r) => r.split(','));
  it('one row per order line, oldest first, order money only on the first line', () => {
    const o = order({ id: 'multi', createdAt: '2026-07-01T09:00:00Z', items: [line('a', 10, 2, 3), line('b', 4, 1, null)], subtotal: 24, total: 26.9 });
    const rows = parse(sales.toCsv([o, ORDERS[0]], {}));
    const head = rows[0];
    assert.deepEqual(head, sales.CSV_COLUMNS);
    assert.equal(rows.length, 4);
    const col = (r, k) => r[head.indexOf(k)];
    assert.equal(col(rows[1], 'order_id'), 'o1');
    assert.equal(col(rows[1], 'order_date_uk'), '2026-04-05');
    assert.equal(col(rows[2], 'order_id'), 'multi');
    assert.equal(col(rows[2], 'line_total_gbp'), '20.00');
    assert.equal(col(rows[2], 'line_cost_gbp'), '6.00');
    assert.equal(col(rows[2], 'order_total_gbp'), '26.90');
    assert.equal(col(rows[2], 'postage_charged_gbp'), '2.90');
    assert.equal(col(rows[3], 'order_total_gbp'), ''); // not repeated on line 2
    assert.equal(col(rows[3], 'unit_cost_gbp'), '');
    const sum = rows.slice(1).reduce((n, r) => n + Number(col(r, 'order_total_gbp') || 0), 0);
    assert.equal(money(sum), money(26.9 + 12.9));
  });
  it('filters by range and demo; refunded orders show no fee/profit', () => {
    const rows = parse(sales.toCsv(ORDERS, { from: '2026-05-01', to: '2026-05-31' }));
    const head = rows[0];
    assert.deepEqual(rows.slice(1).map((r) => r[head.indexOf('order_id')]), ['o3', 'o4']);
    const refunded = rows[2];
    assert.equal(refunded[head.indexOf('status')], 'refunded');
    assert.equal(refunded[head.indexOf('est_profit_gbp')], '');
    assert.equal(rows[1][head.indexOf('tracking_number')], 'AB123456789GB');
    assert.equal(rows[1][head.indexOf('posted_date_uk')], '2026-05-11');
    assert.equal(parse(sales.toCsv(ORDERS, { from: '2026-05-01', to: '2026-05-31', includeDemo: true })).length, 4);
  });
  it('quotes commas and blocks spreadsheet formulas in customer text; negative numbers stay numbers', () => {
    const o = order({ id: 'evil', createdAt: '2026-07-02T09:00:00Z', shipping_address: { name: '=HYPERLINK("x")', postcode: 'A1 1AA' }, items: [line('a', 1, 1, 50)], subtotal: 1, total: 3.9 });
    const csv = sales.toCsv([o], {});
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
    assert.match(csv, /,-\d+\.\d\d,/); // loss-making order: plain negative profit
  });
});
