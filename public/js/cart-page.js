(function () {
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
  renderPostage(cart);
  const problems = cart.problems || [];
  const probFor = (id) => problems.find((x) => x.productId === id);
  const warn = document.getElementById('cart-stock-warn');
  const link = document.getElementById('checkout-link');
  warn.hidden = !problems.length;
  warn.textContent = problems.length ? 'Please fix quantities before checkout: ' + problems.map((x) => x.error).join('; ') : '';
  link.classList.toggle('disabled', problems.length > 0);
  link.setAttribute('aria-disabled', String(problems.length > 0));
  link.onclick = problems.length ? (e) => e.preventDefault() : null;
  body.innerHTML = cart.items
    .map(
      (line) => `
    <tr data-line="${line.productId}">
      <td>
        <div class="cart-item">
          <img src="${line.image}" alt="" />
          <div>
            <strong>${escapeHtml(line.title)}</strong>
            <div class="meta">${formatGbp(line.price_gbp)} each · ${line.stock < 1 ? 'Out of stock' : line.stock + ' in stock'}</div>
            ${probFor(line.productId) ? `<div class="stock-warn">${escapeHtml(probFor(line.productId).error)}</div>` : ''}
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

// Postage is worked out on the server (one Royal Mail Tracked 48 item, priced at the largest band).
function renderPostage(cart) {
  const q = cart.postage;
  if (!q) return;
  document.getElementById('cart-postage-name').textContent = q.service;
  document.getElementById('cart-postage-band').textContent = q.band ? `(${q.band})` : '';
  document.getElementById('cart-postage').textContent = q.free ? 'FREE' : formatGbp(q.amount);
  document.getElementById('cart-total').textContent = formatGbp(cart.total);
  const note = document.getElementById('cart-postage-note');
  const parts = ['One postage charge per order, whatever the number of items.'];
  if (q.free_over != null && !q.free) parts.push(`Free postage on orders over ${formatGbp(q.free_over)} — add ${formatGbp(Math.max(0, q.free_over - q.subtotal))} more.`);
  if (q.free) parts.push('Your order qualifies for free postage.');
  note.textContent = parts.join(' ');
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
})();
