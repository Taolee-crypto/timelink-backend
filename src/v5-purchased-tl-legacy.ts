import {ensurePurchasedTlLotSchema} from './v5-purchased-tl-lifecycle';
import {ensurePurchasedTlReviewSchema} from './v5-purchased-tl-conversion';

type LegacyReceipt={
 id:number;user_id:string;method:string;pg_id:string;merchant_uid:string;
 amount_krw:number;tl_granted:number;bonus_tl:number;status:string;created_at:string;
};
type LegacyTx={
 id:string;idempotency_key:string;source:string;transaction_type:string;
 reference_type:string;reference_id:string;actor_user_id:string;
 metadata_json:string;created_at:string;status:string;
};
type LegacyLine={bucket:string;owner_type:string;owner_id:string;asset_code:string;amount_atoms:number};
export interface LegacyPurchaseCandidate {
 paymentKey:string;userId:string;transactionId:string;receiptId:number;
 method:string;paymentId:string;orderId:string;paidAtoms:number;bonusAtoms:number;
 paymentMode:'test'|'unknown';recordedAtMs:number;eligible:boolean;
 reason:string;evidenceSha256:string;
}
const KEY_PATTERN=/^v5-payment:[A-Za-z0-9:_-]{1,160}$/;
const idPattern=/^[0-9]{1,15}$/;
const atoms=(number:number)=>Math.round(number*10000);
function millisUtc(value:string):number {
 if(!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value))throw Error('LEGACY_PURCHASE_TIME_UNVERIFIED');
 const timestamp=Date.parse(value.replace(' ','T')+'Z');
 if(!Number.isSafeInteger(timestamp)||timestamp<=0)throw Error('LEGACY_PURCHASE_TIME_UNVERIFIED');
 return timestamp;
}
function positiveInteger(number:number){
 return Number.isSafeInteger(number)&&number>0;
}
async function digest(value:string):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function ensureLegacyPurchasedTlAuditSchema(db:D1Database){
 await ensurePurchasedTlReviewSchema(db);
 await db.prepare(
  'CREATE TABLE IF NOT EXISTS v5_purchased_tl_legacy_import_audit ('+
  'id INTEGER PRIMARY KEY AUTOINCREMENT,payment_key TEXT NOT NULL UNIQUE,'+
  'transaction_id TEXT NOT NULL,receipt_id INTEGER NOT NULL,'+
  'imported_by_admin INTEGER NOT NULL,evidence_sha256 TEXT NOT NULL,'+
  'verified_payment_mode TEXT NOT NULL CHECK(verified_payment_mode IN (\'test\',\'unknown\')),'+
  'note TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
 ).run();
}

/** Inspect one historical source payment without modifying wallet balances. */
export async function inspectLegacyPurchasedTl(db:D1Database,paymentKey:string):Promise<LegacyPurchaseCandidate>{
 if(!KEY_PATTERN.test(paymentKey))throw Error('LEGACY_PURCHASE_KEY_INVALID');
 await ensurePurchasedTlLotSchema(db);
 const existing=await db.prepare(
  'SELECT payment_key FROM v5_purchased_tl_lots WHERE payment_key=?'
 ).bind(paymentKey).first();
 if(existing)throw Error('LEGACY_PURCHASE_ALREADY_IMPORTED');
 const tx=await db.prepare(
  'SELECT id,idempotency_key,source,transaction_type,reference_type,reference_id,'+
  'actor_user_id,metadata_json,created_at,status FROM v3_economy_transactions '+
  "WHERE idempotency_key=? AND transaction_type='payment_credit' AND status='posted'"
 ).bind(paymentKey).first<LegacyTx>();
 if(!tx||tx.reference_type!=='payment'||!idPattern.test(tx.actor_user_id))
  throw Error('LEGACY_PURCHASE_POSTED_PAYMENT_MISSING');
 const prefix='v5-payment:',sourcePrefix='pg:';
 if(!tx.source.startsWith(sourcePrefix)||paymentKey!==prefix+tx.source.slice(3)+':'+tx.reference_id)
  throw Error('LEGACY_PURCHASE_PROVIDER_MISMATCH');
 const method=tx.source.slice(3),paymentId=tx.reference_id;
 if(!/^[A-Za-z0-9_-]{1,60}$/.test(method)||!paymentId||paymentId.length>120)
  throw Error('LEGACY_PURCHASE_PROVIDER_MISMATCH');
 const receipts=await db.prepare(
  'SELECT id,user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,bonus_tl,status,created_at '+
  'FROM tl_payments WHERE method=? AND pg_id=? LIMIT 2'
 ).bind(method,paymentId).all<LegacyReceipt>();
 if(receipts.results?.length!==1)throw Error('LEGACY_PURCHASE_RECEIPT_MISSING_OR_DUPLICATE');
 const receipt=receipts.results[0];
 let meta:any;
 try{meta=JSON.parse(tx.metadata_json||'{}')}catch{throw Error('LEGACY_PURCHASE_METADATA_INVALID')}
 if(!meta||typeof meta!=='object'||Array.isArray(meta))throw Error('LEGACY_PURCHASE_METADATA_INVALID');
 const paid=Number(meta.paid_tl),bonus=Number(meta.bonus_tl);
 if(!Number.isSafeInteger(paid)||paid<=0||!Number.isSafeInteger(bonus)||bonus<0||
    !Number.isSafeInteger(atoms(paid))||!Number.isSafeInteger(atoms(bonus)))
  throw Error('LEGACY_PURCHASE_AMOUNT_INVALID');
 if(receipt.status!=='success'||receipt.user_id!==tx.actor_user_id||
   receipt.method!==method||receipt.pg_id!==paymentId||
   receipt.merchant_uid!==meta.order_id||String(meta.user_id)!==tx.actor_user_id||
   receipt.amount_krw!==paid||receipt.tl_granted!==paid+bonus||Number(receipt.bonus_tl||0)!==bonus)
  throw Error('LEGACY_PURCHASE_RECEIPT_MISMATCH');
 const entries=await db.prepare(
  'SELECT a.bucket,a.owner_type,a.owner_id,e.asset_code,e.amount_atoms '+
  'FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id '+
  'WHERE e.transaction_id=? ORDER BY e.id'
 ).bind(tx.id).all<LegacyLine>();
 const lines=entries.results||[];
 if(lines.length!==(bonus>0?3:2)||lines.some(x=>x.asset_code!=='TL'))
  throw Error('LEGACY_PURCHASE_LEDGER_SHAPE');
 const matching=(bucket:string,ownerType:string,ownerId:string,amount:number)=>
  lines.filter(e=>e.bucket===bucket&&e.owner_type===ownerType&&
    e.owner_id===ownerId&&e.amount_atoms===amount).length===1;
 if(!matching('wallet_paid','user',tx.actor_user_id,atoms(paid))||
    !matching('verified_payment_issuance','system',tx.source,-atoms(paid+bonus))||
    (bonus>0&&!matching('wallet_bonus','user',tx.actor_user_id,atoms(bonus))))
  throw Error('LEGACY_PURCHASE_LEDGER_MISMATCH');
 const recordedAtMs=millisUtc(tx.created_at);
 // A historical receipt's missing 'payment_mode' is NOT evidence of a live
 // payment. Import unresolved transactions as unknown, never as redeemable.
 const paymentMode=meta.payment_mode==='test'?'test':'unknown';
 const proof=JSON.stringify({
  transactionId:tx.id,paymentKey,receiptId:receipt.id,
  userId:tx.actor_user_id,method,paymentId,orderId:receipt.merchant_uid,
  paidAtoms:atoms(paid),bonusAtoms:atoms(bonus),mode:paymentMode,
  recordedAtMs,lines:lines.map(e=>[e.owner_type,e.owner_id,e.bucket,e.amount_atoms])
 });
 return {
  paymentKey,userId:tx.actor_user_id,transactionId:tx.id,receiptId:receipt.id,
  method,paymentId,orderId:receipt.merchant_uid,paidAtoms:atoms(paid),
  bonusAtoms:atoms(bonus),paymentMode,recordedAtMs,eligible:true,
  reason:'RECEIPT_LEDGER_MATCHED_PAYMENT_MODE_UNVERIFIED',
  evidenceSha256:await digest(proof)
 };
}
export async function listLegacyPurchasedTlCandidates(db:D1Database,limit=20){
 if(!Number.isSafeInteger(limit)||limit<1||limit>50)
  throw Error('LEGACY_PURCHASE_LIMIT_INVALID');
 await ensurePurchasedTlLotSchema(db);
 const rows=await db.prepare(
  'SELECT t.idempotency_key AS payment_key FROM v3_economy_transactions t '+
  'LEFT JOIN v5_purchased_tl_lots l ON l.payment_key=t.idempotency_key '+
  "WHERE t.transaction_type='payment_credit' AND t.status='posted' "+
  "AND t.idempotency_key LIKE 'v5-payment:%' AND l.payment_key IS NULL "+
  'ORDER BY t.created_at ASC,t.id ASC LIMIT ?'
 ).bind(limit).all<{payment_key:string}>();
 const candidates=[];
 for(const row of rows.results||[]){
  try{candidates.push(await inspectLegacyPurchasedTl(db,row.payment_key))}
  catch(error){candidates.push({paymentKey:row.payment_key,eligible:false,
    reason:error instanceof Error?error.message:'LEGACY_PURCHASE_UNVERIFIED'})}
 }
 return {candidates,scanned:candidates.length,imported:0,note:'Read-only until explicit administrator import; NEVER upgrades unknown to live.'};
}

/** Explicitly approved metadata-only migration: no TL is created or moved. */
export async function importLegacyPurchasedTl(db:D1Database,input:{
  paymentKey:string;reviewerId:number;evidenceSha256:string;note:string;
}){
 if(!Number.isSafeInteger(input.reviewerId)||input.reviewerId<=0||
   !/^[a-f0-9]{64}$/.test(input.evidenceSha256)||
   input.note.trim().length<20||input.note.length>1000)
  throw Error('LEGACY_PURCHASE_IMPORT_APPROVAL_INVALID');
 await ensureLegacyPurchasedTlAuditSchema(db);
 const item=await inspectLegacyPurchasedTl(db,input.paymentKey);
 if(item.evidenceSha256!==input.evidenceSha256)
  throw Error('LEGACY_PURCHASE_PROOF_CHANGED');
 // The statement rereads the original receipt and verified ledger, with a
 // conditional INSERT. The double-entry journal and all wallet balances
 // remain immutable. A failed guard rolls the entire batch back.
 const insert=db.prepare(
  'INSERT INTO v5_purchased_tl_lots '+
  '(payment_key,user_id,method,payment_id,order_id,paid_atoms,bonus_atoms,payment_mode,recorded_at_ms) '+
  'SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS ('+
  'SELECT 1 FROM v3_economy_transactions t JOIN tl_payments p '+
  'ON p.method=? AND p.pg_id=t.reference_id AND p.user_id=t.actor_user_id '+
  'WHERE t.id=? AND t.idempotency_key=? AND t.status=\'posted\' '+
  'AND t.transaction_type=\'payment_credit\' AND p.id=? AND p.status=\'success\' '+
  'AND p.tl_granted=? AND p.bonus_tl=? AND p.merchant_uid=?'+
  ') AND (SELECT COUNT(*) FROM v3_economy_entries WHERE transaction_id=?)=?'
 ).bind(
  item.paymentKey,item.userId,item.method,item.paymentId,item.orderId,
  item.paidAtoms,item.bonusAtoms,item.paymentMode,item.recordedAtMs,
  item.method,item.transactionId,item.paymentKey,item.receiptId,
  (item.paidAtoms+item.bonusAtoms)/10000,item.bonusAtoms/10000,item.orderId,
  item.transactionId,item.bonusAtoms>0?3:2
 );
 const guard=db.prepare(
  "INSERT INTO v5_purchased_tl_conversion_guard(singleton,ok) VALUES(1,changes()) "+
  "ON CONFLICT(singleton) DO UPDATE SET ok=excluded.ok"
 );
 const audit=db.prepare(
  'INSERT INTO v5_purchased_tl_legacy_import_audit '+
  '(payment_key,transaction_id,receipt_id,imported_by_admin,evidence_sha256,verified_payment_mode,note) '+
  'VALUES(?,?,?,?,?,?,?)'
 ).bind(item.paymentKey,item.transactionId,item.receiptId,input.reviewerId,
  item.evidenceSha256,item.paymentMode,input.note.trim());
 await db.batch([insert,guard,audit]);
 return {imported:true,paymentKey:item.paymentKey,paymentMode:item.paymentMode,
   paidAtoms:item.paidAtoms,bonusAtoms:item.bonusAtoms,conversionEligible:false,
   ledgerBalancesChanged:false,evidenceSha256:item.evidenceSha256};
}
