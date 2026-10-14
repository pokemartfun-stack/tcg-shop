const { api, formatGbp } = window.TCG;

async function showModeBanner() {
  const cfg = await api('/api/config');
  const banner = document.getElementById('mode-banner');
  if (!banner) return;
  if (cfg.mode.demo) {
    banner.hidden = false;
    banner.textContent = 'Demo mode — checkout will not charge a real card or PayPal account.';
  } else {
    banner.hidden = true;
  }
}

async function renderCart() {
  const cart = await api('/api/cart');
  const empty = document.getElementById('cart-empty');
  const filled = document.getElementById('cart-filled');
  const body = document.getElementById('cart-body');
  const sub = document.getElementById('cart-subtotal');

  if (!cart.items.length) {
    empty.hidden = false;
    filled.hidden = true;
    await window.TCGApp.refreshCartBadge();
    return;
  }
  empty.hidden = true;
  filled.hidden = false;
  sub.textContent = formatGbp(cart.subtotal);
  body.innerHTML = cart.items
    .map(
      (line) => `
    <tr data-line="${line.productId}">
      <td>
        <div class="cart-item">
          <img src="${line.image}" alt="" />
          <div>
            <strong>${escapeHtml(line.title)}</strong>
            <div class="meta">${formatGbp(line.price_gbp)} each</div>
          </div>
        </div>
      </td>
      <td class="hide-sm">${escapeHtml(line.condition)}</td>
      <td>
        <input class="qty-input" type="number" min="1" max="${line.stock}" value="${line.qty}" data-qty="${line.productId}" />
      </td>
      <td>${formatGbp(line.line_total)}</td>
      <td><button type="button" class="btn secondary" data-remove="${line.productId}">Remove</button></td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('[data-qty]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api('/api/cart/set-qty', {
          method: 'POST',
          body: { productId: input.getAttribute('data-qty'), qty: Number(input.value) },
        });
        await renderCart();
      } catch (e) {
        alert(e.message);
        await renderCart();
      }
    });
  });
  body.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('/api/cart/remove', { method: 'POST', body: { productId: btn.getAttribute('data-remove') } });
      await renderCart();
    });
  });
  await window.TCGApp.refreshCartBadge();
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
  await renderCart();
});
