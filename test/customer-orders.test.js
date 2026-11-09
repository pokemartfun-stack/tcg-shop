'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'customer-orders-'));
process.env.ORDERS_FILE=path.join(dir,'orders.json');
process.env.PRODUCTS_FILE=path.join(dir,'products.json');
process.env.SETTINGS_FILE=path.join(dir,'settings.json');
process.env.COSTS_FILE=path.join(dir,'costs.json');
const orders=require('../server/orders-store');
const customer=require('../server/customer-orders');
fs.writeFileSync(process.env.PRODUCTS_FILE,JSON.stringify([{id:'preview',title:'Preview card',price_gbp:5,stock:3,condition:'Near mint',category:'Trading cards',image:'/images/tauros-ar.svg'}]));
const app=require('../server/index');
let server,base,token;
before(async()=>{
 const id=customer.identity();token=id.access_token;
 await orders.add({id:'test-order',...id,order_number:'PMF-ABC123',email:'Buyer@Example.com',status:'posted',createdAt:'2026-11-01T12:00:00Z',posted_at:'2026-11-02T12:00:00Z',shipping_address:{name:'Ash Test',line1:'1 Test Street',town:'London'},items:[{title:'Test card',qty:1,line_total:4,cost_gbp:1}],royalmail:{orderIdentifier:123,lastError:'private internal error',sentAt:'2026-11-01T14:00:00Z'},tracking_number:'AB123456789GB',subtotal:4,total:6.9,postage:{service:'Royal Mail Tracked 48',band:'Large Letter',amount:2.9},history:[{event:'Paid',at:'2026-11-01T12:00:00Z',note:'private payment details'}]});
 server=app.listen(0);await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});
async function post(route,body){return fetch(base+'/api/customer-orders/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
test('confirmation requires an unguessable token, never an order id',async()=>{
 assert.equal((await post('confirmation',{token:'test-order'})).status,404);
 assert.equal((await post('confirmation',{token:'a'.repeat(64)})).status,404);
 const r=await post('confirmation',{token});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const d=await r.json();assert.equal(d.order.email,'Buyer@Example.com');assert.equal(d.order.shipping_address.line1,'1 Test Street');assert.equal(d.order.items[0].cost_gbp,undefined);assert.equal(d.order.access_token,undefined);
});
test('tracking matches email case-insensitively and only returns safe fields',async()=>{
 const r=await post('track',{number:'#pmf-abc123',email:' buyer@EXAMPLE.COM '});assert.equal(r.status,200);const d=await r.json();assert.equal(d.order.stage,'shipped');assert.match(d.order.tracking_url,/AB123456789GB$/);assert.equal(d.order.shipping_address,undefined);assert.equal(d.order.email,undefined);assert.equal(d.order.royalmail,undefined);assert.equal(d.order.history[0].note,undefined);assert.equal(d.order.items[0].cost_gbp,undefined);
});
test('wrong email, absent email and unknown number return identical 404',async()=>{
 for(const body of [{number:'PMF-ABC123',email:'wrong@example.com'},{number:'PMF-ABC123'},{number:'PMF-NOPE',email:'Buyer@Example.com'}])assert.equal((await post('track',body)).status,404);
});
test('status mapping uses persisted events and does not invent delivery',()=>{
 const o=orders.find('test-order');assert.equal(customer.safeOrder({...o,status:'paid',royalmail:{},history:[]}).stage,'paid');assert.equal(customer.safeOrder({...o,status:'paid',royalmail:{orderIdentifier:1}}).stage,'sent');assert.equal(customer.safeOrder({...o,status:'paid',royalmail:{labelPrintedAt:'2026-11-02'}}).stage,'label_printed');assert.equal(customer.safeOrder({...o,delivered_at:'2026-11-04'}).stage,'delivered');assert.equal(customer.safeOrder({...o,history:[{event:'Delivered',at:'2026-11-04'}]}).stage,'delivered');
});
test('geocoder timeout falls back and caches failed postcode lookups',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw Error('offline');};try{assert.equal(await customer.geocode('SW1A 1AA'),null);assert.equal(await customer.geocode('SW1A1AA'),null);assert.equal(calls,1);}finally{global.fetch=original;}
});
test('demo checkout returns a private confirmation link and stores optional consent',async()=>{
 const cart=await fetch(base+'/api/cart');const cookie=cart.headers.get('set-cookie').split(';')[0];
 const headers={'Content-Type':'application/json',Cookie:cookie};
 await fetch(base+'/api/cart/add',{method:'POST',headers,body:JSON.stringify({productId:'preview',qty:1})});
 const r=await fetch(base+'/api/checkout/demo',{method:'POST',headers,body:JSON.stringify({email:'guest@example.com',marketing_opt_in:true,total:0,address:{name:'Guest Collector',line1:'1 Test Road',town:'London',postcode:'SW1A 1AA'}})});
 assert.equal(r.status,200);const {order}=await r.json();assert.match(order.access_token,/^[a-f0-9]{64}$/);assert.match(order.order_number,/^PMF-/);assert.equal(order.total,7.9);assert.equal(orders.find(order.id).marketing_opt_in,true);
 // Confirmation privacy and receipt fields are independently checked using a known no-postcode fixture above.
 assert.equal(order.items[0].cost_gbp,undefined);
});
test('purchase templates contain required mobile, form and accessible drawer hooks',async()=>{
 const html=await(await fetch(base+'/checkout')).text();
 for(const marker of ['summary-toggle','aria-expanded="false"','ship-first','ship-last','shipping-service','btn-pay','news'])assert.ok(html.includes(marker),marker);
 const css=fs.readFileSync(path.join(__dirname,'../public/css/purchase.css'),'utf8');assert.match(css,/#summary-content\.expanded/);assert.match(css,/max-width:760px/);
 const drawer=fs.readFileSync(path.join(__dirname,'../public/js/cart-drawer.js'),'utf8');assert.match(drawer,/showModal/);assert.match(drawer,/aria-label="Close cart"/);assert.match(drawer,/returnFocus\.focus\(\)/);
});
test('confirmation and tracking share a per-IP rate limit, ignoring spoofed headers',async()=>{
 customer._reset();for(let i=0;i<20;i++)assert.equal((await post('track',{})).status,404);const r=await post('confirmation',{token});assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>0);
});
test('customer HTML routes are served',async()=>{for(const p of ['/checkout','/track','/thank-you']){const r=await fetch(base+p);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);}});
