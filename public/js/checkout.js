(function () {
const { api, formatGbp } = window.TCG;
let config, busy = false;
const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function renderSummary() {
 const cart = await api('/api/cart');
 $('summary-lines').innerHTML = cart.items.map(l=>`<div class="purchase-item"><img src="${esc(l.image)}" alt=""><div><strong>${esc(l.title)}</strong><small>Quantity ${l.qty}</small></div><strong>${formatGbp(l.line_total)}</strong></div>`).join('') || '<p>Your cart is empty. <a href="/">Find your next card</a>.</p>';
 const q = cart.postage || {};
 $('checkout-subtotal').textContent = formatGbp(cart.subtotal);
 $('checkout-postage').textContent = q.free ? 'Free' : formatGbp(q.amount || 0);
 $('checkout-total').textContent = $('summary-bar-total').textContent = formatGbp(cart.total || 0);
 $('shipping-price').textContent = q.free ? 'Free' : formatGbp(q.amount || 0);
 $('shipping-service').textContent = q.service || 'Royal Mail Tracked 48';
 $('shipping-band').textContent = q.band ? q.band + ' · Selected for your items' : 'Add items to calculate postage';
 $('btn-pay').disabled = !cart.items.length || (!config.mode.demo && !config.mode.stripe);
 if(cart.problems?.length) { $('checkout-error').textContent=cart.problems.map(p=>p.error).join('; '); $('btn-pay').disabled=true; }
}
function readDetails() {
 const form=$('ship-form');
 for(const id of ['ship-first','ship-last']) $(id).value=$(id).value.trim();
 if(!form.reportValidity()) return null;
 const v=id=>$(id).value.trim();
 const pc=v('ship-postcode').toUpperCase().replace(/\s/g,'');
 const postcode=pc.slice(0,-3)+' '+pc.slice(-3);
 if(!/^([A-Z]{1,2}\d[A-Z\d]?|GIR) ?\d[A-Z]{2}$/.test(postcode)) { $('ship-postcode').setCustomValidity('Enter a valid UK postcode'); $('ship-postcode').reportValidity(); return null; }
 return {email:v('email'), marketing_opt_in:$('news').checked, address:{name:v('ship-first')+' '+v('ship-last'),line1:v('ship-line1'),line2:v('ship-line2'),town:v('ship-town'),postcode,phone:v('phone'),country:'United Kingdom'}};
}
function success(order) { location.href='/thank-you?token='+encodeURIComponent(order.access_token); }
async function init() {
 try {
 config=await api('/api/config');
 if(config.user) { $('email').value=config.user.email; $('guest-hint').textContent='Signed in as '+config.user.email; }
 if(config.mode.demo) { $('mode-banner').hidden=false; $('mode-banner').textContent='Demo checkout — no money will be taken.'; $('btn-pay').textContent='Complete demo order'; }
 await renderSummary();
 $('summary-toggle').onclick=()=>{const open=$('summary-toggle').getAttribute('aria-expanded')!=='true';$('summary-toggle').setAttribute('aria-expanded',open);$('summary-content').classList.toggle('expanded',open);$('summary-chevron').textContent=open?'⌃':'⌄';};
 $('ship-postcode').oninput=()=> $('ship-postcode').setCustomValidity('');
 $('ship-form').onsubmit=async e=>{
 e.preventDefault();if(busy)return;
 const details=readDetails();if(!details)return;
 busy=true;$('btn-pay').disabled=true;$('checkout-error').textContent='';
 try { const r=await api(config.mode.demo?'/api/checkout/demo':'/api/checkout/stripe',{method:'POST',body:details});if(r.url)location.href=r.url;else success(r.order); }
 catch(err) { $('checkout-error').textContent=err.message; await renderSummary(); }
 finally {busy=false;}
 };
 // Retain the existing PayPal integration only when configured; not shown as an unconnected payment option.
 if(config.mode.paypal && config.mode.paypalClientId) loadPayPal(config.mode.paypalClientId);
 } catch(e) { $('checkout-error').textContent='Could not load checkout. Please refresh and try again.'; }
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
            body: { ...(readDetails() || { email: document.getElementById('email').value }), paypalOrderId: data.orderID },
          });
          success(order);
        },
        onError: (err) => {
          document.getElementById('checkout-error').textContent = String(err);
        },
      })
      .render('#paypal-button-container');
  };
  document.body.appendChild(script);
}


document.addEventListener('DOMContentLoaded',init);
})();
