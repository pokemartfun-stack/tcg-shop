(function () {
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
    const name = document.getElementById('ship-name');
    if (name && !name.value && config.user.name) name.value = config.user.name;
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
    document.getElementById('checkout-subtotal').textContent = formatGbp(0);
    document.getElementById('checkout-postage').textContent = formatGbp(0);
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
  // Postage + total come from the server (one Royal Mail Tracked 48 item at the largest band).
  const q = cart.postage || { amount: 0, service: 'Royal Mail Tracked 48', band: null };
  document.getElementById('checkout-subtotal').textContent = formatGbp(cart.subtotal);
  document.getElementById('checkout-postage-name').textContent = q.service;
  document.getElementById('checkout-postage-band').textContent = q.band ? `(${q.band})` : '';
  document.getElementById('checkout-postage').textContent = q.free ? 'FREE' : formatGbp(q.amount);
  total.textContent = formatGbp(cart.total != null ? cart.total : cart.subtotal);
  if (cart.problems && cart.problems.length) {
    document.getElementById('checkout-error').innerHTML =
      escapeHtml(cart.problems.map((p) => p.error).join('; ')) + ' — <a href="/cart.html">update your cart</a>.';
  }
  await window.TCGApp.refreshCartBadge();
}

function guestEmail() {
  return (document.getElementById('email').value || '').trim();
}

const POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?|GIR) ?\d[A-Z]{2}$/;
const FIELD_IDS = { email: 'email', phone: 'phone', name: 'ship-name', line1: 'ship-line1', line2: 'ship-line2', town: 'ship-town', county: 'ship-county', postcode: 'ship-postcode' };

function markField(field, message) {
  const input = document.getElementById(FIELD_IDS[field] || field);
  if (!input) return;
  input.classList.add('invalid');
  input.setAttribute('aria-invalid', 'true');
  let msg = input.parentElement.querySelector('.field-error');
  if (!msg) { msg = document.createElement('span'); msg.className = 'field-error'; input.parentElement.appendChild(msg); }
  msg.textContent = message;
}

function clearMarks() {
  document.querySelectorAll('#ship-form .invalid').forEach((el) => { el.classList.remove('invalid'); el.removeAttribute('aria-invalid'); });
  document.querySelectorAll('#ship-form .field-error').forEach((el) => el.remove());
}

/** Email + UK delivery address from the form, or null (and the first problem highlighted). */
function readDetails() {
  clearMarks();
  const v = (id) => (document.getElementById(id).value || '').trim();
  const pc = v('ship-postcode').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const postcode = pc.length >= 5 ? `${pc.slice(0, -3)} ${pc.slice(-3)}` : pc;
  const details = {
    email: v('email'),
    address: { name: v('ship-name'), line1: v('ship-line1'), line2: v('ship-line2'), town: v('ship-town'), county: v('ship-county'), postcode, phone: v('phone') },
  };
  const problems = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) problems.push(['email', 'Enter your email address']);
  if (!details.address.name) problems.push(['name', 'Enter the full name for delivery']);
  if (!details.address.line1) problems.push(['line1', 'Enter the first line of the address']);
  if (!details.address.town) problems.push(['town', 'Enter the town or city']);
  if (!POSTCODE_RE.test(postcode)) problems.push(['postcode', 'Enter a valid UK postcode']);
  if (details.address.phone && !/^[+()\d\s-]{6,30}$/.test(details.address.phone)) problems.push(['phone', 'Check the phone number']);
  if (problems.length) {
    problems.forEach(([f, m]) => markField(f, m));
    document.getElementById('checkout-error').textContent = 'Please fill in your delivery details: ' + problems.map((p) => p[1].toLowerCase()).join(', ') + '.';
    const first = document.getElementById(FIELD_IDS[problems[0][0]]);
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    first.focus({ preventScroll: true });
    return null;
  }
  document.getElementById('ship-postcode').value = postcode;
  return details;
}

function showServerError(e) {
  document.getElementById('checkout-error').textContent = e.message;
  if (e.data && e.data.field) markField(e.data.field, e.message);
}

function wireButtons() {
  document.getElementById('btn-demo').addEventListener('click', async () => {
    const err = document.getElementById('checkout-error');
    err.textContent = '';
    const details = readDetails();
    if (!details) return;
    try {
      const { order } = await api('/api/checkout/demo', {
        method: 'POST',
        body: { ...details, method: 'demo' },
      });
      location.href =
        '/success.html?demo=1&order=' +
        encodeURIComponent(order.id + ' · ' + formatGbp(order.total) + ' incl. ' + formatGbp(order.postage.amount) + ' postage · ' + order.message);
    } catch (e) {
      showServerError(e);
      if (e.status === 409) renderSummary();
    }
  });

  document.getElementById('btn-paypal-demo').addEventListener('click', async () => {
    const err = document.getElementById('checkout-error');
    err.textContent = '';
    const details = readDetails();
    if (!details) return;
    try {
      const { order } = await api('/api/checkout/paypal/record', {
        method: 'POST',
        body: details,
      });
      location.href =
        '/success.html?demo=1&order=' +
        encodeURIComponent(order.id + ' · PayPal demo · ' + formatGbp(order.total) + ' incl. postage');
    } catch (e) {
      showServerError(e);
      if (e.status === 409) renderSummary();
    }
  });

  document.getElementById('btn-stripe').addEventListener('click', async () => {
    const err = document.getElementById('checkout-error');
    err.textContent = '';
    const details = readDetails();
    if (!details) return;
    try {
      const { url } = await api('/api/checkout/stripe', {
        method: 'POST',
        body: details,
      });
      if (url) location.href = url;
    } catch (e) {
      showServerError(e);
      if (e.status === 409) renderSummary();
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
        onClick: async (_data, actions) => {
          // Delivery details + stock are checked before the PayPal window opens.
          if (!readDetails()) return actions.reject();
          try {
            await api('/api/checkout/stock-check');
            return actions.resolve();
          } catch (e) {
            document.getElementById('checkout-error').textContent = e.message;
            renderSummary();
            return actions.reject();
          }
        },
        createOrder: async (_data, actions) => {
          // Amount (items + Royal Mail postage) comes from the server, not from the page.
          const q = await api('/api/checkout/quote');
          const d = readDetails() || { address: {} };
          return actions.order.create({
            purchase_units: [{
              amount: {
                value: q.total.toFixed(2), currency_code: 'GBP',
                breakdown: {
                  item_total: { value: q.subtotal.toFixed(2), currency_code: 'GBP' },
                  shipping: { value: q.postage.amount.toFixed(2), currency_code: 'GBP' },
                },
              },
              shipping: d.address.line1 ? {
                name: { full_name: d.address.name },
                address: { address_line_1: d.address.line1, address_line_2: d.address.line2 || undefined, admin_area_2: d.address.town, admin_area_1: d.address.county || undefined, postal_code: d.address.postcode, country_code: 'GB' },
              } : undefined,
            }],
            application_context: { shipping_preference: d.address.line1 ? 'SET_PROVIDED_ADDRESS' : 'NO_SHIPPING' },
          });
        },
        onApprove: async (data, actions) => {
          await actions.order.capture();
          const { order } = await api('/api/checkout/paypal/record', {
            method: 'POST',
            body: { ...(readDetails() || { email: guestEmail() }), paypalOrderId: data.orderID },
          });
          location.href =
            '/success.html?demo=1&order=' +
            encodeURIComponent(order.id + ' · PayPal · ' + formatGbp(order.total) + ' incl. postage');
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

document.addEventListener('DOMContentLoaded', () => {
  // Clear a field's error as soon as it is edited
  document.getElementById('ship-form').addEventListener('input', (e) => {
    if (!e.target.classList.contains('invalid')) return;
    e.target.classList.remove('invalid');
    e.target.removeAttribute('aria-invalid');
    const m = e.target.parentElement.querySelector('.field-error');
    if (m) m.remove();
  });
  document.getElementById('ship-form').addEventListener('submit', (e) => e.preventDefault());
  // Tidy the postcode as soon as it is typed: "sw1a1aa" -> "SW1A 1AA"
  document.getElementById('ship-postcode').addEventListener('blur', (e) => {
    const pc = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    e.target.value = pc.length >= 5 ? `${pc.slice(0, -3)} ${pc.slice(-3)}` : pc;
  });
  init();
});
})();
