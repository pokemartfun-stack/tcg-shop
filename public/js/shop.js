const { api, formatGbp } = window.TCG;

async function showModeBanner() {
  const cfg = await api('/api/config');
  const banner = document.getElementById('mode-banner');
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

async function renderProducts() {
  const grid = document.getElementById('product-grid');
  const products = await api('/api/products');
  grid.innerHTML = products
    .map(
      (p) => `
    <article class="card" data-product-id="${p.id}">
      <img src="${p.image}" alt="${escapeHtml(p.title)}" width="400" height="560" />
      <div class="card-body">
        <h2>${escapeHtml(p.title)}</h2>
        <div class="meta">${escapeHtml(p.condition)} · ${escapeHtml(p.category)}</div>
        <div class="meta">${p.stock} in stock</div>
        <div class="price">${formatGbp(p.price_gbp)}</div>
        <div class="card-actions">
          <button type="button" class="btn block" data-add="${p.id}" ${p.stock < 1 ? 'disabled' : ''}>
            Add to cart
          </button>
        </div>
      </div>
    </article>`
    )
    .join('');

  grid.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/cart/add', { method: 'POST', body: { productId: btn.getAttribute('data-add'), qty: 1 } });
        await window.TCGApp.refreshCartBadge();
        btn.textContent = 'Added ✓';
        setTimeout(() => {
          btn.textContent = 'Add to cart';
          btn.disabled = false;
        }, 900);
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    });
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
  await showModeBanner();
  await renderProducts();
});
