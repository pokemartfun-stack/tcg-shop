(function(){
const {api,formatGbp}=window.TCG;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>s?new Date(s).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' (London)':'';
function mapCard(o,map){
 if(!map)return `<div class="map-card map-fallback"><span class="map-bubble">Shipping address: ${esc(o.town||'United Kingdom')}</span><p class="hint">Your delivery address is saved with your order.</p></div>`;
 const {lat,lon}=map;const bbox=[lon-.025,lat-.012,lon+.025,lat+.012].join(',');
 return `<div class="map-card"><span class="map-bubble">Shipping address: ${esc(o.town)}</span><iframe title="Approximate delivery area map" loading="eager" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat}%2C${lon}"></iframe></div>`;
}
function items(o){return o.items.map(i=>`<div class="purchase-item">${i.image?`<img src="${esc(i.image)}" alt="">`:''}<div><strong>${esc(i.title)}</strong><small>Quantity ${i.qty}</small></div><strong>${formatGbp(i.line_total||0)}</strong></div>`).join('')+`<dl class="totals"><div><dt>Subtotal</dt><dd>${formatGbp(o.subtotal||0)}</dd></div><div><dt>${esc(o.postage?.service||'Shipping')}<small> ${esc(o.postage?.band||'')}</small></dt><dd>${formatGbp(o.postage?.amount||0)}</dd></div><div class="grand"><dt>Total <small>GBP</small></dt><dd>${formatGbp(o.total||0)}</dd></div></dl>`;}
function progress(o){const stages=['paid','sent','shipped','delivered'];const current= o.stage==='label_printed'?1:stages.indexOf(o.stage);const at=event=>o.history.find(h=>h.event===event)?.at;const dates=[at('Paid')||o.createdAt,o.labelPrintedAt||o.sentAt||at('Sent to Royal Mail'),o.shippedAt||at('Shipped'),o.deliveredAt];return `<ol class="progress-list">${['Paid',o.labelPrintedAt?'Label printed':'Sent to Royal Mail','Shipped','Delivered'].map((label,i)=>`<li class="${i<=current?'done':''}"><strong>${i<=current?'✓ ':''}${label}</strong><small>${date(dates[i])|| (i>current?'Pending':'')}</small></li>`).join('')}</ol>`;}
function render(o,map,confirmation){
 const addr=o.shipping_address;
 $('order-view').innerHTML=(confirmation?`<div class="confirmation-heading"><span class="confirmed-tick">✓</span><div><p>Confirmation #${esc(o.number)}</p><h1>Thank you, ${esc(o.first_name||'collector')}!</h1></div></div>`:'')+`${o.demo?'<div class="demo-notice">Demo order — no money was taken. This is a preview, not a real shipment.</div>':''}<div class="confirmation-columns"><div>${confirmation?mapCard(o,map):''}<section class="order-card">${confirmation?`<h2>Your order is confirmed</h2><p class="hint">${o.demo?'This demo order is saved. No confirmation email is sent.':'Your payment is confirmed. Keep this page as your receipt.'}</p><a class="btn block purchase-pay" id="track-this" href="/track?number=${encodeURIComponent(o.number)}">Track order →</a>`:`<div class="track-result-title"><h2>Order #${esc(o.number)}</h2><span class="status-pill">${esc(({paid:'Confirmed',sent:'Preparing',label_printed:'Label printed',shipped:'On its way',delivered:'Delivered',refunded:'Refunded',cancelled:'Cancelled'})[o.stage]||'Confirmed')}</span></div>${progress(o)}${o.tracking_url?`<a class="tracking-link" href="${esc(o.tracking_url)}" target="_blank" rel="noopener noreferrer">Track with Royal Mail ↗<br><strong>${esc(o.tracking_number)}</strong></a>`:'<p class="hint">Your Royal Mail tracking number will appear here once available.</p>'}<p class="hint">Delivered updates appear when recorded. For the latest delivery scans, check Royal Mail.</p>`}</section>${confirmation?`<section class="order-card"><h2>Order details</h2><div class="detail-grid"><div><h3>Contact information</h3><p>${esc(o.email)}</p></div><div><h3>Shipping address</h3><p>${addr?['name','line1','line2','town','postcode','country'].map(k=>esc(addr[k])).filter(Boolean).join('<br>'):'United Kingdom'}</p></div></div></section>`:mapCard(o,map)}</div><div><section class="order-card"><h2>${confirmation?'Order summary':'Your items'}</h2>${items(o)}</section><a href="/" class="btn secondary block">Continue shopping</a></div></div>`;
 if(confirmation)$('track-this').onclick=()=>sessionStorage.setItem('track-email',o.email||'');
}
async function init(){
 const params=new URLSearchParams(location.search);
 if($('track-form')){
 $('order-number').value=params.get('number')||'';$('order-email').value=sessionStorage.getItem('track-email')||'';
 $('track-form').onsubmit=async e=>{e.preventDefault();const btn=e.target.querySelector('button');btn.disabled=true;$('track-error').textContent='';$('order-view').innerHTML='';try{const r=await api('/api/customer-orders/track',{method:'POST',body:{number:$('order-number').value,email:$('order-email').value}});render(r.order,r.map,false);$('order-view').scrollIntoView({behavior:'smooth',block:'start'});}catch(err){$('track-error').textContent=err.message;}finally{btn.disabled=false;}};return;
 }
 try{
 let token=params.get('token');const session=params.get('session_id');
 if(!token && session){const r=await api('/api/checkout/stripe/session/'+encodeURIComponent(session));token=r.token;if(!token)throw Error('Payment is still processing. Please check back shortly.');}
 if(!token)throw Error('Use your private confirmation link, or find your order on the tracking page.');
 const r=await api('/api/customer-orders/confirmation',{method:'POST',body:{token}});render(r.order,r.map,true);
 }catch(err){$('order-view').innerHTML=`<section class="order-card"><h1>Order confirmation</h1><p>${esc(err.message)}</p><a class="btn purchase-pay" href="/track">Track your order</a></section>`;}
}
document.addEventListener('DOMContentLoaded',init);
})();
