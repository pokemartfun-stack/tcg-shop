// Admin "Customer reviews": switch the shop's reviews section on/off, and approve (show), hide,
// feature (pin to the top) or delete each review. Review text is always escaped before display.
(function () {
  'use strict';
  const A = () => window.TCGAdmin;
  const $ = (id) => document.getElementById(id);
  const STATUS_LABEL = { pending: 'Pending', approved: 'Shown', hidden: 'Hidden' };
  let state = { enabled: false, reviews: [], counts: {} };
  let filter = 'pending';
  let busy = false;

  const ukDateTime = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const starText = (n) => '★'.repeat(n) + `<span class="off">${'★'.repeat(5 - n)}</span>`;

  function apply(d) {
    state = d;
    $('rv-enabled').checked = d.enabled;
    $('rv-enabled-text').textContent = d.enabled ? 'Reviews are ON — shown on the shop' : 'Reviews are OFF — hidden from the shop';
    const c = d.counts || {};
    $('rv-counts').textContent = `· ${c.pending || 0} pending · ${c.approved || 0} shown · ${c.hidden || 0} hidden`;
    document.querySelectorAll('.rv-filter').forEach((b) => {
      const k = b.dataset.filter;
      const n = k === 'all' ? d.reviews.length : (c[k] || 0);
      b.textContent = `${{ pending: 'Pending', approved: 'Shown', hidden: 'Hidden', featured: 'Featured', all: 'All' }[k]} (${n})`;
      b.classList.toggle('on', k === filter);
    });
    renderRows();
  }

  function renderRows() {
    const esc = A().esc;
    const list = state.reviews.filter((r) => filter === 'all' || (filter === 'featured' ? r.featured : r.status === filter));
    $('rv-rows').innerHTML = list.length ? list.map((r) => `
      <tr data-id="${esc(r.id)}">
        <td>${esc(ukDateTime(r.createdAt))}</td>
        <td><span class="rv-stars" aria-label="${r.rating} stars">${starText(r.rating)}</span></td>
        <td>${esc(r.name)}</td>
        <td class="rv-text">${esc(r.comment)}</td>
        <td>${r.order ? esc(r.order) + (r.verified ? '<span class="rv-verified">✔ matches an order</span>' : '') : '<span class="hint">—</span>'}</td>
        <td><span class="rv-status ${esc(r.status)}">${STATUS_LABEL[r.status] || esc(r.status)}</span>${r.featured ? '<br><span class="rv-feat">★ Featured</span>' : ''}</td>
        <td><div class="rv-actions">
          ${r.status !== 'approved' ? '<button type="button" class="show" data-act="show">Show</button>' : ''}
          ${r.status !== 'hidden' ? '<button type="button" class="ghost" data-act="hide">Hide</button>' : ''}
          ${r.featured ? '<button type="button" class="ghost" data-act="unfeature">Unfeature</button>' : '<button type="button" class="feature" data-act="feature">★ Feature</button>'}
          <button type="button" class="danger" data-act="delete">Delete</button>
        </div></td>
      </tr>`).join('')
      : `<tr><td colspan="7" class="hint">${filter === 'pending' ? 'No reviews waiting for approval.' : 'No reviews here.'}</td></tr>`;
  }

  async function load() {
    try { apply(await A().api('GET', '/reviews')); } catch (err) { A().msg('Reviews: ' + err.message); }
  }

  async function act(id, what) {
    if (busy) return;
    const r = state.reviews.find((x) => x.id === id);
    if (!r) return;
    if (what === 'delete' && !confirm(`Delete the review from "${r.name}" for good?`)) return;
    busy = true;
    try {
      let d;
      if (what === 'delete') d = await A().api('DELETE', '/reviews/' + encodeURIComponent(id));
      else {
        const patch = { show: { status: 'approved' }, hide: { status: 'hidden' }, feature: { featured: true }, unfeature: { featured: false } }[what];
        d = await A().api('PATCH', '/reviews/' + encodeURIComponent(id), patch);
      }
      apply(d);
      const words = { show: 'Review is now shown on the shop', hide: 'Review hidden', feature: 'Review featured (pinned to the top)', unfeature: 'Review no longer featured', delete: 'Review deleted' };
      A().msg(words[what] + A().syncNote(d), !d.githubError);
    } catch (err) { A().msg(err.message); } finally { busy = false; }
  }

  let bound = false;
  document.addEventListener('admin:ready', () => {
    if (!$('reviews-section')) return;
    load();
    if (bound) return;
    bound = true;
    $('rv-enabled').addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        const d = await A().api('PUT', '/reviews/settings', { enabled: on });
        apply(d);
        A().msg((on ? 'Reviews switched ON — the shop now shows the reviews section' : 'Reviews switched OFF — hidden from the shop') + A().syncNote(d), !d.githubError);
      } catch (err) { e.target.checked = !on; A().msg(err.message); }
    });
    document.querySelector('.rv-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      apply(state);
    });
    $('rv-rows').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) act(b.closest('tr').dataset.id, b.dataset.act);
    });
  });
})();
