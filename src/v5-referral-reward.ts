import {assertTLAtomScale,ensureLedgerAccount,postLedgerTransaction,tlToAtoms} from './economy-ledger';
import {readRewardPolicy} from './v5-reward-policy';

/** Evidence-only source: never accept payment IDs, amounts or POC from the browser. */
export async function ensureReferralRewardSchema(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_referral_reward_receipts (
    milestone_key TEXT PRIMARY KEY,
    referred_user_id INTEGER NOT NULL,
    referrer_user_id INTEGER NOT NULL,
    milestone TEXT NOT NULL CHECK(milestone IN ('signup_verified','store_first_paid')),
    source_reference TEXT NOT NULL,
    credited_tl_b INTEGER NOT NULL DEFAULT 0 CHECK(credited_tl_b>=0),
    poc_points REAL NOT NULL DEFAULT 0 CHECK(poc_points>=0),
    policy_version INTEGER NOT NULL,
    ledger_transaction_id TEXT,
    status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','reversed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reversed_at TEXT,
    UNIQUE(referred_user_id,milestone)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_v5_ref_rewards_referrer ON v5_referral_reward_receipts(referrer_user_id,status,created_at)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_referral_store_refunds (
    order_id TEXT PRIMARY KEY,
    referred_user_id INTEGER NOT NULL,
    refund_reference TEXT NOT NULL UNIQUE,
    verified_by_admin INTEGER NOT NULL,
    refunded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_v5_referral_store_refunds_user ON v5_referral_store_refunds(referred_user_id,refunded_at)').run();
}
export type ReferralMilestone = 'signup_verified'|'store_first_paid';
function positiveInt(value:unknown):number{
 const n=Number(value);
 if(!Number.isSafeInteger(n)||n<=0)throw Error('INVALID_REFERRAL_MEMBER');
 return n;
}
export async function settleVerifiedReferral(db:D1Database,referrerIdInput:number,referredIdInput:number,
 milestone:ReferralMilestone):Promise<{status:string;milestone:string;tl_b:number;poc_points:number;ledger_transaction_id:string|null}>{
 const referrerId=positiveInt(referrerIdInput),referredId=positiveInt(referredIdInput);
 if(referrerId===referredId)throw Error('SELF_REFERRAL');
 if(!['signup_verified','store_first_paid'].includes(milestone))throw Error('INVALID_REFERRAL_MILESTONE');
 await ensureReferralRewardSchema(db);
 const claim=await db.prepare(`SELECT cl.referred_user_id,cl.referrer_user_id,cl.created_at,
  u.email_verified,u.is_active,u.account_forfeited,u.created_at AS joined_at,
  r.is_active AS referrer_active,r.account_forfeited AS referrer_forfeited
  FROM v5_member_referral_claims cl
  JOIN users u ON u.id=cl.referred_user_id
  JOIN users r ON r.id=cl.referrer_user_id
  WHERE cl.referred_user_id=? AND cl.referrer_user_id=?`)
  .bind(referredId,referrerId).first<any>();
 if(!claim||Number(claim.email_verified)!==1||Number(claim.is_active)===0||
   Number(claim.account_forfeited)!==0||Number(claim.referrer_active)===0||
   Number(claim.referrer_forfeited)!==0)throw Error('REFERRAL_VERIFICATION_REQUIRED');
 // Referrals must be claimed near account creation, not attached to old members.
 const accountTime=Date.parse(String(claim.joined_at||'').replace(' ','T')+'Z');
 const claimTime=Date.parse(String(claim.created_at||'').replace(' ','T')+'Z');
 if(!Number.isFinite(accountTime)||!Number.isFinite(claimTime)||
    claimTime<accountTime-60000||claimTime>accountTime+14*86400000)throw Error('REFERRAL_SIGNUP_WINDOW_EXPIRED');
 const key='referral:'+milestone+':'+referredId;
 const prior=await db.prepare('SELECT status,credited_tl_b,poc_points,ledger_transaction_id FROM v5_referral_reward_receipts WHERE milestone_key=?')
  .bind(key).first<any>();
 if(prior){
   let transactionId=prior.ledger_transaction_id||null;
   if(transactionId===key){
     const tx=await db.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>();
     transactionId=tx?.id||transactionId;
   }
   return {status:String(prior.status),milestone,tl_b:Number(prior.credited_tl_b),poc_points:Number(prior.poc_points),ledger_transaction_id:transactionId};
 }
 let sourceReference='member:'+referredId;
 if(milestone==='store_first_paid'){
  // This is the provider-confirmed *sandbox* commercial time ledger. Never
  // treat a pending quote, free store creation or trial as a paid referral.
  const paid=await db.prepare(`SELECT o.order_id FROM v5_store_airtime_orders o
    JOIN cafe_channels c ON c.channel_id=o.channel_id AND c.owner_id=o.user_id
    JOIN v5_store_airtime_grants g ON g.order_id=o.order_id AND g.user_id=o.user_id
    WHERE o.user_id=? AND o.paid_at>=? AND o.status='paid' AND o.payment_key IS NOT NULL
      AND o.amount_krw>0 AND c.status='active'
      AND NOT EXISTS(SELECT 1 FROM v5_referral_store_refunds rf WHERE rf.order_id=o.order_id)
    ORDER BY o.paid_at,o.order_id LIMIT 1`).bind(referredId,claim.created_at).first<any>().catch(()=>null);
  if(!paid)throw Error('VERIFIED_STORE_PAYMENT_REQUIRED');
  sourceReference='sandbox_store_payment:'+String(paid.order_id);
 }
 const reward=await readRewardPolicy(db);
 const isSignup=milestone==='signup_verified';
 const tl_b=Number(isSignup?reward.rules.referral_signup_tl_b:reward.rules.referral_store_tl_b);
 const poc_points=Number(isSignup?reward.rules.referral_signup_poc:reward.rules.referral_store_poc);
 if(!Number.isSafeInteger(tl_b)||tl_b<0||!Number.isFinite(poc_points)||poc_points<0)throw Error('INVALID_REFERRAL_POLICY');
 const sql=`INSERT INTO v5_referral_reward_receipts
   (milestone_key,referred_user_id,referrer_user_id,milestone,source_reference,credited_tl_b,poc_points,policy_version,ledger_transaction_id)
   VALUES(?,?,?,?,?,?,?,?,?)`;
 const sourceArgs=[key,referredId,referrerId,milestone,sourceReference,tl_b,poc_points,reward.version];
 if(tl_b===0){
   try{await db.prepare(sql).bind(...sourceArgs,null).run();}
   catch(error){const repeat=await db.prepare('SELECT milestone_key FROM v5_referral_reward_receipts WHERE milestone_key=?').bind(key).first();if(!repeat)throw error;}
   return {status:'posted',milestone,tl_b,poc_points,ledger_transaction_id:null};
 }
 await assertTLAtomScale(db);
 const target=await ensureLedgerAccount(db,'user',referrerId,'TL','wallet_bonus');
 const source=await ensureLedgerAccount(db,'system','v5-referrals','TL','issuance');
 const amountAtoms=tlToAtoms(tl_b);
 const posted=await postLedgerTransaction(db,{
   idempotencyKey:key,transactionType:'referral_bonus',source:'verified_referral',
   referenceType:milestone,referenceId:String(referredId),actorUserId:String(referrerId),
   description:'검증된 추천 성과에 대한 환금 불가 TL_B',
   metadata:{milestone,source_reference:sourceReference,policy_version:reward.version,non_redeemable:true},
   lines:[{accountId:source,assetCode:'TL',amountAtoms:-amountAtoms},
          {accountId:target,assetCode:'TL',amountAtoms:amountAtoms}],
   issuanceStatements:[db.prepare('UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1 WHERE account_id=?').bind(amountAtoms,source)],
   atomicStatements:[db.prepare(sql).bind(...sourceArgs,key)]
 });
 // Atomically written reward references are keyed by the idempotency key.
 // Normalize the display reference to the canonical immutable transaction UUID.
 await db.prepare('UPDATE v5_referral_reward_receipts SET ledger_transaction_id=? WHERE milestone_key=? AND ledger_transaction_id=?')
  .bind(posted.id,key,key).run();
 return {status:'posted',milestone,tl_b,poc_points,ledger_transaction_id:posted.id};
}
/** Explicit administrator-adjudicated reversal. Never erase historic receipts. */
export async function reverseReferralReward(db:D1Database,actorId:number,milestoneKey:string,proofRef:string){
 positiveInt(actorId);
 if(!/^referral:(signup_verified|store_first_paid):[1-9][0-9]*$/.test(milestoneKey)||
   typeof proofRef!=='string'||proofRef.length<8||proofRef.length>200)
   throw Error('INVALID_REFERRAL_REVERSAL');
 await ensureReferralRewardSchema(db);
 const item=await db.prepare('SELECT milestone_key,referrer_user_id,credited_tl_b,status FROM v5_referral_reward_receipts WHERE milestone_key=?')
   .bind(milestoneKey).first<any>();
 if(!item)throw Error('REFERRAL_RECEIPT_NOT_FOUND');
 if(item.status==='reversed')return {ok:true,already_reversed:true};
 if(item.status!=='posted')throw Error('REFERRAL_REVERSAL_INVALID_STATUS');
 const amount=Number(item.credited_tl_b);
 const sql="UPDATE v5_referral_reward_receipts SET status='reversed',reversed_at=CURRENT_TIMESTAMP WHERE milestone_key=? AND status='posted'";
 if(amount===0){
  const r=await db.prepare(sql).bind(milestoneKey).run();
  return {ok:true,already_reversed:!r.meta?.changes,tl_b_reversed:0,poc_reversed:true};
 }
 await assertTLAtomScale(db);
 const userAccount=await ensureLedgerAccount(db,'user',Number(item.referrer_user_id),'TL','wallet_bonus');
 const systemAccount=await ensureLedgerAccount(db,'system','v5-referrals','TL','reversals');
 const atoms=tlToAtoms(amount);
 const posted=await postLedgerTransaction(db,{
  idempotencyKey:'referral:reversal:'+milestoneKey,
  transactionType:'referral_bonus_reversal',source:'admin_verified_refund',
  referenceType:'referral_reward',referenceId:milestoneKey,actorUserId:String(actorId),
  description:'관리자 환불 증빙 확인에 따른 추천 TL_B 역분개',
  metadata:{proof_reference:proofRef,original_reward:milestoneKey,non_redeemable:true},
  lines:[{accountId:userAccount,assetCode:'TL',amountAtoms:-atoms},
    {accountId:systemAccount,assetCode:'TL',amountAtoms:atoms}],
  atomicStatements:[db.prepare(sql).bind(milestoneKey)]
 });
 return {ok:true,already_reversed:posted.replayed,tl_b_reversed:amount,poc_reversed:true,transaction_id:posted.id};
}

/** The active PoC estimator reads only immutable, server-created receipt facts. */
export async function readReferralPocBonus(db:D1Database,userId:string,monthStart:string):Promise<number>{
 await ensureReferralRewardSchema(db);
 const row=await db.prepare(`SELECT COALESCE(SUM(r.poc_points),0) AS total
    FROM v5_referral_reward_receipts r
    WHERE r.referrer_user_id=? AND r.status='posted' AND r.created_at>=?
      AND NOT (r.milestone='store_first_paid' AND EXISTS(
        SELECT 1 FROM v5_referral_store_refunds rf
        WHERE r.source_reference='sandbox_store_payment:'||rf.order_id
      ))`)
   .bind(Number(userId),monthStart).first<any>();
 return Math.max(0,Number(row?.total||0));
}

/** Record administrator-verified store refund evidence and reverse only the
 * referral reward whose immutable source is that exact paid order. A refund of
 * a later order must never reverse an earlier first-payment reward. */
export async function reverseStoreReferralForRefund(db:D1Database,actorId:number,orderId:string,proofRef:string){
 positiveInt(actorId);
 if(!/^v5store_[a-f0-9]{32}$/.test(orderId)||typeof proofRef!=='string'||proofRef.length<8||proofRef.length>200)
   throw Error('INVALID_STORE_REFERRAL_REFUND');
 await ensureReferralRewardSchema(db);
 const order=await db.prepare(`SELECT o.order_id,o.user_id,o.status,o.payment_key,g.order_id AS grant_order
   FROM v5_store_airtime_orders o
   JOIN v5_store_airtime_grants g ON g.order_id=o.order_id AND g.user_id=o.user_id
   WHERE o.order_id=?`).bind(orderId).first<any>();
 if(!order||order.status!=='paid'||!order.payment_key||!order.grant_order)
   throw Error('VERIFIED_STORE_PAYMENT_REQUIRED');
 const existing=await db.prepare('SELECT refund_reference FROM v5_referral_store_refunds WHERE order_id=?').bind(orderId).first<any>();
 if(existing&&String(existing.refund_reference)!==proofRef)throw Error('REFUND_REFERENCE_CONFLICT');
 if(!existing){
   try{
     await db.prepare('INSERT INTO v5_referral_store_refunds(order_id,referred_user_id,refund_reference,verified_by_admin) VALUES(?,?,?,?)')
       .bind(orderId,Number(order.user_id),proofRef,actorId).run();
   }catch(error){
     const repeat=await db.prepare('SELECT order_id,refund_reference FROM v5_referral_store_refunds WHERE order_id=?').bind(orderId).first<any>();
     if(!repeat||String(repeat.refund_reference)!==proofRef)throw error;
   }
 }
 const source='sandbox_store_payment:'+orderId;
 const receipt=await db.prepare(`SELECT milestone_key,status FROM v5_referral_reward_receipts
   WHERE referred_user_id=? AND milestone='store_first_paid' AND source_reference=? LIMIT 1`)
   .bind(Number(order.user_id),source).first<any>();
 if(!receipt)return {ok:true,refund_recorded:true,reward_affected:false,already_reversed:false};
 const reversed=await reverseReferralReward(db,actorId,String(receipt.milestone_key),proofRef);
 return {...reversed,refund_recorded:true,reward_affected:true};
}
