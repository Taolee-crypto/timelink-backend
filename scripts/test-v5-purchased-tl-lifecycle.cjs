'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-paid-tl-lots-'));
const out=path.join(temp,'entry.cjs');
buildSync({stdin:{contents:"export * from './src/v5-payment-ledger';export * from './src/v5-purchased-tl-lifecycle';export * from './src/economy-ledger';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
const api=require(out),sql=new DatabaseSync(':memory:');
sql.exec(`
CREATE TABLE v3_economy_assets(asset_code TEXT PRIMARY KEY,decimals INTEGER);
INSERT INTO v3_economy_assets VALUES('TL',4);
CREATE TABLE v3_economy_accounts(id TEXT PRIMARY KEY,owner_type TEXT,owner_id TEXT,asset_code TEXT,bucket TEXT,status TEXT DEFAULT 'active',UNIQUE(owner_type,owner_id,asset_code,bucket));
CREATE TABLE v3_economy_balances(account_id TEXT PRIMARY KEY,available_atoms INTEGER DEFAULT 0,held_atoms INTEGER DEFAULT 0,version INTEGER DEFAULT 0,updated_at TEXT);
CREATE TABLE v3_economy_transactions(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,transaction_type TEXT,source TEXT,reference_type TEXT,reference_id TEXT,actor_user_id TEXT,description TEXT,metadata_json TEXT);
CREATE TABLE v3_economy_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT,account_id TEXT,asset_code TEXT,amount_atoms INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE users(id INTEGER PRIMARY KEY,tl_p_lifetime INTEGER DEFAULT 0);
INSERT INTO users(id) VALUES (11);
CREATE TABLE tl_payments(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,method TEXT NOT NULL,pg_id TEXT NOT NULL,merchant_uid TEXT,amount_krw INTEGER NOT NULL,tl_granted INTEGER NOT NULL,bonus_tl INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
const db={prepare(q){let args=[];const statement={q,bind(...a){args=a;return statement},
 async first(){return sql.prepare(q).get(...args)||null},
 async all(){return {results:sql.prepare(q).all(...args)}},
 async run(){return sql.prepare(q).run(...args)}
 };return statement;},
 async batch(items){sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of items)results.push(await s.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}
};
const balance=async(user,bucket)=>{const id=await api.ensureLedgerAccount(db,'user',user,'TL',bucket);return Number((await db.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').bind(id).first())?.available_atoms||0);};
async function main(){
 const input={userId:'11',method:'virtual',paymentId:'receipt-001',orderId:'order-001',paidTL:100,bonusTL:15,paymentMode:'test'};
 const first=await api.creditVerifiedPayment(db,input);
 assert.equal(first.replayed,false);
 assert.equal(await balance(11,'wallet_paid'),1000000);
 assert.equal(await balance(11,'wallet_bonus'),150000);
 const lot=sql.prepare('SELECT * FROM v5_purchased_tl_lots WHERE payment_key=?').get('v5-payment:virtual:receipt-001');
 assert.equal(lot.paid_atoms,1000000);
 assert.equal(lot.bonus_atoms,150000);
 assert.equal(lot.payment_mode,'test');
 assert.equal(lot.refund_deadline_ms,null,'cannot assume seven days means no future refunds');
 assert.equal(lot.legal_review_approved,0);
 assert.equal(lot.remaining_purchased_atoms,null,'cannot guess remaining purchase amount from pooled TL_P');
 assert.equal(lot.converted_atoms,0);
 assert.equal(lot.conversion_status,'pending_legal_review');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_purchased_tl_lots').get().n,1);
 const repeated=await api.creditVerifiedPayment(db,input);
 assert.equal(repeated.replayed,true);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_purchased_tl_lots').get().n,1);
 assert.equal(await balance(11,'wallet_paid'),1000000);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM tl_payments').get().n,1);
 const eligibility=api.purchasedTlConversionDecision;
 const base={paymentMode:'live',legalReviewApproved:true,consumerRefundRightsCleared:true,
  refundDeadlineMs:1000,remainingPurchasedAtoms:25000,refundDisputePending:false,nowMs:2000};
 assert.equal(eligibility({...base,paymentMode:'test'}),'TEST_OR_UNVERIFIED_PAYMENT');
 assert.equal(eligibility({...base,legalReviewApproved:false}),'LEGAL_RIGHTS_REVIEW_REQUIRED');
 assert.equal(eligibility({...base,consumerRefundRightsCleared:false}),'LEGAL_RIGHTS_REVIEW_REQUIRED');
 assert.equal(eligibility({...base,refundDeadlineMs:null}),'LEGAL_RIGHTS_REVIEW_REQUIRED');
 assert.equal(eligibility({...base,remainingPurchasedAtoms:null}),'PURCHASE_ATTRIBUTION_REQUIRED');
 assert.equal(eligibility({...base,refundDisputePending:true}),'REFUND_DISPUTE_PENDING');
 assert.equal(eligibility({...base,nowMs:999}),'REFUND_PERIOD_OPEN');
 assert.equal(eligibility({...base,remainingPurchasedAtoms:0}),'NO_REMAINING_PURCHASED_TL');
 assert.equal(eligibility(base),'ELIGIBLE_FOR_CONTROLLED_CONVERSION');
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM v3_economy_accounts WHERE bucket='wallet_ad'").get().n,0,
  'TL_A schema remains available but no ad balance is minted by purchases');
 const poolId=await api.ensureLedgerAccount(db,'user',11,'TL','track_pool:fixture:paid');
 await db.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').bind(200000,poolId).run();
 const refund=await api.settleV5EarlyStop(db,{userId:11,shareId:'fixture',sessionId:'v5_test_stop_001',remainingAtoms:200000});
 assert.equal(refund.refundedAtoms,200000);
 assert.equal(await balance(11,'wallet_paid'),1200000,'stop reverses an internal transfer; expiry is a separate event');
 assert.equal(await balance(11,'wallet_bonus'),150000);
 console.log('PASS purchased TL_P receipt provenance, idempotency, TL_B bonus separation, TL_A dormant preservation, legal hold and stop source rule');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
