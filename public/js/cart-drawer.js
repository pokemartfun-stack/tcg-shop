(function(){
const {api,formatGbp}=window.TCG;
const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let dialog, returnFocus;
async function render(){
 const c=await api('/api/cart');
 dialog.querySelector('.drawer-items').innerHTML=c.items.map(i=>`<div class="purchase-item"><img src="${esc(i.image)}" alt=""><div><strong>${esc(i.title)}</strong><div class="drawer-quantity"><button data-qty="${i.qty-1}" data-id="${esc(i.productId)}" aria-label="Decrease quantity">−</button><span>${i.qty}</span><button data-qty="${i.qty+1}" data-id="${esc(i.productId)}" aria-label="Increase quantity">+</button><button class="remove" data-qty="0" data-id="${esc(i.productId)}">Remove</button></div></div><strong>${formatGbp(i.line_total)}</strong></div>`).join('')||'<p>Your cart is empty. Your next favourite card is waiting.</p>';
 dialog.querySelector('[data-subtotal]').textContent=formatGbp(c.subtotal);
 dialog.querySelector('[data-checkout]').hidden=!c.items.length;
}
async function open(trigger=document.activeElement){returnFocus=trigger;try {await render();if(!dialog.open)dialog.showModal();}catch(e){dialog.querySelector('[role=alert]').textContent=e.message;}}
document.addEventListener('DOMContentLoaded',()=>{
 dialog=document.createElement('dialog');dialog.className='cart-drawer';dialog.setAttribute('aria-labelledby','drawer-title');
 dialog.innerHTML='<div class="drawer-layout"><div class="drawer-heading"><h2 id="drawer-title">Your cart</h2><button class="drawer-close" aria-label="Close cart">×</button></div><div class="drawer-items"></div><p class="error" role="alert"></p><div class="drawer-footer"><div class="drawer-subtotal"><span>Subtotal</span><strong data-subtotal></strong></div><p>Royal Mail postage calculated at checkout.</p><a href="/checkout" class="btn purchase-pay" data-checkout>Check out →</a><a href="/cart.html">View full cart</a></div></div>';
 document.body.append(dialog);
 dialog.addEventListener('close',()=>{if(returnFocus?.isConnected){if(returnFocus.disabled)returnFocus.disabled=false;returnFocus.focus();}});
 dialog.querySelector('.drawer-close').onclick=()=>dialog.close();
 dialog.onclick=async e=>{if(e.target===dialog&&e.clientX<dialog.getBoundingClientRect().left){dialog.close();return;}const b=e.target.closest('[data-qty]');if(!b)return;try{b.disabled=true;dialog.querySelector('[role=alert]').textContent='';const qty=Number(b.dataset.qty);await api(qty?'/api/cart/set-qty':'/api/cart/remove',{method:'POST',body:{productId:b.dataset.id,qty}});await render();await window.TCGApp.refreshCartBadge();}catch(err){dialog.querySelector('[role=alert]').textContent=err.message;b.disabled=false;}};
 document.querySelectorAll('.nav a[href="/cart.html"]').forEach(a=>a.onclick=e=>{e.preventDefault();open(a);});
});
window.CartDrawer={open};
})();
