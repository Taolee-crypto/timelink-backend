import {ensureTimeFreeSchema,timeFreeGrantStatement,timeFreePreflight} from './v5-time-free';
import musicSubscriptionsRouter from './routes/music-subscriptions';
import { Hono } from 'hono';
import type { Env } from './types';
import { verifyToken } from './auth';
import { creditVerifiedPayment } from './v5-payment-ledger';
import { readV5Wallet } from './v5-wallet';
import { assertTLAtomScale, ensureLedgerAccount, postLedgerTransaction, tlToAtoms } from './economy-ledger';
import { readRewardPolicy,paymentBonusMap } from './v5-reward-policy';

const payment = new Hono<{ Bindings: Env }>();
payment.route('/v5/music',musicSubscriptionsRouter);

/**
 * V5 Share Place TEST checkout: persistent test-only receipts, never charges
 * money or TL balances. Grants TIME FREE listening access, never TL_B.
 */

/** Unified nominal pricing: 1 playback second = 1 TL = 1 KRW.
 * Admin-editable period discounts and contribution weights. No payment or entitlement side effects.
 */
const DEFAULT_PERIOD_POLICY:Record<string,{days:number;discountPercent:number;contributionWeight:number}>={
 hour:{days:1,discountPercent:0,contributionWeight:1},
 day:{days:1,discountPercent:10,contributionWeight:1.1},
 month:{days:30,discountPercent:25,contributionWeight:1.3},
 year:{days:365,discountPercent:40,contributionWeight:1.5}
};
async function periodPolicy(db:Env['DB'],period:string){
 await db.prepare(`CREATE TABLE IF NOT EXISTS v5_unified_period_pricing(
 period TEXT PRIMARY KEY,discount_percent REAL NOT NULL,contribution_weight REAL NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
 const row=await db.prepare('SELECT discount_percent,contribution_weight FROM v5_unified_period_pricing WHERE period=?').bind(period).first<any>();
 const base=DEFAULT_PERIOD_POLICY[period];
 return {...base,discountPercent:row?Number(row.discount_percent):base.discountPercent,
   contributionWeight:row?Number(row.contribution_weight):base.contributionWeight};
}
payment.post('/v5/unified-time/quote',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),period=String(b?.period||'');
 const hours=Number(b?.hours),scope=String(b?.scope||'');
 if(!Object.prototype.hasOwnProperty.call(DEFAULT_PERIOD_POLICY,period)||
    !['personal','commercial'].includes(scope)||!Number.isSafeInteger(hours)||hours<1||hours>24)
   return c.json({ok:false,code:'INVALID_SELECTION'},400);
 try{
  const policy=await periodPolicy(c.env.DB,period);
  if(!Number.isFinite(policy.discountPercent)||policy.discountPercent<0||policy.discountPercent>100||
     !Number.isFinite(policy.contributionWeight)||policy.contributionWeight<0||policy.contributionWeight>10)
    return c.json({ok:false,code:'INVALID_PRICING_POLICY'},503);
  const seconds=hours*3600*policy.days;
  const nominalKrw=seconds;
  const amountKrw=Math.ceil(seconds*(100-policy.discountPercent)/100);
  return c.json({ok:true,scope,period,days:policy.days,seconds,nominalTl:seconds,nominalKrw,
    discountPercent:policy.discountPercent,contributionWeight:policy.contributionWeight,
    amountKrw,currency:'KRW',checkoutEnabled:false,entitlementGranted:false,
    contributionAccrual:'actual_playback_only'});
 }catch{return c.json({ok:false,code:'QUOTE_UNAVAILABLE'},503)}
});
payment.get('/v5/unified-time/policy',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 try{
  const entries=await Promise.all(Object.keys(DEFAULT_PERIOD_POLICY).map(async period=>({
   period,...await periodPolicy(c.env.DB,period)
  })));
  return c.json({ok:true,nominalKrwPerSecond:1,nominalTlPerSecond:1,periods:entries});
 }catch{return c.json({ok:false,code:'POLICY_UNAVAILABLE'},503)}
});

// Commercial music: one-second = one TL = one KRW nominal.
// Quote is authoritative, but does not grant airtime or initiate a payment.
payment.post('/v5/commercial-time/quote',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const body=await c.req.json<any>().catch(()=>null);
 const hours=Number(body?.hours),period=String(body?.period||''),area=Number(body?.area_tier??0);
 const days:Record<string,number>={hour:1,day:1,month:30,year:365};
 if(!Object.prototype.hasOwnProperty.call(days,period)||!Number.isSafeInteger(hours)||hours<1||hours>24||
   !Number.isSafeInteger(area)||area<0||area>4)
   return c.json({ok:false,code:'INVALID_COMMERCIAL_TIME_SELECTION'},400);
 const seconds=hours*3600*days[period];
 const areaWeights=[1,1.2,1.5,2,3],periodWeights:Record<string,number>={hour:1,day:1,month:0.8,year:0.65};
 const weight=areaWeights[area]*periodWeights[period];
 const amountKrw=Math.round(seconds*weight);
 return c.json({ok:true,product:'commercial_music_time',seconds,nominalTl:seconds,
   nominalKrw:seconds,areaWeight:areaWeights[area],periodWeight:periodWeights[period],
   discountPercent:0,amountKrw,currency:'KRW',checkoutEnabled:false,
   entitlementGranted:false,scope:'commercial_broadcast_only',
   note:'Server quote only. Payment and commercial airtime ledger are not yet connected.'});
});


async function commercialTables(db:Env['DB']){
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_store_time_orders (order_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,hours INTEGER NOT NULL,period TEXT NOT NULL,area_tier INTEGER NOT NULL,seconds INTEGER NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payment_key TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,paid_at TEXT)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_store_time_balance (user_id INTEGER PRIMARY KEY,purchased_seconds INTEGER NOT NULL DEFAULT 0,used_seconds INTEGER NOT NULL DEFAULT 0)").run();
}
payment.post('/v5/commercial-time/toss/prepare',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),hours=Number(b?.hours),period=String(b?.period||''),area=Number(b?.area_tier??0);
 const days:Record<string,number>={hour:1,day:1,month:30,year:365},weights:Record<string,number>={hour:1,day:1,month:0.8,year:0.65};
 if(!Object.prototype.hasOwnProperty.call(days,period)||!Number.isSafeInteger(hours)||hours<1||hours>24||!Number.isSafeInteger(area)||area<0||area>4)return c.json({ok:false,error:'INVALID_SELECTION'},400);
 if(b?.requested_events?.triple_luck||b?.requested_events?.referral)return c.json({ok:false,error:'EVENT_NOT_AVAILABLE'},409);
 const clientKey=String(c.env.TOSS_CLIENT_KEY||''),secret=String(c.env.TOSS_SECRET_KEY||'');
 if(!clientKey.startsWith('test_ck_')||!secret.startsWith('test_sk_'))return c.json({ok:false,error:'TOSS_TEST_KEYS_REQUIRED'},503);
 const seconds=hours*3600*days[period],amount=Math.round(seconds*[1,1.2,1.5,2,3][area]*weights[period]);
 if(amount<1000)return c.json({ok:false,error:'TOSS_MINIMUM_1000_KRW'},400);
 const orderId='v5store_'+crypto.randomUUID().replace(/-/g,'');
 try{
  await commercialTables(c.env.DB);
  await c.env.DB.prepare("INSERT INTO v5_store_time_orders(order_id,user_id,hours,period,area_tier,seconds,amount) VALUES(?,?,?,?,?,?,?)").bind(orderId,Number(uid),hours,period,area,seconds,amount).run();
  return c.json({ok:true,orderId,amount,seconds,clientKey,mode:'test',successUrl:'/store-payment-success.html',failUrl:'/payment-fail.html'});
 }catch(e){console.error('[STORE_PREPARE]',e);return c.json({ok:false,error:'STORE_ORDER_UNAVAILABLE'},503);}
});
payment.post('/v5/commercial-time/toss/confirm',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),orderId=String(b?.orderId||''),paymentKey=String(b?.paymentKey||''),amount=Number(b?.amount);
 if(!/^v5store_[a-f0-9]{32}$/.test(orderId)||!paymentKey||!Number.isSafeInteger(amount))return c.json({ok:false,error:'INVALID_REQUEST'},400);
 try{
  await commercialTables(c.env.DB);
  const o=await c.env.DB.prepare("SELECT * FROM v5_store_time_orders WHERE order_id=? AND user_id=?").bind(orderId,Number(uid)).first<any>();
  if(!o||Number(o.amount)!==amount)return c.json({ok:false,error:'ORDER_AMOUNT_MISMATCH'},403);
  if(o.status==='paid')return c.json({ok:true,alreadyCompleted:true,seconds:o.seconds});
  if(o.status!=='pending')return c.json({ok:false,error:'ORDER_NOT_PENDING'},409);
  const secret=String(c.env.TOSS_SECRET_KEY||'');
  if(!secret.startsWith('test_sk_'))return c.json({ok:false,error:'TOSS_TEST_SECRET_REQUIRED'},503);
  const response=await fetch('https://api.tosspayments.com/v1/payments/confirm',{method:'POST',headers:{Authorization:'Basic '+btoa(secret+':'),'Content-Type':'application/json','Idempotency-Key':orderId},body:JSON.stringify({paymentKey,orderId,amount})});
  const proof:any=await response.json().catch(()=>({}));
  if(!response.ok||proof.status!=='DONE'||proof.orderId!==orderId||Number(proof.totalAmount)!==amount||proof.paymentKey!==paymentKey)return c.json({ok:false,error:proof.message||'TOSS_CONFIRM_FAILED'},400);
  await c.env.DB.batch([
   c.env.DB.prepare("UPDATE v5_store_time_orders SET status='paid',payment_key=?,paid_at=CURRENT_TIMESTAMP WHERE order_id=? AND user_id=? AND status='pending'").bind(paymentKey,orderId,Number(uid)),
   c.env.DB.prepare("INSERT INTO v5_store_time_balance(user_id,purchased_seconds,used_seconds) VALUES(?,?,0) ON CONFLICT(user_id) DO UPDATE SET purchased_seconds=purchased_seconds+excluded.purchased_seconds").bind(Number(uid),Number(o.seconds))
  ]);
  return c.json({ok:true,seconds:o.seconds,amount,testPayment:true,entitlementType:'commercial_airtime'});
 }catch(e){console.error('[STORE_CONFIRM]',e);return c.json({ok:false,error:'STORE_CONFIRM_UNAVAILABLE'},503);}
});
payment.get('/v5/commercial-time/balance',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 await commercialTables(c.env.DB);
 const x=await c.env.DB.prepare('SELECT purchased_seconds,used_seconds FROM v5_store_time_balance WHERE user_id=?').bind(Number(uid)).first<any>();
 return c.json({ok:true,remainingSeconds:Math.max(0,Number(x?.purchased_seconds||0)-Number(x?.used_seconds||0))});
});
payment.post('/v5/shareplace-time/quote', async c => {
 const userId=await authUserId(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<{hours?:number}>().catch(()=>null),hours=Number(b?.hours);
 if(!Number.isFinite(hours)||hours<=0||hours>720)return c.json({ok:false,error:'INVALID_HOURS'},400);
 const seconds=Math.round(hours*3600);
 if(!Number.isSafeInteger(seconds)||seconds<1)return c.json({ok:false,error:'INVALID_DURATION'},400);
 const rates=[0,5,10,15,20,30,40,50,100];
 const draw=()=>{const buf=new Uint32Array(1);crypto.getRandomValues(buf);return rates[buf[0]%rates.length];};
 const first=draw(),second=draw(),discountedTl=Math.ceil(seconds*(100-first)*(100-second)/10000);
 const quoteId=crypto.randomUUID();
 try{
  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS v5_shareplace_time_test_orders (
   quote_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,seconds INTEGER NOT NULL,
   first_discount INTEGER NOT NULL,second_discount INTEGER NOT NULL,
   discounted_tl INTEGER NOT NULL,method TEXT,status TEXT NOT NULL DEFAULT 'quoted',
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,paid_at TEXT)`).run();
  await c.env.DB.prepare('INSERT INTO v5_shareplace_time_test_orders (quote_id,user_id,seconds,first_discount,second_discount,discounted_tl) VALUES (?,?,?,?,?,?)').bind(quoteId,Number(userId),seconds,first,second,discountedTl).run();
  return c.json({ok:true,quoteId,seconds,nominalTl:seconds,firstDiscountPercent:first,doubleDiscountPercent:second,
   discountedTl,entitlementType:'time_free',entitlementSeconds:seconds,entitlementTlB:0,checkoutEnabled:true,testMode:true});
 }catch(error){console.error('[SHAREPLACE_TIME_QUOTE]',error);return c.json({ok:false,error:'QUOTE_UNAVAILABLE'},503);}
});
payment.get('/v5/shareplace-time/status',async c=>{
 const userId=await authUserId(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const pass=await timeFreePreflight(c.env.DB,Number(userId));
 return c.json({ok:true,...(pass||{billing_mode:'time_free',can_play:false,time_free_remaining_ms:0,remaining_included_ms:0,tl_reward:0,contribution_only:true})});
});
payment.post('/v5/shareplace-time/test-checkout',async c=>{
 const userId=await authUserId(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<{quoteId?:string;method?:string}>().catch(()=>null);
 const quoteId=String(b?.quoteId||''),method=String(b?.method||'');
 if(!/^[a-f0-9-]{36}$/i.test(quoteId)||!['tl','cash'].includes(method))return c.json({ok:false,error:'INVALID_REQUEST'},400);
 try{
  const order=await c.env.DB.prepare('SELECT * FROM v5_shareplace_time_test_orders WHERE quote_id=? AND user_id=?').bind(quoteId,Number(userId)).first<any>();
  if(!order)return c.json({ok:false,error:'QUOTE_NOT_FOUND'},404);
  await ensureTimeFreeSchema(c.env.DB);
  if(order.status==='test_paid'){await c.env.DB.batch([timeFreeGrantStatement(c.env.DB,quoteId,Number(userId),Number(order.seconds),'test')]);return c.json({ok:true,testMode:true,alreadyCompleted:true,seconds:order.seconds,discountedTl:order.discounted_tl,method:order.method,entitlementType:'time_free',...await timeFreePreflight(c.env.DB,Number(userId))});}
  if(order.status!=='quoted')return c.json({ok:false,error:'ALREADY_PROCESSING'},409);
  await c.env.DB.batch([
   c.env.DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_shareplace_time_test_orders WHERE quote_id=? AND user_id=? AND status='quoted') THEN 1 ELSE json_extract('TIME_ORDER_CONFLICT','$') END").bind(quoteId,Number(userId)),
   c.env.DB.prepare("UPDATE v5_shareplace_time_test_orders SET status='test_paid',method=?,paid_at=CURRENT_TIMESTAMP WHERE quote_id=? AND user_id=? AND status='quoted'").bind(method,quoteId,Number(userId)),
   timeFreeGrantStatement(c.env.DB,quoteId,Number(userId),Number(order.seconds),'test'),
  ]);
  return c.json({ok:true,testMode:true,seconds:order.seconds,discountedTl:order.discounted_tl,method,
   entitlementType:'time_free',...await timeFreePreflight(c.env.DB,Number(userId)),message:'TIME FREE 청취 이용권이 적용되었습니다. TL 보상 없이 기여만 기록합니다.'});
 }catch(error){console.error('[SHAREPLACE_TIME_TEST_CHECKOUT]',error);return c.json({ok:false,error:'TEST_CHECKOUT_UNAVAILABLE'},503);}
});


// Real Toss sandbox payment for Share Place time purchases. Separate from TL top-ups.
payment.post('/v5/shareplace-time/toss/prepare',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),quoteId=String(b?.quoteId||'');
 if(!/^[a-f0-9-]{36}$/i.test(quoteId))return c.json({ok:false,error:'INVALID_QUOTE'},400);
 const key=String(c.env.TOSS_CLIENT_KEY||''),secret=String(c.env.TOSS_SECRET_KEY||'');
 if(!key.startsWith('test_ck_')||!secret.startsWith('test_sk_'))return c.json({ok:false,error:'TOSS_TEST_KEYS_REQUIRED'},503);
 const o=await c.env.DB.prepare('SELECT * FROM v5_shareplace_time_test_orders WHERE quote_id=? AND user_id=?').bind(quoteId,Number(uid)).first<any>();
 if(!o||!['quoted','pending_toss'].includes(o.status))return c.json({ok:false,error:'QUOTE_NOT_AVAILABLE'},409);
 const amount=Number(o.discounted_tl);
 if(!Number.isSafeInteger(amount)||amount<1000)return c.json({ok:false,error:'TOSS_MINIMUM_1000_KRW'},400);
 const orderId='v5time_'+quoteId.replace(/-/g,'');
 const updated=await c.env.DB.prepare("UPDATE v5_shareplace_time_test_orders SET status='pending_toss',method='cash' WHERE quote_id=? AND user_id=? AND status='quoted'").bind(quoteId,Number(uid)).run();
 if(!updated.meta?.changes&&o.status!=='pending_toss')return c.json({ok:false,error:'QUOTE_ALREADY_USED'},409);
 return c.json({ok:true,orderId,amount,clientKey:key,mode:'test',seconds:Number(o.seconds)});
});
payment.post('/v5/shareplace-time/toss/confirm',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),orderId=String(b?.orderId||''),paymentKey=String(b?.paymentKey||''),amount=Number(b?.amount);
 if(!/^v5time_[a-f0-9]{32}$/.test(orderId)||!paymentKey||!Number.isSafeInteger(amount))return c.json({ok:false,error:'INVALID_REQUEST'},400);
 const quoteId=orderId.slice(7).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
 const o=await c.env.DB.prepare('SELECT * FROM v5_shareplace_time_test_orders WHERE quote_id=? AND user_id=?').bind(quoteId,Number(uid)).first<any>();
 if(!o||Number(o.discounted_tl)!==amount)return c.json({ok:false,error:'ORDER_AMOUNT_MISMATCH'},403);
 if(o.status==='toss_paid')return c.json({ok:true,alreadyCompleted:true,seconds:o.seconds,amount,entitlementType:'time_free',...await timeFreePreflight(c.env.DB,Number(uid))});
 if(o.status!=='pending_toss')return c.json({ok:false,error:'ORDER_NOT_PENDING'},409);
 const secret=String(c.env.TOSS_SECRET_KEY||'');if(!secret.startsWith('test_sk_'))return c.json({ok:false,error:'TOSS_TEST_SECRET_REQUIRED'},503);
 try{
  const response=await fetch('https://api.tosspayments.com/v1/payments/confirm',{method:'POST',headers:{Authorization:'Basic '+btoa(secret+':'),'Content-Type':'application/json','Idempotency-Key':'v5time-'+orderId},body:JSON.stringify({paymentKey,orderId,amount})});
  const proof:any=await response.json().catch(()=>({}));
  if(!response.ok||proof.status!=='DONE'||proof.orderId!==orderId||Number(proof.totalAmount)!==amount||proof.paymentKey!==paymentKey)return c.json({ok:false,error:proof.message||'TOSS_CONFIRM_FAILED'},400);
  await ensureTimeFreeSchema(c.env.DB);
  await c.env.DB.batch([
   c.env.DB.prepare("UPDATE v5_shareplace_time_test_orders SET status='toss_paid',paid_at=CURRENT_TIMESTAMP WHERE quote_id=? AND user_id=? AND status='pending_toss'").bind(quoteId,Number(uid)),
   timeFreeGrantStatement(c.env.DB,quoteId,Number(uid),Number(o.seconds),'test'),
  ]);
  return c.json({ok:true,seconds:o.seconds,amount,testPayment:true,tlBCredited:false,entitlementType:'time_free',...await timeFreePreflight(c.env.DB,Number(uid))});
 }catch(e){console.error('[TIME_TOSS_CONFIRM]',e);return c.json({ok:false,error:'TOSS_CONFIRM_UNAVAILABLE'},503);}
});

// V5 TL PREMIUM: cash promotion prices are informational until a separate
// verified PG order + airtime settlement pipeline is implemented.
// Never route promotion purchases through the ordinary TL top-up endpoints.
payment.get('/v5/premium/plans', (c) => c.json({
  ok: true,
  currency: 'KRW',
  krw_per_verified_airtime_second: 2.5,
  tl_per_verified_airtime_second: 5,
  tl_payment_bucket: 'TL_P',
  excluded_tl_buckets: ['TL_A','TL_B'],
  rates_are_independent: true,
  settlement_policy: 'verified_airtime_only',
  unused_budget_policy: 'return_unspent_on_cancellation',
  plans: [
    { id: 'trial', amount_krw: 5000, estimated_tl_budget_for_equivalent_airtime: 10000 },
    { id: 'basic', amount_krw: 15000, estimated_tl_budget_for_equivalent_airtime: 30000 },
    { id: 'focused', amount_krw: 30000, estimated_tl_budget_for_equivalent_airtime: 60000 },
    { id: 'premium', amount_krw: 50000, estimated_tl_budget_for_equivalent_airtime: 100000 }
  ],
  checkout_enabled: false,
  settlement_enabled: false,
  note: 'Cash promotion is separate from TL charging. Payment and verified airtime settlement are not yet enabled.'
}));


/* ──────────────────────────────────────────────────
   공통 유틸: 토큰 파싱 → user_id
────────────────────────────────────────────────── */
async function authUserId(c: any): Promise<string | null> {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const secret = String((c.env as any).JWT_SECRET || '');
  if (!token || !secret) return null;
  const payload = await verifyToken(token, secret).catch(() => null);
  if (!payload?.sub || !/^\d+$/.test(String(payload.sub))) return null;
  const user=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(payload.sub).first();
  return user?String(payload.sub):null;
}

// Preparation only: orders do not debit wallets or charge cards.
payment.post('/v5/premium/prepare',async c=>{
 const userId=await authUserId(c);
 if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null);
 const amounts:Record<string,number>={trial:5000,basic:15000,focused:30000,premium:50000};
 const plan=String(b?.plan||''),method=String(b?.method||'');
 const fileId=Number(b?.file_id);
 if(!Object.prototype.hasOwnProperty.call(amounts,plan)||
    !['cash','tl'].includes(method)||!Number.isSafeInteger(fileId)||
    fileId<=0||b?.rights_accepted!==true)
   return c.json({ok:false,error:'INVALID_REQUEST'},400);
 try{
  // Promotion application is open to every published V5 track owned by the applicant.
  // Music-gate approval and creator rights are NOT promotion purchase prerequisites.
  // Broadcast licensing and any rights dispute remain independent gates before airtime.
  const file=await c.env.DB.prepare(`SELECT f.id FROM tl_files f
    JOIN tl3_v5_releases v ON v.file_id=f.id
    WHERE f.id=? AND f.user_id=? AND f.shared=1
      AND v.status='sealed' AND COALESCE(f.revenue_held,0)=0
    LIMIT 1`).bind(fileId,Number(userId)).first();
  if(!file)return c.json({ok:false,error:'NOT_ELIGIBLE',reason:'FILE_NOT_PUBLISHED_OR_NOT_OWNED'},403);
  const amount=amounts[plan];
  return c.json({ok:true,method,plan,file_id:fileId,
    amount_krw:method==='cash'?amount:null,
    amount_tl:method==='tl'?amount*2:null,
    order_created:false,checkout_enabled:false,
    note:'Eligibility verified only; no funds reserved or charged.'});
 }catch{return c.json({ok:false,error:'PREPARATION_UNAVAILABLE'},503);}
});

// Toss premium confirmation is distinct from TL top-up: no TL is credited.
payment.post('/v5/premium/toss/confirm',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null);
 const orderId=String(b?.orderId||''),paymentKey=String(b?.paymentKey||''),amount=Number(b?.amount);
 if(!orderId.startsWith('v5promo_'+uid+'_')||!paymentKey||!Number.isSafeInteger(amount)||amount<1)return c.json({ok:false,error:'INVALID_REQUEST'},400);
 try{
  const order=await c.env.DB.prepare('SELECT * FROM v5_premium_orders WHERE order_id=? AND user_id=? AND method=?').bind(orderId,Number(uid),'cash').first<any>();
  if(!order||Number(order.amount)!==amount)return c.json({ok:false,error:'ORDER_MISMATCH'},403);
  if(order.status==='toss_test_paid_pending_broadcast')return c.json({ok:true,order_id:orderId,status:order.status,replayed:true});
  if(order.status!=='pending_toss')return c.json({ok:false,error:'ORDER_NOT_PENDING'},409);
  const secret=String((c.env as any).TOSS_SECRET_KEY||'');
  if(!secret||!secret.startsWith('test_sk_'))return c.json({ok:false,error:'TOSS_TEST_SECRET_REQUIRED'},503);
  const response=await fetch('https://api.tosspayments.com/v1/payments/confirm',{method:'POST',headers:{Authorization:'Basic '+btoa(secret+':'),'Content-Type':'application/json'},body:JSON.stringify({paymentKey,orderId,amount})});
  const verified:any=await response.json();
  if(!response.ok||verified?.status!=='DONE'||verified?.orderId!==orderId||Number(verified?.totalAmount)!==amount)return c.json({ok:false,error:verified?.message||'TOSS_CONFIRM_FAILED'},400);
  await c.env.DB.prepare("UPDATE v5_premium_orders SET status='toss_test_paid_pending_broadcast' WHERE order_id=? AND user_id=? AND status='pending_toss'").bind(orderId,Number(uid)).run();
  return c.json({ok:true,order_id:orderId,status:'toss_test_paid_pending_broadcast',test_payment:true});
 }catch(e){console.error('[PREMIUM_TOSS_CONFIRM]',e);return c.json({ok:false,error:'TOSS_CONFIRM_UNAVAILABLE'},503);}
});

// Premium cash uses Toss PG test-mode verification; TL_P uses the real V5 ledger.
payment.post('/v5/premium/checkout',async c=>{
 const uid=await authUserId(c);if(!uid)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null);
 const prices:Record<string,number>={trial:5000,basic:15000,focused:30000,premium:50000};
 const ids=b?.file_ids,plan=String(b?.plan||''),method=String(b?.method||'');
 if(!Array.isArray(ids)||ids.length<1||ids.length>30||ids.some((x:any)=>!Number.isSafeInteger(x)||x<1)||new Set(ids).size!==ids.length||!Object.hasOwn(prices,plan)||!['cash','tl'].includes(method)||b?.rights_accepted!==true||typeof b?.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(b.request_id))return c.json({ok:false,error:'INVALID_REQUEST'},400);
 const orderId='v5promo_'+uid+'_'+b.request_id,amount=prices[plan]*ids.length*(method==='tl'?2:1);
 try{
  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS v5_premium_orders(order_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,method TEXT NOT NULL,plan TEXT NOT NULL,file_ids_json TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')))`).run();
  const existing=await c.env.DB.prepare('SELECT * FROM v5_premium_orders WHERE order_id=?').bind(orderId).first<any>();
  if(existing){if(existing.user_id!=uid||existing.method!==method||existing.plan!==plan||existing.file_ids_json!==JSON.stringify(ids))return c.json({ok:false,error:'ORDER_CONFLICT'},409);return c.json({ok:true,order_id:orderId,status:existing.status,amount:existing.amount,replayed:true});}
  const matches=await c.env.DB.prepare(`SELECT COUNT(DISTINCT f.id) n FROM tl_files f JOIN tl3_v5_releases v ON v.file_id=f.id WHERE f.id IN (${ids.map(()=>'?').join(',')}) AND f.user_id=? AND f.shared=1 AND v.status='sealed' AND COALESCE(f.revenue_held,0)=0`).bind(...ids,Number(uid)).first<any>();
  if(Number(matches?.n)!==ids.length)return c.json({ok:false,error:'TRACK_NOT_ELIGIBLE'},403);
  const status=method==='cash'?'pending_toss':'funded_pending_broadcast';
  const insert=c.env.DB.prepare('INSERT INTO v5_premium_orders(order_id,user_id,method,plan,file_ids_json,amount,status) VALUES(?,?,?,?,?,?,?)').bind(orderId,Number(uid),method,plan,JSON.stringify(ids),amount,status);
  if(method==='cash'){
   await insert.run();return c.json({ok:true,order_id:orderId,status,amount,currency:'KRW',toss_checkout:true});
  }
  await assertTLAtomScale(c.env.DB);
  const from=await ensureLedgerAccount(c.env.DB,'user',uid,'TL','wallet_paid');
  const to=await ensureLedgerAccount(c.env.DB,'escrow',orderId,'TL','premium_budget');
  const atoms=tlToAtoms(amount);
  const balance=await c.env.DB.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').bind(from).first<any>();
  if(Number(balance?.available_atoms||0)<atoms)return c.json({ok:false,error:'INSUFFICIENT_TL_P',required_tl:amount,available_tl_p:Number((Number(balance?.available_atoms||0)/10000).toFixed(4)),shortfall_tl:Number(((atoms-Number(balance?.available_atoms||0))/10000).toFixed(4))},409);
  await c.env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS v5_premium_wallet_paid_nonnegative BEFORE UPDATE OF available_atoms ON v3_economy_balances WHEN NEW.available_atoms<0 AND EXISTS(SELECT 1 FROM v3_economy_accounts a WHERE a.id=NEW.account_id AND a.bucket='wallet_paid') BEGIN SELECT RAISE(ABORT,'INSUFFICIENT_TL_P'); END`).run();
  await postLedgerTransaction(c.env.DB,{idempotencyKey:'premium:'+orderId,transactionType:'premium_budget_reserve',source:'premium_tl',referenceType:'premium_order',referenceId:orderId,actorUserId:uid,description:'TL PREMIUM 홍보 예산 보관',metadata:{plan,file_ids:ids,amount},lines:[{accountId:from,assetCode:'TL',amountAtoms:-atoms},{accountId:to,assetCode:'TL',amountAtoms:atoms}],atomicStatements:[insert]});
  return c.json({ok:true,order_id:orderId,status,amount,currency:'TL',simulated:false});
 }catch(e:any){console.error('[PREMIUM_CHECKOUT]',e);return c.json({ok:false,error:'CHECKOUT_FAILED'},503);}
});

/* ──────────────────────────────────────────────────
   결제 내역 테이블 생성 (첫 요청 시 자동)
   CREATE TABLE tl_payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     method TEXT NOT NULL,          -- toss | portone | stripe
     pg_id TEXT NOT NULL UNIQUE,    -- imp_uid | payment_intent_id
     merchant_uid TEXT,
     amount_krw INTEGER NOT NULL,   -- 실제 결제 금액 (원)
     tl_granted INTEGER NOT NULL,   -- 지급된 TL
     status TEXT DEFAULT 'pending', -- pending | success | fail
     created_at TEXT DEFAULT (datetime('now'))
   );
────────────────────────────────────────────────── */
async function ensurePaymentTable(db: any) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tl_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      method TEXT NOT NULL,
      pg_id TEXT NOT NULL UNIQUE,
      merchant_uid TEXT,
      amount_krw INTEGER NOT NULL,
      tl_granted INTEGER NOT NULL,
      bonus_tl INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  const columns = await db.prepare('PRAGMA table_info(tl_payments)').all();
  if (!(columns.results || []).some((col: any) => col.name === 'bonus_tl')) {
    await db.prepare('ALTER TABLE tl_payments ADD COLUMN bonus_tl INTEGER NOT NULL DEFAULT 0').run();
  }
}

/* ══════════════════════════════════════════════════
   Toss 결제 주문 생성
   - 주문 ID를 로그인 사용자와 서버에서 묶는다.
   - 클라이언트가 임의의 orderId로 다른 사용자의 결제를 가로채지 못하게 한다.
══════════════════════════════════════════════════ */
async function ensureTossOrderTable(db: any) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tl_toss_orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_krw INTEGER NOT NULL,
      status TEXT DEFAULT 'ready',
      payment_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
}

/* ══════════════════════════════════════════════════
   TimeLink 내부 가상 충전
   - 실제 금융기관/PG를 호출하지 않는다.
   - 개발/테스트용으로 선택한 패키지를 즉시 TL로 지급한다.
   POST /api/payment/virtual/charge
   body: { amount }
══════════════════════════════════════════════════ */
payment.post('/virtual/charge', async (c) => {
  if (String(c.env.ENVIRONMENT || '').toLowerCase() === 'production') {
    return c.json({ error: '개발용 가상 충전은 운영 환경에서 사용할 수 없습니다.' }, 403);
  }
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  try {
    const { amount } = await c.req.json() as any;
    const paidAmount = Number(amount);
    const rewardPolicy=await readRewardPolicy(c.env.DB);
    const bonusMap=paymentBonusMap(rewardPolicy.rules);

    if (!Number.isInteger(paidAmount) || !Object.prototype.hasOwnProperty.call(bonusMap, paidAmount)) {
      return c.json({ error: '지원하지 않는 충전 금액입니다.' }, 400);
    }

    const bonus_tl = bonusMap[paidAmount];
    const total_tl = paidAmount + bonus_tl;
    const pgId = 'VIRTUAL_' + String(userId) + '_' + Date.now() + '_' +
      crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    await ensurePaymentTable(c.env.DB);

    await creditVerifiedPayment(c.env.DB,{userId,method:'virtual',paymentId:pgId,orderId:pgId,paidTL:paidAmount,bonusTL:bonus_tl});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};

    return c.json({
      success: true,
      mode: 'virtual',
      paid_amount: paidAmount,
      bonus_tl,
      total_tl,
      tl_granted: total_tl,
      tl_balance: Number(user?.tl || 0),
      tl_p: Number(user?.tl_p || 0)
    });
  } catch (e: any) {
    return c.json({ error: e?.message || '가상 충전 처리 실패' }, 500);
  }
});

async function createProviderOrder(c:any,provider:'toss'|'portone') {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);
  try {
    const { amount } = await c.req.json() as any;
    const paidAmount = Number(amount);
    const allowed = [5000, 10000, 30000, 50000, 100000];
    if (!Number.isInteger(paidAmount) || !allowed.includes(paidAmount)) {
      return c.json({ error: '지원하지 않는 충전 금액입니다.' }, 400);
    }
    await ensureTossOrderTable(c.env.DB);
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    const orderId = 'TL_'+provider+'_'  + String(userId) + '_' + Date.now() + '_' + suffix;
    await c.env.DB.prepare(
      'INSERT INTO tl_toss_orders (order_id,user_id,amount_krw,status) VALUES (?,?,?,?)'
    ).bind(orderId, userId, paidAmount, 'ready').run();
    return c.json({ ok: true, orderId, amount: paidAmount });
  } catch (e: any) {
    return c.json({ error: e?.message || '결제 주문 생성 실패' }, 500);
  }
}
payment.post('/toss/order',c=>createProviderOrder(c,'toss'));
payment.post('/portone/order',c=>createProviderOrder(c,'portone'));

/* ══════════════════════════════════════════════════
   Toss Payments 결제 승인 + TL 지급
   POST /api/payment/toss/confirm
   body: { paymentKey, orderId, amount }
══════════════════════════════════════════════════ */
payment.post('/toss/confirm', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { paymentKey, orderId, amount } = await c.req.json() as any;
  const paidAmount = Number(amount);
  if (!paymentKey || !orderId || !Number.isInteger(paidAmount) || paidAmount <= 0) {
    return c.json({ error: '잘못된 결제 요청입니다' }, 400);
  }

  await ensurePaymentTable(c.env.DB);
  await ensureTossOrderTable(c.env.DB);

  // 주문은 서버에서 로그인 사용자에게 발급한 것만 승인한다.
  const order = await c.env.DB.prepare(
    'SELECT order_id,user_id,amount_krw,status,payment_key FROM tl_toss_orders WHERE order_id=?'
  ).bind(String(orderId)).first() as any;
  if (!order || String(order.user_id) !== String(userId)) {
    return c.json({ error: '결제 주문의 사용자 정보가 일치하지 않습니다.' }, 403);
  }
  if (Number(order.amount_krw) !== paidAmount) {
    return c.json({ error: '결제 금액이 주문 금액과 일치하지 않습니다.' }, 400);
  }
  if (order.status === 'success' && order.payment_key!==paymentKey) {
    return c.json({ error: '이미 다른 결제로 처리된 주문입니다.' }, 409);
  }

  // paymentKey를 고유 키로 사용하여 동일 결제의 중복 지급을 막는다.
  const dup = await c.env.DB.prepare(
    'SELECT id,user_id,merchant_uid,status,tl_granted FROM tl_payments WHERE pg_id=?'
  ).bind(paymentKey).first() as any;
  if (dup?.status === 'success') {
    if(String(dup.user_id)!==userId||String(dup.merchant_uid)!==String(orderId))return c.json({error:'PAYMENT_OWNER_MISMATCH'},403);
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};
    return c.json({
      success: true,
      already_processed: true,
      total_tl: Number(dup.tl_granted || 0),
      bonus_tl: Math.max(0, Number(dup.tl_granted || 0) - paidAmount),
      tl_balance: Number(user?.tl || 0),
      tl_p: Number(user?.tl_p || 0)
    });
  }

  try {await assertTLAtomScale(c.env.DB);}catch{return c.json({error:'V5_LEDGER_NOT_READY'},503);}

  const TOSS_SECRET = (c.env as any).TOSS_SECRET_KEY || '';
  if (!TOSS_SECRET) {
    return c.json({ error: 'Toss 결제 검증 키(TOSS_SECRET_KEY)가 서버에 설정되지 않았습니다.' }, 503);
  }

  try {
    const auth = btoa(TOSS_SECRET + ':');
    const verifyRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ paymentKey, orderId, amount: paidAmount })
    });
    const verified: any = await verifyRes.json();

    if (!verifyRes.ok || Number(verified?.totalAmount) !== paidAmount || verified?.status !== 'DONE') {
      return c.json({
        error: verified?.message || 'Toss 결제 승인/금액 검증 실패',
        code: verified?.code || 'TOSS_VERIFY_FAILED'
      }, 400);
    }

    // 결제 금액별 보너스는 SharePlace의 충전 패키지와 동일하게 적용한다.
    const rewardPolicy=await readRewardPolicy(c.env.DB);
    const bonusMap=paymentBonusMap(rewardPolicy.rules);
    const bonus_tl = bonusMap[paidAmount] || 0;
    const total_tl = paidAmount + bonus_tl;

    await creditVerifiedPayment(c.env.DB,{userId,method:'toss',paymentId:paymentKey,orderId,
      paidTL:paidAmount,bonusTL:bonus_tl,paymentMode:TOSS_SECRET.startsWith('test_sk_')?'test':TOSS_SECRET.startsWith('live_sk_')?'live':'unknown',atomicStatements:[c.env.DB.prepare(
        "UPDATE tl_toss_orders SET status='success', payment_key=?, updated_at=datetime('now') WHERE order_id=? AND user_id=? AND status='ready'"
      ).bind(paymentKey,orderId,userId)]});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};

    return c.json({
      success: true,
      paid_amount: paidAmount,
      bonus_tl,
      total_tl,
      tl_granted: total_tl,
      tl_balance: Number(user?.tl || 0),
      tl_p: Number(user?.tl_p || 0)
    });
  } catch (e: any) {
    return c.json({ error: e?.message || 'Toss 결제 처리 실패' }, 500);
  }
});

/* ══════════════════════════════════════════════════
   포트원(아임포트) 결제 검증 + TL 지급
   POST /api/payment/portone/verify
   body: { imp_uid, merchant_uid, amount, user_id? }
══════════════════════════════════════════════════ */
payment.post('/portone/verify', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { imp_uid, merchant_uid, amount } = await c.req.json() as any;
  if (!imp_uid || !amount || amount <= 0) {
    return c.json({ error: '잘못된 결제 요청입니다' }, 400);
  }

  await ensurePaymentTable(c.env.DB);
  await ensureTossOrderTable(c.env.DB);
  try{await assertTLAtomScale(c.env.DB);}catch{return c.json({error:'V5_LEDGER_NOT_READY'},503);}
  const order=await c.env.DB.prepare('SELECT * FROM tl_toss_orders WHERE order_id=? AND user_id=?').bind(String(merchant_uid||''),userId).first<any>();
  if(!order||Number(order.amount_krw)!==Number(amount)||!String(order.order_id).startsWith('TL_portone_'))return c.json({error:'SERVER_PAYMENT_ORDER_REQUIRED'},403);

  // 중복 결제 방지
  const dup = await c.env.DB.prepare('SELECT id FROM tl_payments WHERE pg_id=?').bind(imp_uid).first();
  if (dup) return c.json({ error: '이미 처리된 결제입니다' }, 409);

  // ── 포트원 액세스 토큰 발급 ──
  const IMP_KEY    = String((c.env as any).PORTONE_IMP_KEY || '');
  const IMP_SECRET = String((c.env as any).PORTONE_IMP_SECRET || '');
  if (!IMP_KEY || !IMP_SECRET) return c.json({ error: 'PortOne 서버 키가 설정되지 않았습니다.' }, 503);

  let verified = false;
  let paidAmount = 0;

  try {
    // 1) 액세스 토큰
    const tokenRes = await fetch('https://api.iamport.kr/users/getToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imp_key: IMP_KEY, imp_secret: IMP_SECRET }),
    });
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData?.response?.access_token;

    if (accessToken) {
      // 2) 결제 정보 조회
      const payRes = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
        headers: { Authorization: accessToken },
      });
      const payData: any = await payRes.json();
      const payment = payData?.response;

      if (payment && payment.status === 'paid') {
        paidAmount = payment.amount;
        // 금액 위변조 검증
        if (paidAmount === Number(amount) && payment.merchant_uid===merchant_uid) {
          verified = true;
        }
      }
    }
  } catch (_e) {
    verified = false;
  }

  if (!verified) {
    return c.json({ error: '결제 검증 실패' }, 400);
  }

  // TL 지급 (1원 = 1TL)
  const tlGranted = paidAmount;

  try {
    await creditVerifiedPayment(c.env.DB,{userId,method:'portone',paymentId:imp_uid,orderId:merchant_uid||'',paidTL:tlGranted,bonusTL:0,atomicStatements:[c.env.DB.prepare("UPDATE tl_toss_orders SET status='success',payment_key=?,updated_at=datetime('now') WHERE order_id=? AND user_id=? AND status='ready'").bind(imp_uid,merchant_uid,userId)]});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance};
    return c.json({ success: true, tl_granted: tlGranted, tl_balance: user?.tl || 0 });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   Stripe: PaymentIntent 생성
   POST /api/payment/stripe/intent
   body: { amount_krw }   (1원 단위)
══════════════════════════════════════════════════ */
payment.post('/stripe/intent', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { amount_krw } = await c.req.json() as any;
  if (!amount_krw || amount_krw < 100) {
    return c.json({ error: '최소 결제 금액은 100원입니다' }, 400);
  }

  const STRIPE_SECRET = String((c.env as any).STRIPE_SECRET_KEY || '');
  if (!STRIPE_SECRET) return c.json({ error: 'Stripe 서버 키가 설정되지 않았습니다.' }, 503);

  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(STRIPE_SECRET + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        amount: String(amount_krw),   // KRW는 최소 단위가 1원
        currency: 'krw',
        'metadata[user_id]': userId,
        'metadata[tl_amount]': String(amount_krw),
        automatic_payment_methods: 'false',
        'payment_method_types[]': 'card',
      }),
    });
    const data: any = await res.json();

    if (data.error) return c.json({ error: data.error.message }, 400);

    return c.json({
      client_secret: data.client_secret,
      payment_intent_id: data.id,
      amount: amount_krw,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   Stripe: 결제 확인 후 TL 지급
   POST /api/payment/stripe/confirm
   body: { payment_intent_id, amount_krw }
══════════════════════════════════════════════════ */
payment.post('/stripe/confirm', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { payment_intent_id, amount_krw } = await c.req.json() as any;
  if (!payment_intent_id || !amount_krw) return c.json({ error: '잘못된 요청' }, 400);

  await ensurePaymentTable(c.env.DB);

  const dup = await c.env.DB.prepare('SELECT id,status FROM tl_payments WHERE pg_id=?').bind(payment_intent_id).first() as any;
  if (dup?.status === 'success') return c.json({ error: '이미 처리된 결제입니다' }, 409);

  const STRIPE_SECRET = String((c.env as any).STRIPE_SECRET_KEY || '');
  if (!STRIPE_SECRET) return c.json({ error: 'Stripe 서버 키가 설정되지 않았습니다.' }, 503);

  let verified = false;
  let paidAmount = Number(amount_krw);

  try {
      const res = await fetch(`https://api.stripe.com/v1/payment_intents/${payment_intent_id}`, {
        headers: { 'Authorization': 'Basic ' + btoa(STRIPE_SECRET + ':') },
      });
      const data: any = await res.json();
      if (data.status === 'succeeded' && data.currency==='krw' && Number(data.amount_received)===Number(amount_krw) && data.metadata?.user_id === userId) {
        paidAmount = data.amount;
        verified = true;
      }
  } catch (_e) {
    verified = false;
  }

  if (!verified) return c.json({ error: '결제 검증 실패' }, 400);

  const tlGranted = paidAmount;
  try {
    await creditVerifiedPayment(c.env.DB,{userId,method:'stripe',paymentId:payment_intent_id,orderId:'',paidTL:tlGranted,bonusTL:0,paymentMode:STRIPE_SECRET.startsWith('sk_test_')?'test':STRIPE_SECRET.startsWith('sk_live_')?'live':'unknown'});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};
    return c.json({ success: true, tl_granted: tlGranted, tl_balance: user?.tl || 0, tl_p: user?.tl_p || 0 });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   결제 내역 조회
   GET /api/payment/history
══════════════════════════════════════════════════ */
payment.get('/history', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  await ensurePaymentTable(c.env.DB);

  const rows = await c.env.DB.prepare(
    `SELECT method, amount_krw, tl_granted, bonus_tl, status, created_at
     FROM tl_payments WHERE user_id=? ORDER BY created_at DESC LIMIT 20`
  ).bind(userId).all();

  return c.json({ payments: rows.results || [] });
});

export default payment;

