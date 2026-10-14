const { api, formatGbp } = window.TCG;

let config = null;

async function init() {
  config = await api('/api/config');
  const banner = document.getElementById('mode-banner');
  const demoCard = document.getElementById('demo-card');
  const btnStripe = document.getElementById('btn-stripe');
  const btnPaypalDemo = document.getElementById('btn-paypal-demo');
  const guestHint = document.getElementById('guest-hint');

  if (config.user) {
    guestHint.hidden = true;
    const email = document.getElementById('email');
    if (email && !email.value) email.value = config.user.email;
  }

  if (config.mode.demo) {
    banner.hidden = false;
    banner.textContent =
      'Demo mode: no STRIPE_* or PAYPAL_CLIENT_ID in .env. Use “Complete demo order”. Live card/Apple Pay/PayPal need keys.';
    btnStripe.disabled = true;
    btnStripe.title = 'Add Stripe keys to enable';
    btnPaypalDemo.hidden = false;
  } else {
    banner.hidden = false;
    banner.classList.add('ok');
    const parts = [];
    if (config.mode.stripe) parts.push('Stripe ready');
    else {
      parts.push('Stripe keys missing');
      btnStripe.disabled = true;
    }
    if (config.mode.paypal) parts.push('PayPal ready');
    else {
      parts.push('PayPal client ID missing');
      btnPaypalDemo.hidden = false;
    }
    banner.textContent = parts.join(' · ');
    if (!config.mode.demo) demoCard.querySelector('.hint').textContent =
      'Demo still available for testing without charging.';
  }

  await renderSummary();
  wireButtons();
  if (config.mode.paypal && config.mode.paypalClientId) {
    loadPayPal(config.mode.paypalClientId);
  }
}

async function renderSummary() {
  const cart = await api('/api/cart');
  const box = document.getElementById('summary-lines');
  const total = document.getElementById('checkout-total');
  if (!cart.items.length) {
    box.innerHTML = '<p class="empty">Cart is empty. <a href="/">Add items</a>.</p>';
    total.textContent = formatGbp(0);
    document.getElementById('btn-stripe').disabled = true;
    document.getElementById('btn-demo').disabled = true;
    return;
  }
  box.innerHTML = cart.items
    .map(
      (l) =>
        `<div style="display:flex;justify-content:space-between;gap:1rem;padding:0.35rem 0;border-bottom:1px solid var(--border)">
          <span>${escapeHtml(l.title)} × ${l.qty}</span>
          <strong>${formatGbp(l.line_total)}</strong>
        </div>`
    )
    .join('');
  total.textContent = formatGbp(cart.subtotal);
  await window.TCGApp.refreshCartBadge();
}

function guestEmail() {
  return (document.getElementById('email').value || '').trim();
}

function wireButtons() {
  document.getElementById('btn-demo').addEventListener('click', async () => {
    const err = document.getElementById('checkout-error');
    err.textContent = '';
    try {
      const { order } = await api('/api/checkout/demo', {
        method: 'POST',
        body: { email: guestEmail() || undefined, method: 'demo' },
      });
      location.href =
        '/success.html?demo=1&order=' +
        encodeURIComponent(order.id + ' · ' + formatGbp(order.subtotal) + ' · ' + order.message);
    } catch (e) {
      err.textContent = e.message;
    }
  });

  document.getElementById('btn-paypal-demo').addEventListener('click', async () => {
    const err = document.getElementById('checkout-error');
    err.textContent = '';
    try {
      const { order } = await api('/api/checkout/paypal/record', {
        method: 'POST',
        body: { email: guestEmail() || undefined },
      });
      location.href =
        '/success.html?demo=1&order=' +
        encodeURIComponent(order.id + ' · PayPal demo · ' + formatGbp(order.subtotal));
    } catch (e) {
      err.textContent = e.message;
    }
  });

  document.getElementById('btn-stripe').addEventListener('click', async () => {
    const err = document.getElementById('checkout-error');
    err.textContent = '';
    try {
      const { url } = await api('/api/checkout/stripe', {
        method: 'POST',
        body: { email: guestEmail() || undefined },
      });
      if (url) location.href = url;
    } catch (e) {
      err.textContent = e.message;
    }
  });
}

function loadPayPal(clientId) {
  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=GBP`;
  script.onload = () => {
    if (!window.paypal) return;
    window.paypal
      .Buttons({
        createOrder: (_data, actions) => {
          const totalText = document.getElementById('checkout-total').textContent.replace(/[^\d.]/g, '');
          return actions.order.create({
            purchase_units: [{ amount: { value: totalText || '0.00', currency_code: 'GBP' } }],
          });
        },
        onApprove: async (data, actions) => {
          await actions.order.capture();
          const { order } = await api('/api/checkout/paypal/record', {
            method: 'POST',
            body: { email: guestEmail() || undefined, paypalOrderId: data.orderID },
          });
          location.href =
            '/success.html?demo=1&order=' +
            encodeURIComponent(order.id + ' · PayPal · ' + formatGbp(order.subtotal));
        },
        onError: (err) => {
          document.getElementById('checkout-error').textContent = String(err);
        },
      })
      .render('#paypal-button-container');
  };
  document.body.appendChild(script);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
