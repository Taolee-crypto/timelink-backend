import {readPurchasedTlAttribution} from './v5-purchased-tl-attribution';
import {ensurePurchasedTlLotSchema,purchasedTlConversionDecision} from './v5-purchased-tl-lifecycle';
import {assertTLAtomScale,ensureLedgerAccount,postLedgerTransaction} from './economy-ledger';

type StoredLot={
 payment_key:string;user_id:string;paid_atoms:number;converted_atoms:number;
 payment_mode:'live'|'test'|'unknown';refund_deadline_ms:number|null;
 remaining_purchased_atoms:number|null;consumer_rights_cleared:number;
 legal_review_approved:number;refund_dispute_pending:number;recorded_at_ms:number;
 conversion_status:string;
};
export async function ensurePurchasedTlReviewSchema(db:D1Database){
 await ensurePurchasedTlLotSchema(db);
 await db.prepare(
  "CREATE TABLE IF NOT EXISTS v5_purchased_tl_review_audit ("+
  "id INTEGER PRIMARY KEY AUTOINCREMENT,payment_key TEXT NOT NULL,user_id TEXT NOT NULL,"+
  "reviewer_id INTEGER NOT NULL,country TEXT NOT NULL,legal_basis TEXT NOT NULL,"+
  "evidence_sha256 TEXT NOT NULL,review_note TEXT NOT NULL,refund_deadline_ms INTEGER NOT NULL,"+
  "reviewed_remaining_atoms INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
 ).run();
 await db.prepare(
  "CREATE INDEX IF NOT EXISTS idx_v5_tlp_review_audit_lot ON v5_purchased_tl_review_audit(payment_key,id)"
 ).run();
 // A persistent singleton CHECK fails a D1 batch atomically if changes()=0.
 await db.prepare(
  "CREATE TABLE IF NOT EXISTS v5_purchased_tl_conversion_guard ("+
  "singleton INTEGER PRIMARY KEY CHECK(singleton=1),ok INTEGER NOT NULL CHECK(ok=1))"
 ).run();
}
function checkGuard(db:D1Database):D1PreparedStatement {
 return db.prepare(
  'INSERT INTO v5_purchased_tl_conversion_guard(singleton,ok) VALUES(1,changes()) '+
  'ON CONFLICT(singleton) DO UPDATE SET ok=excluded.ok'
 );
}
async function storedLot(db:D1Database,userId:string,paymentKey:string):Promise<StoredLot> {
 const lot=await db.prepare(
  'SELECT payment_key,user_id,paid_atoms,converted_atoms,payment_mode,refund_deadline_ms,'+
  'remaining_purchased_atoms,consumer_rights_cleared,legal_review_approved,'+
  'refund_dispute_pending,recorded_at_ms,conversion_status '+
  'FROM v5_purchased_tl_lots WHERE payment_key=? AND user_id=?'
 ).bind(paymentKey,userId).first<StoredLot>();
 if(!lot)throw Error('PURCHASE_LOT_NOT_FOUND');
 return lot;
}
const validKey=(x:string)=>/^v5-payment:[A-Za-z0-9:_-]{1,160}$/.test(x);
const validUser=(x:string)=>/^[0-9]{1,15}$/.test(x);

export async function previewPurchasedTlMaturity(db:D1Database,userId:string,paymentKey:string,nowMs=Date.now()){
 if(!validKey(paymentKey)||!validUser(userId))throw Error('INVALID_PURCHASE_MATURITY_SCOPE');
 await ensurePurchasedTlReviewSchema(db);
 const projection=await readPurchasedTlAttribution(db,userId);
 const matched=projection.lots.find(l=>l.paymentKey===paymentKey);
 if(!matched)throw Error('PURCHASE_LOT_ATTRIBUTION_MISSING');
 const lot=await storedLot(db,userId,paymentKey);
 const decision=purchasedTlConversionDecision({
  paymentMode:lot.payment_mode,
  legalReviewApproved:lot.legal_review_approved===1,
  consumerRefundRightsCleared:lot.consumer_rights_cleared===1,
  refundDeadlineMs:lot.refund_deadline_ms,
  remainingPurchasedAtoms:lot.remaining_purchased_atoms,
  refundDisputePending:lot.refund_dispute_pending===1,nowMs
 });
 const eligible=decision==='ELIGIBLE_FOR_CONTROLLED_CONVERSION'&&
   lot.remaining_purchased_atoms===matched.remainingPurchasedAtoms &&
   matched.pools.length===0 && matched.walletAtoms>0;
 return {paymentKey,userId,decision:matched.pools.length?'PURCHASE_CREDITS_IN_TRACK_POOL':(
   decision==='ELIGIBLE_FOR_CONTROLLED_CONVERSION'&&
   lot.remaining_purchased_atoms!==matched.remainingPurchasedAtoms?'ATTRIBUTION_CHANGED_REQUIRE_REVIEW':decision),
  eligible,remainingPurchasedAtoms:matched.remainingPurchasedAtoms,
  walletPurchasedAtoms:matched.walletAtoms,paidPools:matched.pools,
  storedReviewedAtoms:lot.remaining_purchased_atoms,
  refundDeadlineMs:lot.refund_deadline_ms,
  paymentMode:lot.payment_mode,convertedAtoms:lot.converted_atoms,
  sourcePolicy:projection.sourcePolicy,ledgerRowsChecked:projection.rowsChecked};
}

export async function reviewPurchasedTlMaturity(db:D1Database,input:{
 userId:string;paymentKey:string;reviewerId:number;
 refundDeadlineMs:number;country:string;legalBasis:string;
 evidenceSha256:string;reviewNote:string;nowMs?:number;
}){
 const {userId,paymentKey,reviewerId,refundDeadlineMs,country}=input;
 if(!validKey(paymentKey)||!validUser(userId)||!Number.isSafeInteger(reviewerId)||reviewerId<=0)
  throw Error('INVALID_PURCHASE_MATURITY_REVIEW');
 if(!Number.isSafeInteger(refundDeadlineMs)||refundDeadlineMs<=0||
    !/^[A-Z]{2}$/.test(country)||input.legalBasis.trim().length<20||
    input.legalBasis.length>1000||!/^[a-f0-9]{64}$/.test(input.evidenceSha256)||
    input.reviewNote.trim().length<20||input.reviewNote.length>2000)
  throw Error('LEGAL_REVIEW_EVIDENCE_REQUIRED');
 await ensurePurchasedTlReviewSchema(db);
 const current=await storedLot(db,userId,paymentKey);
 if(current.payment_mode!=='live')throw Error('LIVE_PURCHASE_REQUIRED');
 if(current.refund_dispute_pending===1)throw Error('REFUND_DISPUTE_PENDING');
 if(current.converted_atoms>0)throw Error('ALREADY_PARTIALLY_CONVERTED');
 if(refundDeadlineMs<current.recorded_at_ms)throw Error('REFUND_DEADLINE_BEFORE_PURCHASE');
 if(current.refund_deadline_ms!==null&&refundDeadlineMs<current.refund_deadline_ms)
  throw Error('REFUND_DEADLINE_SHORTENING_FORBIDDEN');
 const projection=await readPurchasedTlAttribution(db,userId);
 const matched=projection.lots.find(l=>l.paymentKey===paymentKey);
 if(!matched)throw Error('PURCHASE_LOT_ATTRIBUTION_MISSING');
 const remaining=matched.remainingPurchasedAtoms;
 const updates=[
  db.prepare(
   "UPDATE v5_purchased_tl_lots SET refund_deadline_ms=?,remaining_purchased_atoms=?,"+
   "consumer_rights_cleared=1,legal_review_approved=1,conversion_status='reviewed' "+
   "WHERE payment_key=? AND user_id=? AND payment_mode='live' AND converted_atoms=0 "+
   "AND refund_dispute_pending=0 AND (refund_deadline_ms IS NULL OR refund_deadline_ms<=?)"
  ).bind(refundDeadlineMs,remaining,paymentKey,userId,refundDeadlineMs),
  checkGuard(db),
  db.prepare(
   'INSERT INTO v5_purchased_tl_review_audit '+
   '(payment_key,user_id,reviewer_id,country,legal_basis,evidence_sha256,review_note,'+
   'refund_deadline_ms,reviewed_remaining_atoms) VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(paymentKey,userId,reviewerId,country,input.legalBasis.trim(),
   input.evidenceSha256,input.reviewNote.trim(),refundDeadlineMs,remaining)
 ];
 await db.batch(updates);
 return {reviewed:true,paymentKey,userId,refundDeadlineMs,
  remainingPurchasedAtoms:remaining,actorUserId:reviewerId,
  note:'No TL balance was converted by this approval.'};
}

/**
 * Deliberate admin action only. Not scheduled or automatically enabled.
 * Never convert creator royalties, test credits, or a purchase currently in a
 * song's pool. Old balances must first have complete proof and legal review.
 */
export async function settleReviewedPurchasedTlMaturity(db:D1Database,input:{
 userId:string;paymentKey:string;expectedRemainingAtoms:number;
 nowMs?:number;adminId:number;
}){
 if(!validUser(input.userId)||!validKey(input.paymentKey)||
    !Number.isSafeInteger(input.adminId)||input.adminId<0||
    !Number.isSafeInteger(input.expectedRemainingAtoms)||input.expectedRemainingAtoms<=0)
  throw Error('INVALID_PURCHASE_MATURITY_REQUEST');
 const nowMs=input.nowMs??Date.now();
 await assertTLAtomScale(db);
 await ensurePurchasedTlReviewSchema(db);
 const preview=await previewPurchasedTlMaturity(db,input.userId,input.paymentKey,nowMs);
 if(!preview.eligible)throw Error('PURCHASE_MATURITY_NOT_ELIGIBLE:'+preview.decision);
 if(preview.remainingPurchasedAtoms!==input.expectedRemainingAtoms)
  throw Error('PURCHASE_MATURITY_QUOTE_CHANGED');
 if(preview.remainingPurchasedAtoms>10000000000)
  throw Error('PURCHASE_MATURITY_REQUIRES_BATCH_REVIEW');
 const lot=await storedLot(db,input.userId,input.paymentKey);
 const approved=await db.prepare(
  'SELECT evidence_sha256,refund_deadline_ms,reviewed_remaining_atoms,reviewer_id FROM '+
  'v5_purchased_tl_review_audit WHERE payment_key=? AND user_id=? ORDER BY id DESC LIMIT 1'
 ).bind(input.paymentKey,input.userId).first<{
  evidence_sha256:string;refund_deadline_ms:number;reviewed_remaining_atoms:number;reviewer_id:number;
 }>();
 if(!approved||approved.refund_deadline_ms!==lot.refund_deadline_ms||
    approved.reviewed_remaining_atoms!==preview.remainingPurchasedAtoms)
  throw Error('PURCHASE_MATURITY_REVIEW_NOT_VERIFIED');
 const projection=await readPurchasedTlAttribution(db,input.userId);
 const wallet=projection.accounts.find(a=>a.bucket==='wallet_paid');
 const atoms=preview.walletPurchasedAtoms;
 if(!wallet||wallet.held_atoms!==0||wallet.available_atoms<atoms||atoms<=0)
  throw Error('PURCHASE_MATURITY_WALLET_LOCKED');
 const bonus=await ensureLedgerAccount(db,'user',input.userId,'TL','wallet_bonus');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(input.paymentKey)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const key='v5-purchased-maturity:'+digest;
 const guarded=[
  db.prepare(
   "UPDATE v5_purchased_tl_lots SET remaining_purchased_atoms=0,"+
   "converted_atoms=converted_atoms+?,conversion_status='converted' "+
   "WHERE payment_key=? AND user_id=? AND payment_mode='live' AND "+
   "consumer_rights_cleared=1 AND legal_review_approved=1 AND refund_dispute_pending=0 "+
   "AND refund_deadline_ms<=? AND remaining_purchased_atoms=? AND converted_atoms=?"
  ).bind(atoms,input.paymentKey,input.userId,nowMs,atoms,lot.converted_atoms),
  checkGuard(db),
  // This check occurs AFTER the main ledger debit in the same D1 batch.
  // A concurrent wallet transaction changes version and forces rollback.
  db.prepare(
   'UPDATE v3_economy_balances SET version=version '+
   'WHERE account_id=? AND version=? AND available_atoms=?'
  ).bind(wallet.id,wallet.version+1,wallet.available_atoms-atoms),
  checkGuard(db)
 ];
 const posted=await postLedgerTransaction(db,{
  idempotencyKey:key,
  transactionType:'v5_purchase_maturity',
  source:'verified_purchase_refund_expiry',referenceType:'payment_lot',
  referenceId:input.paymentKey,actorUserId:input.userId,
  description:'법정 환불권 종료 확인 구매 TL_P 미사용분 TL_B 전환',
  metadata:{purchase_lot:input.paymentKey,amount_atoms:atoms,review_sha256:approved.evidence_sha256,
   refund_deadline_ms:lot.refund_deadline_ms,reviewed_by_admin_user_id:approved.reviewer_id,
   executed_by_admin_user_id:input.adminId||null,execution_mode:input.adminId===0?'scheduled':'admin',
   source_policy:'PURCHASED_FIRST_FIFO'},
  lines:[
   {accountId:wallet.id,assetCode:'TL',amountAtoms:-atoms},
   {accountId:bonus,assetCode:'TL',amountAtoms:atoms}
  ],
  atomicStatements:guarded
 });
 return {converted:!posted.replayed,replayed:posted.replayed,
  paymentKey:input.paymentKey,convertedAtoms:posted.replayed?0:atoms,
  remainingPurchasedAtoms:0,transactionId:posted.id};
}

/**
 * Opt-in scheduled executor. Every due purchase lot must already have a
 * human administrator's documented legal review. Never auto-approve a
 * deadline, assign a refund policy, or convert unidentified legacy cash.
 * Work is bounded; unavailable/held/actively playing lots are skipped.
 */
export async function runReviewedPurchasedTlMaturityCycle(db:D1Database,nowMs=Date.now(),maxConversions=10){
 if(!Number.isSafeInteger(nowMs)||nowMs<=0||
    !Number.isSafeInteger(maxConversions)||maxConversions<1||maxConversions>10)
  throw Error('INVALID_MATURITY_CYCLE_CONFIGURATION');
 await ensurePurchasedTlReviewSchema(db);
 await db.prepare(
  "CREATE TABLE IF NOT EXISTS v5_purchased_tl_maturity_scan_cursor ("+
  "singleton INTEGER PRIMARY KEY CHECK(singleton=1),"+
  "refund_deadline_ms INTEGER NOT NULL DEFAULT 0,payment_key TEXT NOT NULL DEFAULT '',"+
  "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
 ).run();
 await db.prepare(
  "INSERT OR IGNORE INTO v5_purchased_tl_maturity_scan_cursor "+
  "(singleton,refund_deadline_ms,payment_key) VALUES(1,0,'')"
 ).run();
 const cursor=await db.prepare(
  "SELECT refund_deadline_ms,payment_key FROM v5_purchased_tl_maturity_scan_cursor WHERE singleton=1"
 ).first<{refund_deadline_ms:number;payment_key:string}>();
 if(!cursor)throw Error('MATURITY_SCAN_CURSOR_UNAVAILABLE');
 const scan=async(deadline:number,key:string)=>await db.prepare(
  'SELECT payment_key,user_id,refund_deadline_ms FROM v5_purchased_tl_lots '+
  "WHERE payment_mode='live' AND legal_review_approved=1 AND consumer_rights_cleared=1 "+
  "AND refund_dispute_pending=0 AND conversion_status='reviewed' AND converted_atoms=0 "+
  'AND refund_deadline_ms IS NOT NULL AND refund_deadline_ms<=? '+
  'AND (refund_deadline_ms>? OR (refund_deadline_ms=? AND payment_key>?)) '+
  'ORDER BY refund_deadline_ms,payment_key LIMIT 40'
 ).bind(nowMs,deadline,deadline,key).all<{
  payment_key:string;user_id:string;refund_deadline_ms:number;
 }>();
 let candidates=(await scan(Number(cursor.refund_deadline_ms),String(cursor.payment_key))).results||[];
 let wrapped=false;
 if(!candidates.length&&Number(cursor.refund_deadline_ms)>0){
  // Complete one traversal, then return to overdue items for re-review.
  // A permanently blocked early candidate must never starve later purchases.
  wrapped=true;
  candidates=(await scan(0,'')).results||[];
 }
 let converted=0,convertedAtoms=0,skipped=0,scanned=0;
 let lastProcessed:{refund_deadline_ms:number;payment_key:string}|null=null;
 for(const row of candidates){
  if(converted>=maxConversions)break;
  scanned++;
  lastProcessed={refund_deadline_ms:row.refund_deadline_ms,payment_key:row.payment_key};
  try{
   const preview=await previewPurchasedTlMaturity(db,row.user_id,row.payment_key,nowMs);
   if(!preview.eligible||preview.remainingPurchasedAtoms<=0){skipped++;continue;}
   const result=await settleReviewedPurchasedTlMaturity(db,{
    userId:row.user_id,paymentKey:row.payment_key,expectedRemainingAtoms:preview.remainingPurchasedAtoms,
    nowMs,adminId:0
   });
   if(result.converted){converted++;convertedAtoms+=result.convertedAtoms;}
  }catch(e){
   skipped++;
   console.warn('[TLP_MATURITY_AUTO_SKIPPED]',e instanceof Error?e.message:'MATURITY_UNAVAILABLE');
  }
 }
 if(lastProcessed){
  await db.prepare(
   "UPDATE v5_purchased_tl_maturity_scan_cursor "+
   "SET refund_deadline_ms=?,payment_key=?,updated_at=CURRENT_TIMESTAMP WHERE singleton=1"
  ).bind(lastProcessed.refund_deadline_ms,lastProcessed.payment_key).run();
 }else if(wrapped){
  await db.prepare(
   "UPDATE v5_purchased_tl_maturity_scan_cursor "+
   "SET refund_deadline_ms=0,payment_key='',updated_at=CURRENT_TIMESTAMP WHERE singleton=1"
  ).run();
 }
 return {scanned,converted,convertedAtoms,skipped,wrapped,
  capped:scanned===40,sourcePolicy:'PURCHASED_FIRST_FIFO',mode:'preapproved_only'};
}
