(function () {
const { api, formatGbp } = window.TCG;

let ALL = [];
const $ = (id) => document.getElementById(id);

async function showModeBanner() {
  const cfg = await api('/api/config');
  const banner = $('mode-banner');
  if (!banner) return;
  if (cfg.mode.demo) {
    banner.hidden = false;
    banner.classList.remove('ok');
    banner.textContent =
      'Demo payment mode — Stripe/PayPal keys not set. You can still browse, cart, and complete a fake order at checkout.';
  } else {
    banner.hidden = false;
    banner.classList.add('ok');
    const parts = [];
    if (cfg.mode.stripe) parts.push('Stripe (card / Apple Pay)');
    if (cfg.mode.paypal) parts.push('PayPal');
    banner.textContent = 'Live payment methods enabled: ' + parts.join(', ');
  }
}

async function showHero() {
  try {
    const s = await api('/api/settings');
    $('hero-name').textContent = s.shop_name || 'Po-ke Mart Fun';
    $('hero-tagline').textContent = s.tagline || '';
    $('hero-tagline').hidden = !s.tagline;
    const hero = $('hero-banner');
    if (s.banner_image) {
      hero.style.setProperty('--hero-image', `url("${encodeURI(s.banner_image)}")`);
      hero.classList.add('has-image');
    }
  } catch { /* keep defaults */ }
}

function stockLabel(p) {
  if (p.stock < 1) return '<span class="stock-badge out">Out of stock</span>';
  if (p.stock <= 2) return `<span class="stock-badge low">Only ${p.stock} left</span>`;
  return `<span class="stock-badge">${p.stock} in stock</span>`;
}

function cardHtml(p) {
  const out = p.stock < 1;
  return `
    <article class="card${out ? ' sold-out' : ''}" data-product-id="${escapeHtml(p.id)}">
      <div class="card-img">
        <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" width="400" height="560" loading="lazy" />
        ${out ? '<span class="ribbon">Out of stock</span>' : ''}
      </div>
      <div class="card-body">
        <h2>${escapeHtml(p.title)}</h2>
        <div class="meta">${escapeHtml(p.condition)} · ${escapeHtml(p.category)}</div>
        <div class="meta">${stockLabel(p)}</div>
        <div class="price">${formatGbp(p.price_gbp)}</div>
        <div class="card-actions">
          <button type="button" class="btn block" data-add="${escapeHtml(p.id)}" ${out ? 'disabled aria-disabled="true"' : ''}>
            ${out ? 'Out of stock' : 'Add to cart'}
          </button>
        </div>
      </div>
    </article>`;
}

function readFilters() {
  const num = (v) => (v === '' ? null : Number(v));
  return {
    q: $('f-search').value.trim().toLowerCase(),
    category: $('f-category').value,
    condition: $('f-condition').value,
    min: num($('f-min').value),
    max: num($('f-max').value),
    inStock: $('f-instock').checked,
    sort: $('f-sort').value,
  };
}

function applyFilters() {
  const f = readFilters();
  let list = ALL.filter((p) => {
    if (f.q && !(`${p.title} ${p.description || ''}`.toLowerCase().includes(f.q))) return false;
    if (f.category && p.category !== f.category) return false;
    if (f.condition && p.condition !== f.condition) return false;
    if (f.min != null && p.price_gbp < f.min) return false;
    if (f.max != null && p.price_gbp > f.max) return false;
    if (f.inStock && p.stock < 1) return false;
    return true;
  });
  const sorters = {
    newest: (a, b) => (Date.parse(b.added_at || 0) || 0) - (Date.parse(a.added_at || 0) || 0) || b._i - a._i,
    'price-asc': (a, b) => a.price_gbp - b.price_gbp,
    'price-desc': (a, b) => b.price_gbp - a.price_gbp,
    name: (a, b) => a.title.localeCompare(b.title, 'en-GB'),
  };
  list = list.slice().sort(sorters[f.sort] || sorters.newest);

  const grid = $('product-grid');
  $('f-count').textContent = `Showing ${list.length} of ${ALL.length} card${ALL.length === 1 ? '' : 's'}`;
  grid.innerHTML = list.length
    ? list.map(cardHtml).join('')
    : '<p class="empty">No cards match those filters. <button type="button" class="linkish" data-clear>Clear filters</button></p>';
  const c = grid.querySelector('[data-clear]');
  if (c) c.addEventListener('click', clearFilters);
}

function clearFilters() {
  $('f-search').value = '';
  $('f-category').value = '';
  $('f-condition').value = '';
  $('f-min').value = '';
  $('f-max').value = '';
  $('f-instock').checked = false;
  $('f-sort').value = 'newest';
  applyFilters();
}

async function loadProducts() {
  ALL = (await api('/api/products')).map((p, i) => ({ ...p, _i: i }));
  const sel = $('f-condition');
  const current = sel.value;
  const conditions = [...new Set(ALL.map((p) => p.condition).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All</option>' +
    conditions.map((c) => `<option>${escapeHtml(c)}</option>`).join('');
  sel.value = conditions.includes(current) ? current : '';
  applyFilters();
}

function wire() {
  ['f-search', 'f-min', 'f-max'].forEach((id) => $(id).addEventListener('input', applyFilters));
  ['f-category', 'f-condition', 'f-sort', 'f-instock'].forEach((id) => $(id).addEventListener('change', applyFilters));
  $('f-clear').addEventListener('click', clearFilters);
  $('f-toggle').addEventListener('click', () => {
    const more = $('f-more');
    const open = more.classList.toggle('open');
    $('f-toggle').setAttribute('aria-expanded', String(open));
  });

  // Event delegation: grid is re-rendered on every filter change.
  $('product-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      await api('/api/cart/add', { method: 'POST', body: { productId: btn.getAttribute('data-add'), qty: 1 } });
      await window.TCGApp.refreshCartBadge();
      btn.textContent = 'Added ✓';
      setTimeout(() => {
        btn.textContent = 'Add to cart';
        btn.disabled = false;
      }, 900);
    } catch (err) {
      alert(err.message);
      await loadProducts(); // refresh stock numbers
    }
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', async () => {
  wire();
  showHero();
  await showModeBanner();
  await loadProducts();
});
})();
