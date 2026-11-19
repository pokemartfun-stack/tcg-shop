// Admin: Refunds tab, Accounts tab (ledger), the refund dialog and PDF/Excel/CSV downloads.
(function () {
  'use strict';
  const A = () => window.TCGAdmin;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => A().esc(s == null ? '' : s);
  const gbp = (n) => (n < 0 ? '−£' : '£') + Math.abs(Number(n) || 0).toFixed(2);
  const ukDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d)); return m ? `${m[3]}/${m[2]}/${m[1]}` : d; };
  const pad = (n) => String(n).padStart(2, '0');
  const ukToday = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const g = (t) => p.find((x) => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
  const ukWhen = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');

  // ---------- quick ranges ----------
  function presets() {
    const t = ukToday(); const [y, m, d] = t.split('-').map(Number);
    const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y;
    const ty = m > 4 || (m === 4 && d >= 6) ? y : y - 1;
    return [
      ['this-month', 'This month', `${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(last(y, m))}`],
      ['last-month', 'Last month', `${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(last(py, pm))}`],
      ['ytd', `Year to date (${y})`, `${y}-01-01`, t],
      ['tax', `This tax year (${ty}/${String((ty + 1) % 100).padStart(2, '0')})`, `${ty}-04-06`, `${ty + 1}-04-05`],
      ['ltax', `Last tax year (${ty - 1}/${String(ty % 100).padStart(2, '0')})`, `${ty - 1}-04-06`, `${ty}-04-05`],
      ['all', 'All time', '2000-01-01', t],
    ];
  }
  function setupRange(prefix, onChange) {
    const sel = $(prefix + '-preset');
    sel.innerHTML = '<option value="">Custom</option>' + presets().map((p) => `<option value="${p[0]}">${esc(p[1])}</option>`).join('');
    const [, , from, to] = presets()[0];
    $(prefix + '-from').value = from; $(prefix + '-to').value = to; sel.value = 'this-month';
    sel.addEventListener('change', () => { const p = presets().find((x) => x[0] === sel.value); if (p) { $(prefix + '-from').value = p[2]; $(prefix + '-to').value = p[3]; onChange(); } });
    ['from', 'to'].forEach((k) => $(prefix + '-' + k).addEventListener('change', () => { sel.value = ''; onChange(); }));
  }
  const rangeOk = (prefix) => { const f = $(prefix + '-from').value; const t = $(prefix + '-to').value; return /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t) && f <= t; };
  const rangeQ = (prefix) => new URLSearchParams({ from: $(prefix + '-from').value, to: $(prefix + '-to').value }).toString();

  // ---------- downloads (admin login is sent as a header, so we fetch and save the file) ----------
  async function download(url, fallbackName) {
    try {
      const res = await fetch('/api/admin' + url, { headers: { Authorization: 'Bearer ' + A().token() }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || `Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || fallbackName;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (err) { A().msg(err.message); }
  }

  // ---------- Accounts tab ----------
  const TYPE_LABEL = { sale: 'Sale', postage: 'Postage', fee: 'Est. fee', refund: 'Refund', adjustment: 'Correction' };
  function card(k, v, extra) { return `<div class="sales-card ${extra || ''}"><div class="k">${k}</div><div class="v ${v < 0 ? 'neg' : ''}">${gbp(v)}</div></div>`; }
  async function loadLedger() {
    const bad = !rangeOk('ac');
    $('ac-error').hidden = !bad; $('ac-error').textContent = bad ? 'Pick a From date on or before the To date.' : '';
    ['ac-csv', 'ac-xlsx', 'ac-pdf'].forEach((id) => { $(id).disabled = bad; });
    if (bad) return;
    try {
      const d = await A().api('GET', '/ledger?' + rangeQ('ac'));
      const t = d.totals;
      $('ac-count').textContent = `${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'}`;
      $('ac-cards').innerHTML = [card('Sales (items)', t.sale), card('Postage charged', t.postage), card('Est. payment fees', t.fee), card('Refunds', t.refund), card('Corrections', t.adjustment), card('Net', t.net, 'hl')].join('');
      $('ac-rows').innerHTML = d.entries.map((e) => `<tr>
        <td class="nowrap" data-label="Date">${esc(ukDate(e.date_uk))}<br><span class="hint">${esc(e.time_uk)}</span></td>
        <td class="t-${esc(e.type)}" data-label="Type"><strong>${esc(TYPE_LABEL[e.type] || e.type)}</strong></td>
        <td data-label="Order"><code>${esc(e.order_number || e.order_id)}</code></td>
        <td data-label="Customer">${esc(e.customer)}</td>
        <td class="num ${e.amount < 0 ? 'neg' : ''}" data-label="Amount"><strong>${gbp(e.amount)}</strong></td>
        <td data-label="Method">${e.method ? `<span class="badge-s ${e.method === 'manual' ? 'manual' : e.method === 'stripe' ? 'stripe' : ''}">${esc(e.method)}</span>` : ''}</td>
        <td data-label="Reference"><span class="hint">${esc(e.reference)}</span></td>
        <td data-label="Note">${esc(e.note)}</td></tr>`).join('') || '<tr><td colspan="8">No entries in this period.</td></tr>';
    } catch (err) { A().msg(err.message); }
  }

  // ---------- Refunds tab ----------
  let allOrders = [];
  async function loadRefunds() {
    if (!rangeOk('rf')) { $('rf-rows').innerHTML = '<tr><td colspan="8">Pick a From date on or before the To date.</td></tr>'; return; }
    try {
      const [d, o] = await Promise.all([A().api('GET', '/refunds?' + rangeQ('rf')), A().api('GET', '/orders?all=1')]);
      allOrders = o.orders || [];
      $('rf-count').textContent = `${d.refunds.length} in this period`;
      $('rf-rows').innerHTML = d.refunds.map((r) => `<tr>
        <td class="nowrap" data-label="Date">${esc(ukDate(r.date_uk))}<br><span class="hint">${esc(r.time_uk)}</span></td>
        <td data-label="Order"><code>${esc(r.order_number)}</code></td>
        <td data-label="Customer">${esc(r.customer)}</td>
        <td class="num neg" data-label="Amount"><strong>${gbp(-r.amount)}</strong></td>
        <td data-label="How"><span class="badge-s ${r.method === 'manual' ? 'manual' : 'stripe'}">${r.method === 'manual' ? 'Manual (no money moved)' : 'Stripe'}</span>${r.stripe_refund_id ? `<br><span class="hint">${esc(r.stripe_refund_id)}</span>` : ''}</td>
        <td data-label="Reason">${esc(r.reason)}</td>
        <td data-label="By">${esc(r.by)}</td>
        <td data-label="Stock">${(r.restock || []).length ? 'Put back: ' + esc(r.restock.map((l) => `${l.qty}× ${l.productId}`).join(', ')) : '<span class="hint">—</span>'}</td></tr>`).join('') || '<tr><td colspan="8">No refunds in this period.</td></tr>';
      $('rf-total').innerHTML = `Total refunded in this period: <strong>${gbp(d.total)}</strong>. ${d.stripe ? '' : 'Stripe is not set up here, so only manual refunds can be recorded. '}Refunds made in the Stripe dashboard appear here automatically (Stripe webhook <code>charge.refunded</code>).`;
      renderFound();
    } catch (err) { A().msg(err.message); }
  }
  function renderFound() {
    const q = $('rf-search').value.trim().toLowerCase();
    if (!q) { $('rf-found').innerHTML = ''; return; }
    const hits = allOrders.filter((o) => !o.demo && o.status !== 'cancelled' && [o.id, o.order_number, o.email, o.shipping_address && o.shipping_address.name].filter(Boolean).join(' ').toLowerCase().includes(q)).slice(0, 8);
    $('rf-found').innerHTML = hits.map((o) => {
      const left = o.refund ? o.refund.remaining : 0;
      return `<div class="rf-hit"><span><code>${esc(o.order_number || o.id)}</code> · ${esc((o.shipping_address && o.shipping_address.name) || o.email || '')} · ${gbp(o.total)}${o.refund && o.refund.refunded ? ` · refunded ${gbp(o.refund.refunded)}` : ''}</span>
        ${left > 0 ? `<button type="button" class="danger" data-refund="${esc(o.id)}">Refund…</button>` : '<span class="badge-s refunded-part">Fully refunded</span>'}</div>`;
    }).join('') || '<p class="hint">No orders match.</p>';
  }

  // ---------- refund dialog ----------
  let cur = null;
  const dlg = () => $('refund-dialog');
  function showErr(t) { $('rf-error').textContent = t || ''; $('rf-error').hidden = !t; }
  function open(order) {
    if (!order || !order.refund) return;
    cur = order;
    const o = order; const opt = o.refund;
    $('rf-order').textContent = o.order_number || o.id;
    $('rf-summary').innerHTML = `${esc((o.shipping_address && o.shipping_address.name) || '')} · ${esc(o.email || '')}<br>Order total <strong>${gbp(o.total)}</strong> · already refunded <strong>${gbp(opt.refunded)}</strong> · <strong>${gbp(opt.remaining)}</strong> can still be refunded.`;
    $('rf-m-stripe').disabled = !opt.stripe; $('rf-m-manual').disabled = !opt.manual;
    $('rf-m-stripe').checked = opt.stripe; $('rf-m-manual').checked = !opt.stripe;
    $('rf-amount').value = opt.remaining.toFixed(2); $('rf-amount').max = opt.remaining.toFixed(2); $('rf-reason').value = '';
    const done = {}; (o.refunds || []).forEach((r) => (r.restock || []).forEach((l) => { done[l.productId] = (done[l.productId] || 0) + l.qty; }));
    $('rf-lines-body').innerHTML = (o.items || []).map((l, i) => { const free = Math.max(0, l.qty - (done[l.productId] || 0)); return `<div class="rf-line"><span>${esc(l.title || l.productId)} <span class="hint">(bought ${l.qty})</span></span><label class="inline">Put back <input class="rf-q" type="number" min="0" max="${free}" step="1" value="0" data-pid="${esc(l.productId)}" ${free ? '' : 'disabled'} aria-label="Put back ${esc(l.title || l.productId)}" /></label></div>`; }).join('') || '<p class="hint">No item lines on this order.</p>';
    showErr(''); $('rf-step1').hidden = false; $('rf-step2').hidden = true;
    if (!dlg().open) dlg().showModal();
  }
  const method = () => (document.querySelector('input[name="rf-method"]:checked') || {}).value || 'manual';
  const restockLines = () => [...document.querySelectorAll('#rf-lines-body .rf-q')].map((i) => ({ productId: i.dataset.pid, qty: Number(i.value) || 0 })).filter((l) => l.qty > 0);

  function review(e) {
    e.preventDefault();
    const amount = Math.round(Number($('rf-amount').value) * 100) / 100;
    const left = cur.refund.remaining;
    if (!(amount > 0)) return showErr('Enter the amount to refund in £.');
    if (amount > left + 0.0001) return showErr(`You can't refund more than the remaining ${gbp(left)}.`);
    if (!$('rf-reason').value.trim()) return showErr('A reason is required.');
    showErr('');
    const m = method(); const back = restockLines();
    const full = amount >= left - 0.0001;
    const box = $('rf-confirm-text');
    box.className = 'rf-confirm' + (m === 'manual' ? ' manual' : '');
    box.innerHTML = m === 'stripe'
      ? `You are about to refund <strong>${gbp(amount)}</strong> (${full ? 'the whole remaining amount' : 'a part refund'}) of order <strong>${esc(cur.order_number || cur.id)}</strong> <strong>through Stripe</strong>. The money goes back to the buyer's card and <strong>can't be undone</strong>.`
      : `You are about to <strong>record</strong> a refund of <strong>${gbp(amount)}</strong> on order <strong>${esc(cur.order_number || cur.id)}</strong>. <strong>No money is moved by the shop</strong> — only do this if you already paid it back another way (PayPal, bank, cash).`;
    box.innerHTML += `<br>Reason: “${esc($('rf-reason').value.trim())}”${back.length ? `<br>Put back in stock: ${esc(back.map((l) => `${l.qty}× ${l.productId}`).join(', '))}` : ''}${full ? '<br>The order will be marked <strong>Refunded</strong>.' : ''}`;
    $('rf-go').textContent = m === 'stripe' ? `Yes, refund ${gbp(amount)} via Stripe` : `Yes, record ${gbp(amount)} refund`;
    $('rf-step1').hidden = true; $('rf-step2').hidden = false;
  }
  async function go() {
    const btn = $('rf-go'); btn.disabled = true;
    try {
      const d = await A().api('POST', '/orders/' + encodeURIComponent(cur.id) + '/refund', { amount: Number($('rf-amount').value), reason: $('rf-reason').value.trim(), method: method(), restock: restockLines() });
      dlg().close();
      A().msg(`Refund of ${gbp(d.refund.amount)} ${d.refund.method === 'stripe' ? 'sent through Stripe' : 'recorded (manual — no money moved)'} for order ${cur.order_number || cur.id}` + A().syncNote(d), !d.githubError);
      document.dispatchEvent(new CustomEvent('admin:orders-changed'));
      refreshVisible();
    } catch (err) {
      $('rf-step1').hidden = false; $('rf-step2').hidden = true; showErr(err.message);
    } finally { btn.disabled = false; }
  }

  function refreshVisible() {
    const t = window.TCGAdminTabs && window.TCGAdminTabs.current();
    if (t === 'refunds') loadRefunds(); else if (t === 'accounts') loadLedger();
  }

  document.addEventListener('admin:tab', (e) => { if (e.detail.tab === 'refunds') loadRefunds(); if (e.detail.tab === 'accounts') loadLedger(); });
  document.addEventListener('admin:orders-changed', refreshVisible);
  window.TCGAdminAcc = { open, download };

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('accounts-section')) return;
    setupRange('ac', loadLedger); setupRange('rf', loadRefunds);
    $('ac-csv').addEventListener('click', () => download('/ledger/csv?' + rangeQ('ac'), 'ledger.csv'));
    $('ac-xlsx').addEventListener('click', () => download('/ledger/xlsx?' + rangeQ('ac'), 'ledger.xlsx'));
    $('ac-pdf').addEventListener('click', () => download('/accounts/report.pdf?' + rangeQ('ac'), 'accounts-report.pdf'));
    $('ac-adjust-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (!confirm('Add this correction to the permanent ledger? It can\'t be edited or deleted afterwards — only corrected by another entry.')) return;
      try {
        await A().api('POST', '/ledger/adjustment', { amount: Number(f.amount.value), note: f.note.value, order_id: f.order_id.value.trim() || undefined });
        f.reset(); A().msg('Correction added to the ledger', true); loadLedger();
      } catch (err) { A().msg(err.message); }
    });
    $('rf-search').addEventListener('input', renderFound);
    $('rf-found').addEventListener('click', (e) => { const b = e.target.closest('[data-refund]'); if (b) open(allOrders.find((o) => o.id === b.dataset.refund)); });
    $('refund-form').addEventListener('submit', review);
    $('rf-cancel').addEventListener('click', () => dlg().close());
    $('rf-back').addEventListener('click', () => { $('rf-step1').hidden = false; $('rf-step2').hidden = true; });
    $('rf-go').addEventListener('click', go);
    $('rf-full').addEventListener('click', () => { $('rf-amount').value = cur.refund.remaining.toFixed(2); });
  });
})();
