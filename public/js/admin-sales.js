// Admin "Sales" section: order list + status workflow, money summary, CSV for HMRC records.
(function () {
  'use strict';
  const A = () => window.TCGAdmin;
  const $ = (id) => document.getElementById(id);
  const gbp = (n) => (n < 0 ? '−£' : '£') + Math.abs(Number(n) || 0).toFixed(2);
  const STATUS_LABEL = { paid: 'Paid — to post', posted: 'Shipped', refunded: 'Refunded', cancelled: 'Cancelled' };
  const METHOD_LABEL = { stripe: 'Card (Stripe)', paypal: 'PayPal', demo: 'Demo' };
  const BAND_LABEL = { large_letter: 'Large Letter', small_parcel: 'Small Parcel', 'Large Letter': 'Large Letter', 'Small Parcel': 'Small Parcel' };
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

  // ---------------- Order tracker ----------------
  const STAGE_LABEL = { paid: 'Paid', sent: 'Sent to Royal Mail', label_printed: 'Label printed', shipped: 'Shipped', refunded: 'Refunded', cancelled: 'Cancelled' };
  const TABS = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'to_post', label: 'To post', test: (o) => o.status === 'paid' },
    { id: 'label_printed', label: 'Label printed', test: (o) => o.stage === 'label_printed' },
    { id: 'shipped', label: 'Shipped', test: (o) => o.stage === 'shipped' },
    { id: 'problems', label: 'Problems', test: (o) => (o.problems || []).length > 0 },
  ];
  let tab = 'to_post';
  let rm = { connected: false };
  const trackUrl = (n) => 'https://www.royalmail.com/track-your-item#/tracking-results/' + encodeURIComponent(n);
  const when = (iso) => { try { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };

  function addressHtml(a) {
    if (!a) return '<em>No address</em>';
    const esc = A().esc;
    return [a.name, a.line1, a.line2, a.town, a.county, a.postcode, a.country || 'United Kingdom'].filter(Boolean).map(esc).join('<br>');
  }

  function trackingHtml(o) {
    const esc = A().esc;
    if (!o.tracking_number) return '<span class="hint">—</span>';
    return `<a href="${esc(trackUrl(o.tracking_number))}" target="_blank" rel="noopener" class="trk">${esc(o.tracking_number)} ↗</a>`;
  }

  function badgeHtml(o) {
    return `<span class="badge-s st-${o.stage}">${STAGE_LABEL[o.stage] || o.stage}</span>${o.demo ? '<span class="badge-s demo">demo</span>' : ''}${(o.problems || []).length ? '<span class="badge-s problem" title="' + A().esc(o.problems.join(' · ')) + '">⚠ problem</span>' : ''}`;
  }

  function rmStateHtml(o) {
    const esc = A().esc;
    const r = o.royalmail || {};
    if (o.demo) return 'Demo order — not sent to Royal Mail.';
    if (r.orderIdentifier) return `Click &amp; Drop order <strong>${esc(r.orderIdentifier)}</strong> (ref ${esc(r.orderReference || '')})${r.sentAt ? ' · sent ' + esc(when(r.sentAt)) : ''}${r.labelPrintedAt ? ' · label printed ' + esc(when(r.labelPrintedAt)) : ''}`;
    if (r.state === 'error') return `<span class="err-t">Not sent: ${esc(r.lastError || 'error')}</span> (tried ${r.attempts}×)`;
    if (r.state === 'not_connected') return 'Royal Mail not connected — buy the label in Click &amp; Drop or at the Post Office, then type the tracking number.';
    if (r.state === 'pending') return 'Waiting to be sent to Click &amp; Drop…';
    return '—';
  }

  function actionsHtml(o, compact) {
    const esc = A().esc;
    const id = esc(o.id);
    const r = o.royalmail || {};
    const b = [];
    if (o.status === 'paid' && !o.demo) {
      if (r.orderIdentifier && rm.connected && rm.labelsApi !== false) b.push(`<button type="button" data-act="label" data-id="${id}">🖨 Print label</button>`);
      else if (rm.connected && !r.orderIdentifier && o.shipping_address) b.push(`<button type="button" data-act="push" data-id="${id}">${r.state === 'error' ? '↻ Retry Royal Mail' : 'Send to Royal Mail'}</button>`);
      if (r.orderIdentifier && (rm.labelsApi === false || !compact)) b.push(`<a class="btn-link" href="${esc(rm.clickAndDropUrl || 'https://business.parcel.royalmail.com/')}" target="_blank" rel="noopener">Open in Click &amp; Drop ↗</a>`);
    }
    b.push(`<button type="button" class="ghost" data-act="slip" data-id="${id}">Packing slip</button>`);
    if (compact) b.push(`<button type="button" class="ghost" data-toggle="${id}">${open.has(o.id) ? 'Hide' : 'Details'}</button>`);
    return `<div class="acts">${b.join('')}</div>`;
  }

  function detailHtml(o) {
    const esc = A().esc;
    const f = o.figures;
    const lines = (o.items || []).map((l) => `<tr><td class="nowrap">${l.qty} ×</td><td>${esc(l.title || l.productId)}</td><td class="num">${gbp(l.price_gbp * l.qty)}</td><td class="num hint">${Number.isFinite(l.cost_gbp) ? 'cost ' + gbp(l.cost_gbp * l.qty) : 'no cost'}</td></tr>`).join('');
    const pp = o.postage_paid != null ? o.postage_paid : '';
    const hist = (o.history || []).map((h) => `<li><time>${esc(when(h.at))}</time> <strong>${esc(h.event)}</strong>${h.note ? ' <span class="hint">' + esc(h.note) + '</span>' : ''}</li>`).join('');
    const probs = (o.problems || []).map((p) => `<li>${esc(p)}</li>`).join('');
    return `<tr class="order-detail" data-for="${esc(o.id)}"><td colspan="9"><div class="od">
      <div><h4>Post to</h4><address>${addressHtml(o.shipping_address)}</address>
        <p>${esc(o.email || '')}${o.shipping_address && o.shipping_address.phone ? '<br>☎ ' + esc(o.shipping_address.phone) : ''}</p>
        <h4>Items</h4><table class="lines">${lines}</table>
        <p class="hint">Postage: Royal Mail Tracked 48 ${esc(bandLabel(o))}${o.postage && o.postage.free ? ' (free)' : ''} ${gbp((o.postage && o.postage.amount) || 0)} · paid by ${METHOD_LABEL[o.method] || esc(o.method || '')}<br>
        Est. fee ${gbp(f.fee)} · cost ${gbp(f.cost)} · postage paid ${gbp(f.postagePaid)} · <strong>profit ${gbp(f.profit)}</strong>
        ${o.payment_ref ? '<br>Payment ref: ' + esc(o.payment_ref) : ''}</p></div>
      <div><h4>Status history</h4><ol class="hist">${hist || '<li class="hint">No history</li>'}</ol>
        <h4>Royal Mail</h4><p class="rm-line">${rmStateHtml(o)}</p>
        ${probs ? '<h4>Problems</h4><ul class="probs">' + probs + '</ul>' : ''}
        ${actionsHtml(o, false)}</div>
      <form class="od-form" data-id="${esc(o.id)}"><h4>Update</h4>
        <label>Status<select name="status">${Object.keys(STATUS_LABEL).map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
        <label>Royal Mail tracking number ${o.tracking_source === 'royalmail' ? '<span class="hint">(from Click &amp; Drop — type to override)</span>' : ''}<input name="tracking_number" value="${esc(o.tracking_number || '')}" placeholder="e.g. AB123456789GB" autocomplete="off" /></label>
        ${o.tracking_number ? `<a href="${esc(trackUrl(o.tracking_number))}" target="_blank" rel="noopener" class="trk">Track on Royal Mail ↗</a>` : ''}
        <label>Postage you paid £ (blank = same as charged)<input name="postage_paid" type="number" step="0.01" min="0" value="${pp}" placeholder="${((o.postage && o.postage.amount) || 0).toFixed(2)}" /></label>
        <label>Note<input name="note" value="${esc(o.note || '')}" maxlength="500" /></label>
        <div><button type="submit">Save</button> ${o.status === 'paid' ? '<button type="button" class="ship" data-act="posted">✔ Mark as shipped</button>' : ''}</div>
      </form></div></td></tr>`;
  }

  function matches(o, q) {
    if (!q) return true;
    const a = o.shipping_address || {};
    const hay = [o.id, a.name, a.postcode, String(a.postcode || '').replace(/\s/g, ''), o.email, o.tracking_number, o.royalmail && o.royalmail.orderReference].filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function renderTabs(base) {
    $('tr-tabs').innerHTML = TABS.map((t) => {
      const n = base.filter(t.test).length;
      return `<button type="button" role="tab" aria-selected="${tab === t.id}" class="tr-tab ${tab === t.id ? 'on' : ''} ${t.id === 'problems' && n ? 'warn' : ''}" data-tab="${t.id}">${t.label} <span class="n">${n}</span></button>`;
    }).join('');
  }

  function renderRm() {
    const esc = A().esc;
    const box = $('rm-box');
    const printable = orders.filter((o) => o.status === 'paid' && !o.demo && o.royalmail && o.royalmail.orderIdentifier);
    const unsent = orders.filter((o) => o.status === 'paid' && !o.demo && o.shipping_address && !(o.royalmail && o.royalmail.orderIdentifier));
    if (!rm.connected) {
      box.className = 'rm-box off';
      box.innerHTML = `<strong>Royal Mail Click &amp; Drop: not connected.</strong> Orders still work — print the packing slip, buy the Tracked 48 label in <a href="https://www.royalmail.com/business/shipping-tools/click-drop" target="_blank" rel="noopener">Click &amp; Drop</a> or at the Post Office, then type the tracking number and press <em>Mark as shipped</em>. <span class="hint">To connect, add <code>ROYALMAIL_API_KEY</code> on Render (see README).</span>`;
    } else {
      box.className = 'rm-box on';
      box.innerHTML = `<strong>✅ Royal Mail Click &amp; Drop connected</strong> <span class="hint">(service ${esc(rm.serviceCode || '')}${rm.labelsApi === false ? ' · labels can\'t be printed through the API on this account — use Click &amp; Drop' : ''}${rm.lastSyncAt ? ' · tracking checked ' + esc(when(rm.lastSyncAt)) : ''})</span>
        <span class="rm-btns"><button type="button" class="ghost" data-rm="check">Check connection</button><button type="button" class="ghost" data-rm="sync">Sync tracking</button>${unsent.length ? `<button type="button" class="ghost" data-rm="push-unsent">Send ${unsent.length} waiting order(s)</button>` : ''}<a class="btn-link" href="${esc(rm.clickAndDropUrl)}" target="_blank" rel="noopener">Open Click &amp; Drop ↗</a></span>`;
    }
    $('tr-print-all').hidden = !rm.connected;
    $('tr-print-all').disabled = !printable.length || rm.labelsApi === false;
    $('tr-print-all').textContent = `🖨 Print all labels (${printable.length} unshipped)`;
    const toPost = orders.filter((o) => o.status === 'paid').length;
    $('tr-slips-all').disabled = !toPost;
    $('tr-slips-all').textContent = `Print all packing slips (${toPost})`;
  }

  function renderOrders() {
    const esc = A().esc;
    const q = $('tr-search').value.trim();
    const base = orders.filter((o) => matches(o, q));
    renderTabs(base);
    renderRm();
    const t = TABS.find((x) => x.id === tab) || TABS[0];
    const list = base.filter(t.test);
    $('s-orders-count').textContent = `(${list.length} shown, newest first${$('tr-in-range').checked ? ', dates above' : ', all dates'})`;
    $('s-orders').innerHTML = list.map((o) => {
      const items = (o.items || []).reduce((n, l) => n + (l.qty || 0), 0);
      const isOpen = open.has(o.id);
      const a = o.shipping_address || {};
      const row = `<tr class="order-row ${isOpen ? 'open' : ''} ${o.demo ? 'is-demo' : ''} ${(o.problems || []).length ? 'has-problem' : ''}" data-id="${esc(o.id)}">
        <td class="nowrap" data-label="Date">${esc(ukDate(o.uk.date))}<br><span class="hint">${esc(o.uk.time)}</span></td>
        <td data-label="Order"><code>${esc(o.id)}</code></td>
        <td data-label="Customer">${esc(a.name || '')}<br><span class="hint">${esc(a.postcode || '')}</span></td>
        <td data-label="Items">${items} item${items === 1 ? '' : 's'}<br><span class="hint">${esc((o.items || []).map((l) => l.title).join(', ').slice(0, 60))}</span></td>
        <td class="num" data-label="Total"><strong>${gbp(o.total)}</strong></td>
        <td data-label="Postage">${esc(bandLabel(o))}<br><span class="hint">${gbp((o.postage && o.postage.amount) || 0)}</span></td>
        <td data-label="Status">${badgeHtml(o)}</td>
        <td data-label="Tracking">${trackingHtml(o)}</td>
        <td class="toggle-cell" data-label="Actions">${actionsHtml(o, true)}</td></tr>`;
      return row + (isOpen ? detailHtml(o) : '');
    }).join('') || `<tr><td colspan="9">${q ? 'No orders match “' + esc(q) + '”.' : 'No orders here.'}</td></tr>`;
  }

  // Open the window straight away (inside the click) so pop-up blockers allow it, then fill it.
  function printWindow() {
    const w = window.open('', '_blank');
    if (w) w.document.write('<p style="font-family:Arial;padding:20px">Loading…</p>');
    return w;
  }
  async function authed(url) {
    const res = await fetch('/api/admin' + url, { headers: { Authorization: 'Bearer ' + A().token() }, credentials: 'same-origin' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const e = new Error(d.error || `HTTP ${res.status}`); e.data = d; throw e;
    }
    return res;
  }
  async function printSlips(ids) {
    const w = printWindow();
    try {
      const size = $('tr-slip-size').value;
      const url = ids.length === 1 ? `/orders/${encodeURIComponent(ids[0])}/packing-slip?size=${size}` : `/packing-slips?size=${size}&demo=${$('s-demo').checked ? 1 : 0}${ids.length ? '&ids=' + ids.map(encodeURIComponent).join(',') : ''}`;
      const html = await (await authed(url)).text();
      if (!w) { A().msg('Allow pop-ups for this page to print packing slips'); return; }
      w.document.open(); w.document.write(html); w.document.close();
    } catch (err) { if (w) w.close(); A().msg(err.message); }
  }
  async function printLabels(ids) {
    const w = printWindow();
    try {
      const res = await authed('/royalmail/labels' + (ids.length ? '?ids=' + ids.map(encodeURIComponent).join(',') : ''));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else window.open(url, '_blank');
      A().msg(`Opened ${res.headers.get('X-Label-Count') || ''} Royal Mail label(s) — print from the PDF window`, true);
      setTimeout(load, 1500);
    } catch (err) {
      if (w) w.close();
      if (err.data && err.data.fallback) { rm.labelsApi = false; renderOrders(); }
      A().msg(err.message + (err.data && err.data.fallback ? ' → ' + err.data.fallback : ''));
    }
  }

  let seq = 0;
  async function load() {
    if (!A() || !checkRange()) return;
    const my = ++seq;
    try {
      const q = query();
      const [s, o] = await Promise.all([A().api('GET', '/sales/summary?' + q), A().api('GET', '/orders?' + q + ($('tr-in-range').checked ? '' : '&all=1'))]);
      if (my !== seq) return; // a newer range was picked meanwhile
      showStorage(s.storage);
      renderSummary(s);
      orders = o.orders;
      rm = o.royalmail || rm;
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
      A().msg(`Order ${d.order.id}: ${d.order.status === 'posted' ? 'Shipped' : STATUS_LABEL[d.order.status]}${d.order.tracking_number ? ' (tracking ' + d.order.tracking_number + ')' : ''}` + A().syncNote(d), !d.githubError);
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
    let st;
    $('tr-search').addEventListener('input', () => { clearTimeout(st); st = setTimeout(renderOrders, 150); });
    $('tr-in-range').addEventListener('change', load);
    $('tr-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderOrders(); } });
    $('tr-print-all').addEventListener('click', () => printLabels([]));
    $('tr-slips-all').addEventListener('click', () => printSlips(orders.filter((o) => o.status === 'paid').map((o) => o.id)));
    $('rm-box').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rm]');
      if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.rm === 'check') {
          const d = await A().api('POST', '/royalmail/check');
          A().msg(d.ok ? `Royal Mail key works. Service ${d.serviceCode} ${d.hasServiceCode ? 'is on your account ✔' : 'was NOT found on your account — set ROYALMAIL_SERVICE_CODE to one of: ' + (d.tracked || []).map((x) => x.code + ' (' + x.name + ')').join(', ')}` : d.error, d.ok && d.hasServiceCode);
        } else if (b.dataset.rm === 'sync') {
          const d = await A().api('POST', '/royalmail/sync');
          A().msg(`Checked ${d.checked} order(s) with Royal Mail, ${d.updated} updated`, true);
        } else {
          const d = await A().api('POST', '/royalmail/push-unsent');
          A().msg(`Sent ${d.sent} of ${d.tried} order(s) to Click & Drop`, d.sent === d.tried);
        }
        await load();
      } catch (err) { A().msg(err.message); } finally { b.disabled = false; }
    });
    $('s-orders').addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) { const id = t.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); renderOrders(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === 'posted') saveOrder(b.closest('form'), 'posted');
      else if (b.dataset.act === 'slip') printSlips([id]);
      else if (b.dataset.act === 'label') printLabels([id]);
      else if (b.dataset.act === 'push') {
        b.disabled = true;
        A().api('POST', '/royalmail/orders/' + encodeURIComponent(id) + '/push')
          .then(() => { A().msg(`Order ${id} sent to Royal Mail Click & Drop`, true); return load(); })
          .catch((err) => { A().msg(err.message); load(); });
      }
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
