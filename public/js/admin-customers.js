// Admin "Customers": registered shopper accounts (name, email, sign-up date, number of orders).
// Read-only. The server never sends password hashes; everything shown is escaped.
(function () {
  'use strict';
  const A = () => window.TCGAdmin;
  const $ = (id) => document.getElementById(id);
  let customers = [];

  const ukDateTime = (iso) => {
    const t = Date.parse(iso || '');
    if (!t) return '—';
    return new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  function render() {
    const esc = A().esc;
    const q = $('cu-search').value.trim().toLowerCase();
    const list = q ? customers.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(q)) : customers;
    $('cu-count').textContent = q ? `· ${list.length} of ${customers.length}` : `· ${customers.length} registered`;
    $('cu-rows').innerHTML = list.length ? list.map((c) => `
      <tr>
        <td class="cu-date"><span class="cu-lbl">Signed up </span>${esc(ukDateTime(c.createdAt))}</td>
        <td class="cu-name">${esc(c.name)}</td>
        <td class="cu-email">${esc(c.email)}</td>
        <td class="num cu-orders">${Number(c.orderCount) || 0}<span class="cu-lbl"> ${Number(c.orderCount) === 1 ? 'order' : 'orders'}</span></td>
      </tr>`).join('')
      : `<tr><td colspan="4" class="hint">${customers.length ? 'No customers match your search.' : 'No registered customers yet.'}</td></tr>`;
  }

  async function load() {
    try {
      const d = await A().api('GET', '/customers');
      customers = Array.isArray(d.customers) ? d.customers : [];
      render();
    } catch (err) {
      A().msg('Customers: ' + err.message);
    }
  }

  document.addEventListener('admin:ready', () => {
    if (!$('customers-section')) return;
    $('cu-search').addEventListener('input', render);
    $('cu-refresh').addEventListener('click', load);
    load();
  });
})();
