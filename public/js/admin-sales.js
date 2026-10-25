// Admin "Sales" section: order list + status workflow, money summary, CSV for HMRC records.
(function () {
  'use strict';
  const A = () => window.TCGAdmin;
  const $ = (id) => document.getElementById(id);
  const gbp = (n) => (n < 0 ? '−£' : '£') + Math.abs(Number(n) || 0).toFixed(2);
  const STATUS_LABEL = { paid: 'Paid — to post', posted: 'Posted', refunded: 'Refunded', cancelled: 'Cancelled' };
  const METHOD_LABEL = { stripe: 'Card (Stripe)', paypal: 'PayPal', demo: 'Demo' };
  const BAND_LABEL = { large_letter: 'Large Letter', small_parcel: 'Small Parcel' };
  const bandLabel = (o) => (o.postage && o.postage.band ? BAND_LABEL[o.postage.band] || o.postage.band : '');
  const ukDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d)); return m ? `${m[3]}/${m[2]}/${m[1]}` : d; }; // dd/mm/yyyy
  const ukToday = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const g = (t) => p.find((x) => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
  let orders = [];
  const open = new Set();

  function query() {
    const p = new URLSearchParams({ from: $('s-from').value, to: $('s-to').value });
    if ($('s-demo').checked) p.set('demo', '1');
    return p.toString();
  }

  /** From <= To, both real dates. Shows a friendly message and returns false if not. */
  function checkRange() {
    const f = $('s-from').value, t = $('s-to').value;
    let err = '';
    const sane = (d) => /^(19|20)\d\d-\d\d-\d\d$/.test(d);
    if (!f || !t) err = 'Pick both a From and a To date.';
    else if (!sane(f) || !sane(t)) err = 'Enter full dates as dd/mm/yyyy.';
    else if (f > t) err = `The From date (${ukDate(f)}) is after the To date (${ukDate(t)}). Pick a From date on or before the To date.`;
    $('s-range-error').textContent = err;
    $('s-range-error').hidden = !err;
    ['s-from', 's-to'].forEach((id) => $(id).setAttribute('aria-invalid', err ? 'true' : 'false'));
    $('s-csv').disabled = $('s-xlsx').disabled = Boolean(err);
    $('sales-section').classList.toggle('range-bad', Boolean(err)); // grey out figures from the last good range
    if (err) $('s-range-text').textContent = '';
    if (!err) {
      const days = Math.round((Date.parse(t) - Date.parse(f)) / 86400000) + 1;
      $('s-range-text').textContent = `Showing ${ukDate(f)} to ${ukDate(t)} (UK time, both days included · ${days} day${days === 1 ? '' : 's'})`;
    }
    return !err;
  }

  function showStorage(st) {
    const box = $('orders-warn');
    if (!st) return;
    box.hidden = false;
    if (st.warning) {
      box.className = 'storage-warn';
      box.innerHTML = '⚠️ ' + A().esc(st.warning) + (st.pending ? ' <button type="button" id="retry-sync">Retry saving now</button>' : '');
    } else {
      box.className = 'storage-warn ok';
      box.textContent = '✅ Orders are saved to the private repo ' + st.repo + '.';
    }
  }

  function card(k, v, extra) {
    return `<div class="sales-card ${extra || ''}"><div class="k">${k}</div><div class="v ${v < 0 ? 'neg' : ''}">${typeof v === 'number' ? gbp(v) : v}</div></div>`;
  }

  function renderSummary(s) {
    const t = s.totals;
    $('s-cards').innerHTML = [
      card('Orders', String(t.orders)), card('Items sold', String(t.items)),
      card('Sales (items)', t.sales), card('Postage charged', t.postage),
      card('Takings', t.sales + t.postage), card('Est. payment fees', -t.fees),
      card('Net received', t.net, 'hl'), card('Cost of goods', -t.cost),
      card('Postage paid', -t.postage_paid), card('Profit', t.profit, 'hl'),
    ].join('');
    const notes = [];
    notes.push(`Fees are <strong>estimated</strong> (Stripe ${s.fees.stripe.percent}% + ${gbp(s.fees.stripe.fixed)}, PayPal ${s.fees.paypal.percent}% + ${gbp(s.fees.paypal.fixed)}).`);
    if (t.missing_cost_items) notes.push(`${t.missing_cost_items} item line(s) have no cost price, so profit is overstated.`);
    const ex = s.excluded;
    if (ex.refunded || ex.cancelled) notes.push(`Not counted: ${ex.refunded} refunded, ${ex.cancelled} cancelled.`);
    if (ex.demo && !s.includeDemo) notes.push(`${ex.demo} demo/test order(s) hidden.`);
    if (s.to_post) notes.push(`<strong>${s.to_post} order(s) waiting to be posted.</strong>`);
    $('s-notes').innerHTML = notes.join(' ');
    const head = '<thead><tr><th>Month</th><th class="num">Orders</th><th class="num">Items</th><th class="num">Sales</th><th class="num">Postage</th><th class="num">Est. fees</th><th class="num">Net</th><th class="num">Cost of goods</th><th class="num">Postage paid</th><th class="num">Profit</th></tr></thead>';
    const row = (label, m, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${m.orders}</td><td class="num">${m.items}</td><td class="num">${gbp(m.sales)}</td><td class="num">${gbp(m.postage)}</td><td class="num">${gbp(m.fees)}</td><td class="num">${gbp(m.net)}</td><td class="num">${gbp(m.cost)}</td><td class="num">${gbp(m.postage_paid)}</td><td class="num">${gbp(m.profit)}</td></tr>`;
    $('s-months').innerHTML = head + '<tbody>' + s.months.map((m) => row(m.label, m)).join('') + (s.months.length ? row('Total', t, 'total') : '<tr><td colspan="10">No orders in this period.</td></tr>') + '</tbody>';
  }

  function addressHtml(a) {
    if (!a) return '<em>No address</em>';
    const esc = A().esc;
    return [a.name, a.line1, a.line2, a.town, a.county, a.postcode, a.country || 'United Kingdom'].filter(Boolean).map(esc).join('<br>');
  }

  function detailHtml(o) {
    const esc = A().esc;
    const f = o.figures;
    const lines = (o.items || []).map((l) => `<tr><td class="nowrap">${l.qty} ×</td><td>${esc(l.title || l.productId)}</td><td class="num">${gbp(l.price_gbp * l.qty)}</td><td class="num hint">${Number.isFinite(l.cost_gbp) ? 'cost ' + gbp(l.cost_gbp * l.qty) : 'no cost'}</td></tr>`).join('');
    const pp = o.postage_paid != null ? o.postage_paid : '';
    return `<tr class="order-detail" data-for="${esc(o.id)}"><td colspan="10"><div class="od">
      <div><h4>Post to</h4><address>${addressHtml(o.shipping_address)}</address>
        <p>${esc(o.email || '')}${o.shipping_address && o.shipping_address.phone ? '<br>☎ ' + esc(o.shipping_address.phone) : ''}</p></div>
      <div><h4>Items</h4><table class="lines">${lines}</table>
        <p class="hint">Postage: Royal Mail Tracked 48 ${esc(bandLabel(o))}${o.postage && o.postage.free ? ' (free)' : ''} ${gbp((o.postage && o.postage.amount) || 0)}<br>
        Est. fee ${gbp(f.fee)} · cost ${gbp(f.cost)} · postage paid ${gbp(f.postagePaid)} · <strong>profit ${gbp(f.profit)}</strong>
        ${o.payment_ref ? '<br>Payment ref: ' + esc(o.payment_ref) : ''}${o.stock_conflict ? '<br><strong>⚠️ Stock clash — check before posting</strong>' : ''}</p></div>
      <form class="od-form" data-id="${esc(o.id)}"><h4>Update</h4>
        <label>Status<select name="status">${Object.keys(STATUS_LABEL).map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
        <label>Royal Mail tracking number<input name="tracking_number" value="${esc(o.tracking_number || '')}" placeholder="e.g. AB123456789GB" autocomplete="off" /></label>
        <label>Postage you paid £ (blank = same as charged)<input name="postage_paid" type="number" step="0.01" min="0" value="${pp}" placeholder="${((o.postage && o.postage.amount) || 0).toFixed(2)}" /></label>
        <label>Note<input name="note" value="${esc(o.note || '')}" maxlength="500" /></label>
        <div><button type="submit">Save</button> ${o.status === 'paid' ? '<button type="button" class="ghost" data-act="posted">Mark as posted</button>' : ''}</div>
        ${o.posted_at ? `<span class="hint">Posted ${esc(new Date(o.posted_at).toLocaleString('en-GB', { timeZone: 'Europe/London' }))}</span>` : ''}
      </form></div></td></tr>`;
  }

  function renderOrders() {
    const esc = A().esc;
    const onlyPaid = $('s-only-paid').checked;
    const list = orders.filter((o) => !onlyPaid || o.status === 'paid');
    $('s-orders-count').textContent = `(${list.length}, newest first)`;
    $('s-orders').innerHTML = list.map((o) => {
      const items = (o.items || []).reduce((n, l) => n + (l.qty || 0), 0);
      const isOpen = open.has(o.id);
      const row = `<tr class="order-row ${isOpen ? 'open' : ''} ${o.demo ? 'is-demo' : ''}" data-id="${esc(o.id)}">
        <td class="nowrap" data-label="Date">${esc(ukDate(o.uk.date))}<br><span class="hint">${esc(o.uk.time)}</span></td>
        <td data-label="Order"><code>${esc(o.id)}</code></td>
        <td data-label="Customer">${esc((o.shipping_address && o.shipping_address.name) || '')}<br><span class="hint">${esc(o.email || '')}</span></td>
        <td data-label="Items">${items} item${items === 1 ? '' : 's'}<br><span class="hint">${esc((o.items || []).map((l) => l.title).join(', ').slice(0, 60))}</span></td>
        <td class="num" data-label="Subtotal">${gbp(o.subtotal)}</td>
        <td class="num" data-label="Postage">${gbp((o.postage && o.postage.amount) || 0)}<br><span class="hint">${esc(bandLabel(o))}</span></td>
        <td class="num" data-label="Total"><strong>${gbp(o.total)}</strong></td>
        <td data-label="Paid by">${METHOD_LABEL[o.method] || esc(o.method || '')}</td>
        <td data-label="Status"><span class="badge-s ${o.status}">${STATUS_LABEL[o.status] || o.status}</span>${o.demo ? '<span class="badge-s demo">demo</span>' : ''}${o.tracking_number ? '<br><span class="hint">' + esc(o.tracking_number) + '</span>' : ''}</td>
        <td class="toggle-cell"><button type="button" class="ghost" data-toggle="${esc(o.id)}">${isOpen ? 'Hide' : 'Details'}</button></td></tr>`;
      return row + (isOpen ? detailHtml(o) : '');
    }).join('') || '<tr><td colspan="10">No orders in this period.</td></tr>';
  }

  let seq = 0;
  async function load() {
    if (!A() || !checkRange()) return;
    const my = ++seq;
    try {
      const q = query();
      const [s, o] = await Promise.all([A().api('GET', '/sales/summary?' + q), A().api('GET', '/orders?' + q)]);
      if (my !== seq) return; // a newer range was picked meanwhile
      showStorage(s.storage);
      renderSummary(s);
      orders = o.orders;
      renderOrders();
    } catch (err) { A().msg(err.message); }
  }

  async function init() {
    // default: 1st of the current month -> today (UK)
    const today = ukToday();
    if (!$('s-from').value) $('s-from').value = today.slice(0, 8) + '01';
    if (!$('s-to').value) $('s-to').value = today;
    try {
      const st = await A().api('GET', '/settings');
      const fees = (st.settings || st).fees;
      if (fees) {
        const f = $('fees-form');
        f.stripe_percent.value = fees.stripe.percent; f.stripe_fixed.value = fees.stripe.fixed;
        f.paypal_percent.value = fees.paypal.percent; f.paypal_fixed.value = fees.paypal.fixed;
      }
    } catch (err) { A().msg(err.message); }
    await load();
  }

  async function download(kind) {
    if (!checkRange()) return;
    try {
      const res = await fetch(`/api/admin/sales/${kind}?` + query(), { headers: { Authorization: 'Bearer ' + A().token() }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || `Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || `sales.${kind}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) { A().msg(err.message); }
  }

  async function saveOrder(form, forceStatus) {
    const body = {
      status: forceStatus || form.status.value,
      tracking_number: form.tracking_number.value.trim(),
      postage_paid: form.postage_paid.value,
      note: form.note.value,
    };
    try {
      const d = await A().api('PATCH', '/orders/' + encodeURIComponent(form.dataset.id), body);
      A().msg(`Order ${d.order.id}: ${STATUS_LABEL[d.order.status]}${d.order.tracking_number ? ' (tracking ' + d.order.tracking_number + ')' : ''}` + A().syncNote(d), !d.githubError);
      await load();
    } catch (err) { A().msg(err.message); }
  }

  document.addEventListener('admin:ready', init);
  document.addEventListener('DOMContentLoaded', () => {
    if (!$('sales-section')) return;
    // updates straight away (short pause so typing a date digit by digit doesn't reload each keypress)
    let timer;
    ['s-from', 's-to'].forEach((id) => $(id).addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(load, 350); }));
    $('s-demo').addEventListener('change', load);
    $('s-only-paid').addEventListener('change', renderOrders);
    $('s-csv').addEventListener('click', () => download('csv'));
    $('s-xlsx').addEventListener('click', () => download('xlsx'));
    $('s-orders').addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) { const id = t.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); renderOrders(); return; }
      const b = e.target.closest('[data-act=posted]');
      if (b) saveOrder(b.closest('form'), 'posted');
    });
    $('s-orders').addEventListener('submit', (e) => { e.preventDefault(); saveOrder(e.target); });
    $('orders-warn').addEventListener('click', async (e) => {
      if (e.target.id !== 'retry-sync') return;
      try { const d = await A().api('POST', '/orders/retry-sync'); A().msg(`Saved ${d.saved} of ${d.retried}`, d.pending === 0); showStorage(d.storage); } catch (err) { A().msg(err.message); }
    });
    $('fees-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const fees = { stripe: { percent: Number(f.stripe_percent.value), fixed: Number(f.stripe_fixed.value) }, paypal: { percent: Number(f.paypal_percent.value), fixed: Number(f.paypal_fixed.value) } };
      try { await A().api('PUT', '/settings', { fees }); A().msg('Estimated fees saved', true); load(); } catch (err) { A().msg(err.message); }
    });
  });
})();
