// Shop-page reviews carousel: the pure maths in public/js/reviews.js (no browser needed),
// plus a guard that shopper text is never written into the page as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../public/js/reviews.js');

describe('reviews carousel', () => {
  it('shows 1 card on phones, 2 on tablets, 3 on desktop, never more than there are reviews', () => {
    assert.equal(C.perView(360, 10), 1);
    assert.equal(C.perView(700, 10), 2);
    assert.equal(C.perView(1300, 10), 3);
    assert.equal(C.perView(1300, 2), 2);
    assert.equal(C.perView(1300, 1), 1);
    assert.equal(C.perView(1300, 0), 1);
  });

  it('steps forward and back and loops round at both ends', () => {
    assert.deepEqual(C.step(0, 1, 5, 3), { index: 1, wrapped: false });
    assert.deepEqual(C.step(2, 1, 5, 3), { index: 0, wrapped: true });
    assert.deepEqual(C.step(0, -1, 5, 3), { index: 2, wrapped: true });
    assert.deepEqual(C.step(3, 1, 4, 1), { index: 0, wrapped: true });
    assert.equal(C.lastIndex(2, 3), 0);
  });

  it('only rotates when something is off-screen and nothing pauses it', () => {
    const base = { count: 5, per: 3, reducedMotion: false, paused: false, hidden: false };
    assert.equal(C.shouldRotate(base), true);
    assert.equal(C.shouldRotate({ ...base, count: 1, per: 1 }), false, 'one review: no rotation');
    assert.equal(C.shouldRotate({ ...base, count: 3 }), false, 'all visible: no rotation');
    assert.equal(C.shouldRotate({ ...base, reducedMotion: true }), false);
    assert.equal(C.shouldRotate({ ...base, paused: true }), false);
    assert.equal(C.shouldRotate({ ...base, hidden: true }), false);
    assert.ok(C.INTERVAL_MS >= 4000 && C.INTERVAL_MS <= 6000);
  });

  it('puts featured reviews first and otherwise keeps the server order', () => {
    const out = C.order([{ id: 'a' }, { id: 'b', featured: true }, { id: 'c' }, { id: 'd', featured: true }]);
    assert.deepEqual(out.map((r) => r.id), ['b', 'd', 'a', 'c']);
    assert.deepEqual(C.order(undefined), []);
  });

  it('never uses innerHTML for review text', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reviews.js'), 'utf8');
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
