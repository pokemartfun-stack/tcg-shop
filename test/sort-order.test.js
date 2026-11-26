'use strict';
// Shop grid sort: in-stock first in every mode; newest ties break in catalog order.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/shop.js'), 'utf8');

function extractSorters() {
  const start = src.indexOf('const stockLast =');
  assert.ok(start >= 0, 'applyFilters should define stockLast');
  const end = src.indexOf('list = list.slice().sort', start);
  assert.ok(end > start, 'applyFilters should sort with the sorters map');
  return new Function(`${src.slice(start, end)}; return { stockLast, sorters };`)();
}

function ids(list, sort) {
  const { sorters } = extractSorters();
  return list.slice().sort(sorters[sort] || sorters.newest).map((p) => p.id);
}

const items = [
  { id: 'old-cheap-out', title: 'Zebra', price_gbp: 1, stock: 0, added_at: '2026-01-01T00:00:00.000Z', _i: 0 },
  { id: 'same-date-mid-in', title: 'Alpha', price_gbp: 5, stock: 2, added_at: '2026-06-01T00:00:00.000Z', _i: 1 },
  { id: 'same-date-cheap-in', title: 'Beta', price_gbp: 2, stock: 1, added_at: '2026-06-01T00:00:00.000Z', _i: 2 },
  { id: 'newest-expensive-out', title: 'Charlie', price_gbp: 9, stock: 0, added_at: '2026-12-01T00:00:00.000Z', _i: 3 },
  { id: 'no-date-in', title: 'Delta', price_gbp: 3, stock: 4, _i: 4 },
];

describe('shop grid sort order', () => {
  it('keeps the In stock only filter', () => {
    assert.match(src, /if \(f\.inStock && p\.stock < 1\) return false;/);
  });

  it('treats stock < 1 as out of stock for the stockLast tie-break', () => {
    const { stockLast } = extractSorters();
    assert.equal(stockLast({ stock: 2 }, { stock: 0 }), -1);
    assert.equal(stockLast({ stock: 0 }, { stock: 2 }), 1);
    assert.equal(stockLast({ stock: 1 }, { stock: 3 }), 0);
    assert.equal(stockLast({ stock: 0 }, { stock: 0 }), 0);
  });

  it('newest: in-stock first, then date descending, then catalog order (_i ascending)', () => {
    assert.deepEqual(ids(items, 'newest'), [
      'same-date-mid-in',
      'same-date-cheap-in',
      'no-date-in',
      'newest-expensive-out',
      'old-cheap-out',
    ]);
  });

  it('price-asc: in-stock first, then price ascending', () => {
    assert.deepEqual(ids(items, 'price-asc'), [
      'same-date-cheap-in',
      'no-date-in',
      'same-date-mid-in',
      'old-cheap-out',
      'newest-expensive-out',
    ]);
  });

  it('price-desc: in-stock first, then price descending', () => {
    assert.deepEqual(ids(items, 'price-desc'), [
      'same-date-mid-in',
      'no-date-in',
      'same-date-cheap-in',
      'newest-expensive-out',
      'old-cheap-out',
    ]);
  });

  it('name: in-stock first, then title localeCompare en-GB', () => {
    assert.deepEqual(ids(items, 'name'), [
      'same-date-mid-in',
      'same-date-cheap-in',
      'no-date-in',
      'newest-expensive-out',
      'old-cheap-out',
    ]);
  });
});
