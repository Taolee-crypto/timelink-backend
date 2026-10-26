import {dailyFreeProduct} from './v5-daily-free-policy';
import {ensureSubscriptionMeterSchema,subscriptionLocalDay} from './v5-subscription-meter';
import {ensureContributionSchema,contributionEventStatement} from './v5-contribution-store';
export type MusicCheckoutMode='disabled'|'test'|'live';
export interface MusicCheckoutConfig {mode:MusicCheckoutMode;secret:string;timezone:string;}
interface OrderRow {id:string;user_id:number;request_key:string;level:number;amount_krw:number;timezone:string;payment_mode:'test'|'live';status:'prepared'|'confirmed';created_at_ms:number;expires_at_ms:number;payment_key:string|null;}
interface PaymentProof {paymentKey:string;orderId:string;status:string;totalAmount:number;currency:string;approvedAt:string;}
export class MusicOrderError extends Error {constructor(public code:string,public httpStatus:400|401|403|409|503=409){super(code);}}
function validUser(id:number){if(!Number.isSafeInteger(id)||id<1)throw new MusicOrderError('INVALID_USER',400);}
export function validateMusicCheckoutConfig(config:MusicCheckoutConfig){
 if(!['disabled','test','live'].includes(config.mode))throw new MusicOrderError('INVALID_CHECKOUT_MODE',503);
 if(config.mode==='disabled')throw new MusicOrderError('MUSIC_SUBSCRIPTION_CHECKOUT_DISABLED',503);
 if(!config.secret.startsWith(config.mode==='live'?'live_sk_':'test_sk_'))throw new MusicOrderError('MUSIC_SUBSCRIPTION_KEY_MODE_MISMATCH',503);
 subscriptionLocalDay(Date.now(),config.timezone);
}
export function nextMusicBillingMonth(startsAtMs:number){
 const d=new Date(startsAtMs);if(!Number.isFinite(d.getTime()))throw new MusicOrderError('INVALID_BILLING_DATE',400);
 const year=d.getUTCFullYear(),month=d.getUTCMonth()+1;
 const lastDay=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 return Date.UTC(year,month,Math.min(d.getUTCDate(),lastDay),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds());
}
export async function ensureMusicOrderSchema(db:D1Database){
 await ensureSubscriptionMeterSchema(db);
 for(const q of [
  `CREATE TABLE IF NOT EXISTS v5_music_orders(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,request_key TEXT NOT NULL,level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 24),amount_krw INTEGER NOT NULL CHECK(amount_krw>0),timezone TEXT NOT NULL,payment_mode TEXT NOT NULL CHECK(payment_mode IN ('test','live')),status TEXT NOT NULL CHECK(status IN ('prepared','confirmed')),created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,payment_key TEXT UNIQUE,UNIQUE(user_id,request_key))`,
  `CREATE TABLE IF NOT EXISTS v5_music_order_slots(user_id INTEGER PRIMARY KEY,order_id TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS v5_music_receipts(order_id TEXT PRIMARY KEY,payment_key TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,amount_krw INTEGER NOT NULL,rights_budget_krw INTEGER NOT NULL,platform_budget_krw INTEGER NOT NULL,payment_mode TEXT NOT NULL CHECK(payment_mode IN ('test','live')),approved_at_ms INTEGER NOT NULL,entitlement_id TEXT NOT NULL UNIQUE,CHECK(rights_budget_krw>=0 AND platform_budget_krw>=0),CHECK(rights_budget_krw+platform_budget_krw=amount_krw))`,
 ])await db.prepare(q).run();
}
function describeOrder(o:OrderRow,replayed=false){return {purchasePurpose:'music_subscription',orderId:o.id,product:'TL-'+o.level,amount:o.amount_krw,currency:'KRW',mode:o.payment_mode,status:o.status,expiresAtMs:o.expires_at_ms,replayed,tlCredited:0,autoRenew:false};}
export async function prepareMusicOrder(db:D1Database,userId:number,level:number,requestKey:string,config:MusicCheckoutConfig,nowMs=Date.now()){
 validUser(userId);validateMusicCheckoutConfig(config);
 if(typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)||!Number.isSafeInteger(nowMs))throw new MusicOrderError('INVALID_MUSIC_ORDER_REQUEST',400);
 if(!Number.isSafeInteger(level)||level<1||level>24)throw new MusicOrderError('INVALID_MUSIC_LEVEL',400);
 const product=dailyFreeProduct(level);await ensureMusicOrderSchema(db);
 const prior=await db.prepare('SELECT * FROM v5_music_orders WHERE user_id=? AND request_key=?').bind(userId,requestKey).first<OrderRow>();
 if(prior){if(prior.level!==level||prior.payment_mode!==config.mode||prior.timezone!==config.timezone)throw new MusicOrderError('MUSIC_ORDER_REQUEST_CONFLICT');return describeOrder(prior,true);}
 const active=await db.prepare("SELECT id FROM v5_music_entitlements WHERE user_id=? AND status='active' AND payment_mode=? AND ends_at_ms>? LIMIT 1").bind(userId,config.mode,nowMs).first();
 if(active)throw new MusicOrderError('MUSIC_SUBSCRIPTION_ALREADY_ACTIVE');
 const slot=await db.prepare('SELECT order_id FROM v5_music_order_slots WHERE user_id=?').bind(userId).first();
 if(slot)throw new MusicOrderError('MUSIC_ORDER_ALREADY_PENDING_RECONCILE_FIRST');
 const id='v5music_'+crypto.randomUUID().replace(/-/g,''),expires=nowMs+15*60000;
 const order:OrderRow={id,user_id:userId,request_key:requestKey,level,amount_krw:product.monthlyPriceKrw,timezone:config.timezone,payment_mode:config.mode as 'test'|'live',status:'prepared',created_at_ms:nowMs,expires_at_ms:expires,payment_key:null};
 try{await db.batch([
  db.prepare("INSERT INTO v5_music_orders VALUES(?,?,?,?,?,?,?,'prepared',?,?,NULL)").bind(id,userId,requestKey,level,product.monthlyPriceKrw,config.timezone,config.mode,nowMs,expires),
  db.prepare('INSERT INTO v5_music_order_slots(user_id,order_id) VALUES(?,?)').bind(userId,id),
 ]);}catch(error){
  const raced=await db.prepare('SELECT * FROM v5_music_orders WHERE user_id=? AND request_key=?').bind(userId,requestKey).first<OrderRow>();
  if(raced&&raced.level===level&&raced.payment_mode===config.mode&&raced.timezone===config.timezone)return describeOrder(raced,true);
  throw error;
 }
 return describeOrder(order);
}
function validateProof(p:PaymentProof,o:OrderRow,key:string,nowMs:number){
 const approved=Date.parse(p?.approvedAt);
 if(p?.paymentKey!==key||p?.orderId!==o.id||p?.status!=='DONE'||p?.totalAmount!==o.amount_krw||p?.currency!=='KRW'||!Number.isFinite(approved)||approved<Math.floor(o.created_at_ms/1000)*1000||approved>o.expires_at_ms||approved>nowMs)throw new MusicOrderError('MUSIC_PAYMENT_PROOF_MISMATCH',400);
 return approved;
}
/** Network transport is injected only for isolated tests, never selected by clients. */
async function verifiedTossPayment(o:OrderRow,key:string,config:MusicCheckoutConfig,nowMs:number,transport:typeof fetch):Promise<PaymentProof>{
 const headers={Authorization:'Basic '+btoa(config.secret+':'),'Content-Type':'application/json','Idempotency-Key':'music-confirm-'+o.id};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  // Expired orders may only reconcile an approval already made within the quote window.
  if(nowMs<=o.expires_at_ms){
   try{
    const r=await transport('https://api.tosspayments.com/v1/payments/confirm',{method:'POST',headers,signal:controller.signal,body:JSON.stringify({paymentKey:key,orderId:o.id,amount:o.amount_krw})});
    if(r.ok){const proof=await r.json() as PaymentProof;validateProof(proof,o,key,nowMs);return proof;}
   }catch(error){if(error instanceof MusicOrderError)throw error;}
  }
  const r=await transport('https://api.tosspayments.com/v1/payments/'+encodeURIComponent(key),{headers:{Authorization:headers.Authorization},signal:controller.signal});
  if(!r.ok)throw new MusicOrderError('MUSIC_PAYMENT_NOT_VERIFIED',400);
  const proof=await r.json() as PaymentProof;validateProof(proof,o,key,nowMs);return proof;
 }finally{clearTimeout(timer);}
}
async function confirmedOrder(db:D1Database,o:OrderRow,key:string){
 const receipt=await db.prepare('SELECT r.entitlement_id,r.amount_krw,r.payment_key,e.ends_at_ms,e.payment_mode FROM v5_music_receipts r JOIN v5_music_entitlements e ON e.id=r.entitlement_id WHERE r.order_id=? AND r.user_id=?').bind(o.id,o.user_id).first<{entitlement_id:string;amount_krw:number;payment_key:string;ends_at_ms:number;payment_mode:string}>();
 if(!receipt||receipt.payment_key!==key||receipt.amount_krw!==o.amount_krw||o.payment_key!==key)throw new MusicOrderError('MUSIC_CONFIRMED_ORDER_MISMATCH');
 return {ok:true,...describeOrder(o,true),entitlementId:receipt.entitlement_id,endsAtMs:receipt.ends_at_ms,testPayment:receipt.payment_mode==='test'};
}
export async function confirmMusicOrder(db:D1Database,userId:number,orderId:string,paymentKey:string,claimedAmount:number,config:MusicCheckoutConfig,nowMs=Date.now(),transport:typeof fetch=fetch){
 validUser(userId);validateMusicCheckoutConfig(config);
 if(typeof orderId!=='string'||!/^v5music_[a-f0-9]{32}$/.test(orderId)||typeof paymentKey!=='string'||!paymentKey||paymentKey.length>200||!Number.isSafeInteger(claimedAmount))throw new MusicOrderError('INVALID_MUSIC_CONFIRM_REQUEST',400);
 await ensureMusicOrderSchema(db);
 const o=await db.prepare('SELECT * FROM v5_music_orders WHERE id=? AND user_id=?').bind(orderId,userId).first<OrderRow>();
 if(!o||o.amount_krw!==claimedAmount||o.payment_mode!==config.mode)throw new MusicOrderError('MUSIC_ORDER_OWNER_OR_AMOUNT_MISMATCH',403);
 if(o.status==='confirmed')return confirmedOrder(db,o,paymentKey);
 const proof=await verifiedTossPayment(o,paymentKey,config,nowMs,transport),approved=validateProof(proof,o,paymentKey,nowMs),starts=Math.max(approved,o.created_at_ms),ends=nextMusicBillingMonth(starts);
 const entitlementId='music_'+o.id,rights=Math.floor(o.amount_krw*70/100),platform=o.amount_krw-rights;
 if(o.payment_mode==='live')await ensureContributionSchema(db);
 const statements=[
  db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_music_orders WHERE id=? AND user_id=? AND status='prepared') AND EXISTS(SELECT 1 FROM v5_music_order_slots WHERE user_id=? AND order_id=?) THEN 1 ELSE json_extract('MUSIC_ORDER_STATE_CONFLICT','$') END").bind(o.id,userId,userId,o.id),
  db.prepare("SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM v5_music_entitlements WHERE user_id=? AND payment_mode=? AND status='active' AND starts_at_ms<? AND ends_at_ms>?) THEN 1 ELSE json_extract('MUSIC_ENTITLEMENT_OVERLAP','$') END").bind(userId,o.payment_mode,ends,starts),
  db.prepare('INSERT INTO v5_music_entitlements VALUES(?,?,?,?,?,?,?,?,?)').bind(entitlementId,userId,o.level,o.timezone,starts,ends,'music_order:'+o.id,o.payment_mode,'active'),
  db.prepare('INSERT INTO v5_music_receipts VALUES(?,?,?,?,?,?,?,?,?)').bind(o.id,paymentKey,userId,o.amount_krw,rights,platform,o.payment_mode,approved,entitlementId),
  db.prepare("UPDATE v5_music_orders SET status='confirmed',payment_key=? WHERE id=? AND user_id=? AND status='prepared'").bind(paymentKey,o.id,userId),
  db.prepare('DELETE FROM v5_music_order_slots WHERE user_id=? AND order_id=?').bind(userId,o.id),
 ];
 const evidenceHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(paymentKey)))).map(n=>n.toString(16).padStart(2,'0')).join('');
 if(o.payment_mode==='live')statements.push(contributionEventStatement(db,{eventKey:'music:'+o.id,userId:String(userId),activity:'paid_subscription',quantity:o.amount_krw,occurredAtMs:starts,evidenceRef:'music_order:'+o.id,economicKey:'payment:toss:sha256:'+evidenceHash,counterpartyId:null,verified:true,revoked:false}));
 try{await db.batch(statements);}catch(error){const raced=await db.prepare('SELECT * FROM v5_music_orders WHERE id=? AND user_id=?').bind(o.id,userId).first<OrderRow>();if(raced?.status==='confirmed')return confirmedOrder(db,raced,paymentKey);throw error;}
 return {ok:true,...describeOrder({...o,status:'confirmed',payment_key:paymentKey}),entitlementId,endsAtMs:ends,testPayment:o.payment_mode==='test',rightsBudgetKrw:rights,platformBudgetKrw:platform};
}
