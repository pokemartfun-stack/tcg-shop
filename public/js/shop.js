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

// Banner: the uploaded image is shown as an <img> at its natural aspect ratio (whole picture,
// full colour, no overlay). The shop name/tagline stay in the page as a (visually hidden) h1
// unless the admin turns on "Show shop name over banner".
function applyHero(s) {
  const hero = $('hero-banner');
  const img = $('hero-img');
  const url = s.banner_image || '';
  const okUrl = /^(https?:\/\/|\/)[^"'()\s\\<>]*$/i.test(url);
  hero.classList.toggle('has-image', okUrl);
  img.hidden = !okUrl;
  if (okUrl) {
    if (s.ratio) img.style.aspectRatio = s.ratio;
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  } else {
    img.removeAttribute('src');
  }
  hero.classList.toggle('show-text', Boolean(s.show_banner_text));
}

async function showHero() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('hero') || 'null'); } catch { /* ignore */ }
  if (cached) applyHero(cached);
  const img = $('hero-img');
  img.addEventListener('load', () => {
    if (!img.naturalWidth) return;
    const ratio = `${img.naturalWidth} / ${img.naturalHeight}`;
    img.style.aspectRatio = ratio;
    try {
      const c = JSON.parse(localStorage.getItem('hero') || '{}');
      if (c.banner_image === img.getAttribute('src')) localStorage.setItem('hero', JSON.stringify({ ...c, ratio }));
    } catch { /* ignore */ }
  });
  try {
    const s = await api('/api/settings');
    $('hero-name').textContent = s.shop_name || 'Po-ke Mart Fun';
    $('hero-tagline').textContent = s.tagline || '';
    $('hero-tagline').hidden = !s.tagline;
    const next = { banner_image: s.banner_image || '', show_banner_text: Boolean(s.show_banner_text) };
    if (cached && cached.banner_image === next.banner_image) next.ratio = cached.ratio;
    applyHero(next);
    try { localStorage.setItem('hero', JSON.stringify(next)); } catch { /* ignore */ }
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
      <div class="card-img" data-gallery="${escapeHtml(p.id)}" role="button" tabindex="0" aria-label="View photos of ${escapeHtml(p.title)}">
        <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" width="400" height="560" loading="lazy" />
        ${(p.images || []).length > 1 ? `<span class="photo-count">📷 ${p.images.length}</span>` : ''}
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

  // Simple gallery: click a card photo to see all its photos.
  $('product-grid').addEventListener('click', (e) => {
    const g = e.target.closest('[data-gallery]');
    if (g) openGallery(g.getAttribute('data-gallery'));
  });
  $('product-grid').addEventListener('keydown', (e) => {
    const g = e.target.closest('[data-gallery]');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGallery(g.getAttribute('data-gallery')); }
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

let galleryImgs = [];
let galleryIdx = 0;

function showGalleryPhoto(i) {
  const box = document.getElementById('gallery');
  galleryIdx = (i + galleryImgs.length) % galleryImgs.length;
  box.querySelector('.gallery-main').src = galleryImgs[galleryIdx];
  box.querySelectorAll('[data-idx]').forEach((x) => x.classList.toggle('active', Number(x.getAttribute('data-idx')) === galleryIdx));
  const many = galleryImgs.length > 1;
  box.querySelector('.gallery-nav.prev').hidden = !many;
  box.querySelector('.gallery-nav.next').hidden = !many;
  box.querySelector('.gallery-counter').textContent = many ? `${galleryIdx + 1} / ${galleryImgs.length}` : '';
}

function openGallery(id) {
  const p = ALL.find((x) => x.id === id);
  if (!p) return;
  galleryImgs = p.images && p.images.length ? p.images : [p.image];
  let box = document.getElementById('gallery');
  if (!box) {
    box = document.createElement('div');
    box.id = 'gallery';
    box.className = 'gallery-backdrop';
    box.innerHTML = `<div class="gallery" role="dialog" aria-modal="true" aria-label="Photos">
      <button type="button" class="gallery-close" aria-label="Close">×</button>
      <div class="gallery-stage">
        <button type="button" class="gallery-nav prev" aria-label="Previous photo">‹</button>
        <img class="gallery-main" alt="" />
        <button type="button" class="gallery-nav next" aria-label="Next photo">›</button>
      </div>
      <div class="gallery-title"></div>
      <div class="gallery-counter"></div>
      <div class="gallery-thumbs"></div>
    </div>`;
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('.gallery-close')) return box.classList.remove('open');
      if (e.target.closest('.gallery-nav.prev')) return showGalleryPhoto(galleryIdx - 1);
      if (e.target.closest('.gallery-nav.next')) return showGalleryPhoto(galleryIdx + 1);
      const t = e.target.closest('[data-idx]');
      if (t) showGalleryPhoto(Number(t.getAttribute('data-idx')));
    });
    document.addEventListener('keydown', (e) => {
      if (!box.classList.contains('open')) return;
      if (e.key === 'Escape') box.classList.remove('open');
      if (e.key === 'ArrowLeft') showGalleryPhoto(galleryIdx - 1);
      if (e.key === 'ArrowRight') showGalleryPhoto(galleryIdx + 1);
    });
    // swipe on phones
    let x0 = null;
    box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) showGalleryPhoto(galleryIdx + (dx < 0 ? 1 : -1));
      x0 = null;
    });
  }
  box.querySelector('.gallery-main').alt = p.title;
  box.querySelector('.gallery-title').textContent = p.title;
  box.querySelector('.gallery-thumbs').innerHTML = galleryImgs.length > 1
    ? galleryImgs.map((u, i) => `<button type="button" data-idx="${i}"><img src="${escapeHtml(u)}" alt="Photo ${i + 1}" /></button>`).join('')
    : '';
  showGalleryPhoto(0);
  box.classList.add('open');
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
