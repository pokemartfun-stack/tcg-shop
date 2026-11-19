// Admin tabs: Orders · Sales · Refunds · Accounts · Customers · Reviews · Products · Shop look · Security.
// Every <section data-tab="x"> belongs to one tab; only the chosen tab is shown. Old jump links
// (#tracker, #sales-section …) still work: they open the right tab and scroll to the section.
(function () {
  'use strict';
  const TABS = [
    ['orders', 'Orders'], ['sales', 'Sales'], ['refunds', 'Refunds'], ['accounts', 'Accounts'], ['customers', 'Customers'],
    ['reviews', 'Reviews'], ['products', 'Products'], ['shop', 'Shop look & postage'], ['security', 'Security'],
  ];
  const bar = () => document.getElementById('admin-tabs');
  let current = null;

  function show(id, { scrollTo, remember = true } = {}) {
    if (!TABS.some((t) => t[0] === id)) id = 'orders';
    current = id;
    document.querySelectorAll('section[data-tab]').forEach((s) => { s.hidden = s.dataset.tab !== id; });
    bar().querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    if (remember) { try { sessionStorage.setItem('adminTab', id); } catch { /* private mode */ } }
    document.dispatchEvent(new CustomEvent('admin:tab', { detail: { tab: id } }));
    if (scrollTo) { const el = document.getElementById(scrollTo); if (el) el.scrollIntoView(); } else window.scrollTo({ top: 0 });
  }

  function fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return null;
    if (h.startsWith('tab=')) return { id: h.slice(4) };
    const el = document.getElementById(h);
    const sec = el && (el.closest('section[data-tab]'));
    return sec ? { id: sec.dataset.tab, scrollTo: h } : null;
  }

  function init() {
    const nav = bar();
    if (!nav || nav.dataset.ready) return;
    nav.dataset.ready = '1';
    nav.innerHTML = TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="false">${label}</button>`).join('');
    nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) { history.replaceState(null, '', '#tab=' + b.dataset.tab); show(b.dataset.tab); } });
    window.addEventListener('hashchange', () => { const h = fromHash(); if (h) show(h.id, { scrollTo: h.scrollTo }); });
    const h = fromHash();
    let saved = null; try { saved = sessionStorage.getItem('adminTab'); } catch { /* ignore */ }
    show(h ? h.id : saved || 'orders', { scrollTo: h && h.scrollTo, remember: !h });
  }

  // The tabs only matter once the owner is logged in; sections stay hidden until then anyway.
  document.addEventListener('admin:ready', init);
  document.addEventListener('DOMContentLoaded', () => { if (!document.getElementById('panel').hidden) init(); });
  window.TCGAdminTabs = { show, current: () => current };
})();
