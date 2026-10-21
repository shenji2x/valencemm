const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');
const { createStripe } = require('../src/stripe');
const { r2FromEnv, verifyMedia } = require('../src/profile-media');

async function setup(t, { mediaEnabled = true, verifier, backend, stripeOff = false } = {}) {
  const sessions = new Map(), requests = [], objects = new Map();
  const stripe = createStripe({ secretKey: stripeOff ? null : 'sk_test_biolink', webhookSecret: 'whsec_biolink', fetchImpl: async (url, opts) => {
    const u = new URL(url); requests.push({ url, ...opts });
    let value;
    if (opts.method === 'POST') {
      const form = new URLSearchParams(opts.body), id = 'cs_test_' + (sessions.size + 1), a = form.get('metadata[account_id]');
      value = { id, url:'https://checkout.stripe.com/c/pay/' + id, mode:'payment', currency:'usd', amount_total:2000, status:'open', payment_status:'unpaid', client_reference_id:a, metadata:{product:'valence_premium_v1',account_id:a}, payment_intent:{ id:'pi_'+id,status:'requires_payment_method',amount:2000,currency:'usd',latest_charge:{refunded:false,amount_refunded:0,disputed:false} } };
      sessions.set(id,value);
    } else value = sessions.get(u.pathname.split('/').pop());
    return { ok:!!value,status:value?200:404,text:async()=>JSON.stringify(value || {error:{message:'Unknown session'}}) };
  } });
  const media = { configured:mediaEnabled, origin:'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com', signed:(method,key,o)=>'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/bucket/'+key+'?method='+method+'&size='+(o?.size||0),
    async put(key,bytes,type){ objects.set(key,{bytes,type}); }, async head(key){ const o=objects.get(key);if(!o)throw Error('Missing object');return{size:o.bytes.length,type:o.type}; }, async bytes(key){return objects.get(key).bytes;}, async remove(key){objects.delete(key);} };
  const server = createApp({ stripe, profileMedia:media, premiumCheckoutEnabled:true, mediaVerifier:verifier || (async()=>({duration:5})), backend, skipTimers:true,powDifficulty:0 }); await server.ready;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base='http://127.0.0.1:'+server.address().port;
  async function call(method,path,key,body,extra={}) {
    const r=await fetch(base+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined,redirect:'manual'});
    const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return{status:r.status,json,text,headers:r.headers};
  }
  const reg = async name => {const u=await server.store.registerHuman(name,'Unusual!Profile89');return{key:u.token,a:server.store.authenticate(u.token)};};
  const owner=await reg('profile_owner'), other=await reg('profile_other');
  const draft={displayName:'Profile Owner',bio:'Design, games and more.',links:[{label:'Portfolio',url:'https://example.com/'}],theme:'amethyst',layout:'centered',font:'sans',effect:'none',published:false,showDealButton:true};
  const pay=async(user=owner)=>{
    const c=await call('POST','/v1/premium/checkout',user.key,{});assert.equal(c.status,200,JSON.stringify(c.json));
    const session=[...sessions.values()].pop();session.status='complete';session.payment_status='paid';session.payment_intent.status='succeeded';
    return session;
  };
  return{server,call,owner,other,reg,draft,pay,sessions,requests,objects,base};
}
test('profiles are private until published, expose only public fields and survive restart',async t=>{
  const x=await setup(t);const {call,owner,draft}=x;
  assert.equal((await call('POST','/v1/biolink',null,draft)).status,401);
  assert.equal((await call('POST','/v1/biolink',owner.key,{...draft,premium:{active:true}})).status,200);
  assert.equal((await call('GET','/v1/profiles/profile_owner')).status,404);
  assert.equal((await call('GET','/u/profile_owner')).status,404);
  assert.equal((await call('POST','/v1/biolink',owner.key,{...draft,published:true})).status,200);
  const publicProfile=await call('GET','/v1/profiles/profile_owner');assert.equal(publicProfile.status,200);
  assert.equal(publicProfile.json.profile.premium,false);assert.equal(publicProfile.json.profile.analytics,undefined);
  assert.equal(publicProfile.text.includes(owner.a.id),false);assert.equal(publicProfile.text.includes('salt'),false);
  assert.equal((await call('GET','/u/profile_owner')).status,200);
  const restored=createStore();restored.importState(JSON.parse(JSON.stringify(x.server.store.exportState())));
  assert.equal(restored.profileView(restored.profileOwner('profile_owner')).theme,'amethyst');
  await call('POST','/v1/biolink',owner.key,draft);assert.equal((await call('GET','/u/profile_owner')).status,404);
});
test('profile saves reject scripts, arbitrary appearance values, free premium features and excessive links',async t=>{
  const {call,owner,draft}=await setup(t);
  for(const body of [{theme:'x" onclick="bad'},{links:[{label:'Bad',url:'javascript:alert(1)'}]},{links:[{label:'Bad',url:'data:text/html,test'}]},{links:[{label:'Bad',url:'https://user:secret@example.com'}]},{links:Array.from({length:11},()=>draft.links[0])},{published:'true'},{displayName:''}])assert.equal((await call('POST','/v1/biolink',owner.key,{...draft,...body})).status,400);
  for(const body of [{layout:'glass'},{effect:'glow'}])assert.equal((await call('POST','/v1/biolink',owner.key,{...draft,...body})).status,403);
});
test('checkout charges exactly US$20 on the platform and ignores browser price and premium claims',async t=>{
  const {call,owner,requests}=await setup(t);
  assert.equal((await call('POST','/v1/premium/checkout',owner.key,{price:1,premium:true})).status,200);
  const r=requests[0],p=new URLSearchParams(r.body);
  assert.equal(p.get('mode'),'payment');assert.equal(p.get('line_items[0][price_data][unit_amount]'),'2000');assert.equal(p.get('line_items[0][price_data][currency]'),'usd');
  assert.equal(r.headers['Stripe-Account'],undefined);assert.equal(p.get('application_fee_amount'),null);
  assert.equal((await call('GET','/v1/biolink',owner.key)).json.profile.premium,false);
});
test('premium only unlocks after server retrieval verifies payment, identity, exact price and no refund',async t=>{
  const {call,owner,other,pay,sessions}=await setup(t);const s=await pay();
  assert.equal((await call('POST','/v1/premium/confirm',other.key,{sessionId:s.id})).status,404);
  for(const [key,value] of [['amount_total',1],['payment_status','unpaid'],['currency','eur'],['client_reference_id',other.a.id]]){const old=s[key];s[key]=value;assert.equal((await call('POST','/v1/premium/confirm',owner.key,{sessionId:s.id})).status,409);s[key]=old;}
  s.payment_intent.latest_charge.refunded=true;assert.equal((await call('POST','/v1/premium/confirm',owner.key,{sessionId:s.id})).status,409);s.payment_intent.latest_charge.refunded=false;
  assert.equal((await call('POST','/v1/premium/confirm',owner.key,{sessionId:s.id})).json.premium,true);
  assert.equal((await call('POST','/v1/premium/confirm',owner.key,{sessionId:s.id})).json.premium,true);
  assert.equal((await call('GET','/v1/biolink',owner.key)).json.profile.premium,true);
});
function sign(event){const payload=JSON.stringify(event),ts=Math.floor(Date.now()/1000);return{payload,signature:`t=${ts},v1=${crypto.createHmac('sha256','whsec_biolink').update(ts+'.'+payload).digest('hex')}`};}
test('signed platform webhooks unlock premium and refunds revoke it without replay reactivation',async t=>{
  const x=await setup(t);const s=await x.pay();
  async function hook(event,valid=true){const {payload,signature}=sign(event);const r=await fetch(x.base+'/v1/webhooks/stripe',{method:'POST',headers:{'stripe-signature':valid?signature:'t=1,v1=bad'},body:payload});return r.status;}
  const ev={id:'evt_premium',type:'checkout.session.completed',data:{object:{...s,payment_intent:s.payment_intent.id}}};
  assert.equal(await hook(ev,false),400);assert.equal(x.owner.a.premium,undefined);
  await hook({...ev,account:'acct_seller'});assert.equal(x.owner.a.premium,undefined);
  assert.equal(await hook(ev),200);assert.equal(x.owner.a.premium.active,true);
  assert.equal(await hook({type:'charge.refunded',data:{object:{payment_intent:s.payment_intent.id,refunded:true}}}),200);assert.equal(x.owner.a.premium.active,false);
  assert.equal((await x.call('POST','/v1/premium/confirm',x.owner.key,{sessionId:s.id})).status,409);
});
test('premium webhook storage failures return an error so Stripe retries',async t=>{
  let fail=false;const backend={kind:'file',async read(){return null;},async write(){if(fail)throw Error('storage down');}};
  const x=await setup(t,{backend});x.server.persistence;const s=await x.pay();
  // Inject failure only in the commit method, avoiding the production process-exit safeguard.
  x.server.persistence.commit=async()=>{throw Error('storage down');};
  const {payload,signature}=sign({type:'checkout.session.completed',data:{object:s}});
  const r=await fetch(x.base+'/v1/webhooks/stripe',{method:'POST',headers:{'stripe-signature':signature},body:payload});assert.equal(r.status,500);
});
test('media blocks free video uploads, oversized files and unknown types',async t=>{
  const {call,owner}=await setup(t,{mediaEnabled:true});
  assert.equal((await call('POST','/v1/biolink/media/upload',owner.key,{slot:'video',size:200,type:'video/mp4'})).status,403);
  for(const body of [{slot:'avatar',size:5000001,type:'image/png'},{slot:'avatar',size:200,type:'image/svg+xml'},{slot:'unknown',size:200,type:'image/png'}])assert.equal((await call('POST','/v1/biolink/media/upload',owner.key,body)).status,400);
});
test('verified uploads use a fresh immutable key, drafts stay private and replacement deletes old bytes',async t=>{
  const x=await setup(t,{mediaEnabled:true});const {call,owner,objects}=x;
  await call('POST','/v1/biolink',owner.key,x.draft);
  async function upload(){const u=await call('POST','/v1/biolink/media/upload',owner.key,{slot:'avatar',size:20,type:'image/png'});assert.equal(u.status,200);const pending=owner.a.pendingProfileUpload;objects.set(pending.key,{bytes:Buffer.alloc(20),type:'image/png'});const done=await call('POST','/v1/biolink/media/confirm',owner.key,{uploadId:u.json.uploadId});assert.equal(done.status,200);assert.equal(objects.has(pending.key),false);assert.notEqual(owner.a.profileMedia.avatar.key,pending.key);return owner.a.profileMedia.avatar.key;}
  const old=await upload();assert.equal((await call('GET','/v1/profiles/profile_owner/media/avatar')).status,404);
  await upload();assert.equal(objects.has(old),false);assert.equal(objects.size,1);
  await call('POST','/v1/biolink',owner.key,{...x.draft,published:true});const r=await call('GET','/v1/profiles/profile_owner/media/avatar');assert.equal(r.status,302);assert.match(r.headers.get('location'),/r2\.cloudflarestorage\.com/);
  await call('POST','/v1/biolink/media/remove',owner.key,{slot:'avatar'});assert.equal(objects.size,0);
});
test('failed verification deletes quarantined media and never publishes it',async t=>{
  const x=await setup(t,{mediaEnabled:true,verifier:async()=>{throw new (require('../src/errors').ApiError)(400,'invalid_video','Too long');}});
  const u=await x.call('POST','/v1/biolink/media/upload',x.owner.key,{slot:'avatar',size:20,type:'image/png'});x.objects.set(x.owner.a.pendingProfileUpload.key,{bytes:Buffer.alloc(20),type:'image/png'});
  assert.equal((await x.call('POST','/v1/biolink/media/confirm',x.owner.key,{uploadId:u.json.uploadId})).status,400);assert.equal(x.objects.size,0);assert.equal(x.owner.a.profileMedia,undefined);
});
test('profile deal creation reserves seller identity and ignores client-side profile overrides',async t=>{
  const x=await setup(t);await x.call('POST','/v1/biolink',x.owner.key,{...x.draft,published:true});
  const d=await x.call('POST','/v1/deals',x.other.key,{role:'buyer',type:'human-human',sellerHandle:'profile_owner',amount:5000,title:'Profile deal'});assert.equal(d.status,201);assert.equal(d.json.expectedSeller.id,x.owner.a.id);
  const outsider=await x.reg('profile_outsider');assert.equal((await x.call('POST','/v1/deals/join',outsider.key,{inviteCode:d.json.inviteCode})).status,403);
  assert.equal((await x.call('POST','/v1/deals/join',x.owner.key,{inviteCode:d.json.inviteCode})).status,200);
});
test('metrics deduplicate views and never expose visitor identifiers or private totals publicly',async t=>{
  const x=await setup(t);await x.call('POST','/v1/biolink',x.owner.key,{...x.draft,published:true});
  await x.call('POST','/v1/profiles/profile_owner/view');await x.call('POST','/v1/profiles/profile_owner/view');await x.call('POST','/v1/profiles/profile_owner/click/0');
  assert.deepEqual((await x.call('GET','/v1/biolink',x.owner.key)).json.profile.analytics,{views:1,clicks:1});
  assert.equal((await x.call('GET','/v1/profiles/profile_owner')).json.profile.analytics,undefined);
});
test('unconfigured services fail closed; R2 signatures bind the exact key, size and content type',async t=>{
  const x=await setup(t,{stripeOff:true,mediaEnabled:false});assert.equal((await x.call('POST','/v1/premium/checkout',x.owner.key,{})).status,503);assert.equal((await x.call('POST','/v1/biolink/media/upload',x.owner.key,{slot:'avatar',size:20,type:'image/png'})).status,503);
  const r2=r2FromEnv({R2_ACCOUNT_ID:'a'.repeat(32),R2_ACCESS_KEY_ID:'example',R2_SECRET_ACCESS_KEY:'example',R2_BUCKET:'profile-media'});
  const u=new URL(r2.signed('PUT','staging/account/file',{size:100,type:'video/mp4',now:new Date('2026-10-21T00:00:00Z')}));assert.equal(u.searchParams.get('X-Amz-SignedHeaders'),'content-length;content-type;host');assert.equal(u.searchParams.get('X-Amz-Expires'),'600');assert.match(u.pathname,/staging\/account\/file$/);
  await assert.rejects(verifyMedia(Buffer.from('<script>bad</script>'),'avatar','image/png'),e=>e.code==='invalid_image');
});
test('a separate Premium webhook secret verifies platform events without changing Connect verification',()=>{
  const stripe=createStripe({secretKey:'sk_test',webhookSecret:'whsec_connect',premiumWebhookSecret:'whsec_biolink'});
  const event={type:'checkout.session.completed',data:{object:{}}},signed=sign(event);
  assert.equal(stripe.verifyWebhook(signed.payload,signed.signature).ok,false);
  assert.equal(stripe.verifyWebhook(signed.payload,signed.signature,{premium:true}).ok,true);
});
