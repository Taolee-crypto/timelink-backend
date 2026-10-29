'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-paid-tl-lots-'));
const out=path.join(temp,'entry.cjs');
buildSync({stdin:{contents:"export * from './src/v5-payment-ledger';export * from './src/v5-purchased-tl-lifecycle';export * from './src/economy-ledger';export * from './src/v5-purchased-tl-attribution';export * from './src/v5-purchased-tl-conversion';export {default as maturityAdmin} from './src/routes/admin-v5-purchased-tl';export {makeAccessToken} from './src/auth';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
const api=require(out),sql=new DatabaseSync(':memory:');
sql.exec(`
CREATE TABLE v3_economy_assets(asset_code TEXT PRIMARY KEY,decimals INTEGER);
INSERT INTO v3_economy_assets VALUES('TL',4);
CREATE TABLE v3_economy_accounts(id TEXT PRIMARY KEY,owner_type TEXT,owner_id TEXT,asset_code TEXT,bucket TEXT,status TEXT DEFAULT 'active',UNIQUE(owner_type,owner_id,asset_code,bucket));
CREATE TABLE v3_economy_balances(account_id TEXT PRIMARY KEY,available_atoms INTEGER DEFAULT 0,held_atoms INTEGER DEFAULT 0,version INTEGER DEFAULT 0,updated_at TEXT);
CREATE TABLE v3_economy_transactions(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,transaction_type TEXT,source TEXT,reference_type TEXT,reference_id TEXT,actor_user_id TEXT,description TEXT,metadata_json TEXT,status TEXT NOT NULL DEFAULT 'posted');
CREATE TABLE v3_economy_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT,account_id TEXT,asset_code TEXT,amount_atoms INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE users(id INTEGER PRIMARY KEY,tl_p_lifetime INTEGER DEFAULT 0,role TEXT DEFAULT 'user',is_active INTEGER DEFAULT 1);
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

 // An additional LIVE purchase is not the same as the existing TEST lot or
 // a creator's independently earned TL_P.
 const source=await api.ensureLedgerAccount(db,'system','fixtured-live-payment','TL','verified_payment_issuance');
 await db.prepare('UPDATE v3_economy_balances SET available_atoms=1000000 WHERE account_id=?').bind(source).run();
 const paid=await api.ensureLedgerAccount(db,'user',11,'TL','wallet_paid');
 const purchaseKey='v5-payment:manual:live001';
 const recordedAt=Date.now()-5*86400000,deadline=recordedAt+2*86400000;
 const payment=await api.postLedgerTransaction(db,{
  idempotencyKey:purchaseKey,transactionType:'payment_credit',source:'pg:manual',
  referenceType:'payment',referenceId:'live001',actorUserId:'11',
  lines:[{accountId:source,assetCode:'TL',amountAtoms:-300000},
         {accountId:paid,assetCode:'TL',amountAtoms:300000}],
  atomicStatements:[api.purchasedTlLotStatement(db,{
   paymentKey:purchaseKey,userId:'11',method:'manual',paymentId:'live001',
   orderId:'fixture-live-order',paidAtoms:300000,bonusAtoms:0,
   paymentMode:'live',recordedAtMs:recordedAt
  })]
 });
 assert.equal(payment.replayed,false);
 const royalties=await api.postLedgerTransaction(db,{
  idempotencyKey:'independent-creator-royalty-001',
  transactionType:'creator_cash_royalty',source:'creator-royalty-fixture',
  referenceType:'creator',referenceId:'song-a',actorUserId:'11',
  lines:[{accountId:source,assetCode:'TL',amountAtoms:-50000},
         {accountId:paid,assetCode:'TL',amountAtoms:50000}]
 });
 assert.equal(royalties.replayed,false);
 const attribution=await api.readPurchasedTlAttribution(db,'11');
 const live=attribution.lots.find(x=>x.paymentKey===purchaseKey);
 assert.equal(live.remainingPurchasedAtoms,300000);
 assert.equal(live.walletAtoms,300000);
 assert.equal(live.pools.length,0);
 assert.equal(attribution.lots.find(x=>x.paymentKey==='v5-payment:virtual:receipt-001').remainingPurchasedAtoms,1000000);
 let preview=await api.previewPurchasedTlMaturity(db,'11',purchaseKey,deadline+1000);
 assert.equal(preview.eligible,false);
 assert.equal(preview.decision,'LEGAL_RIGHTS_REVIEW_REQUIRED');
 await assert.rejects(api.reviewPurchasedTlMaturity(db,{
  userId:'11',paymentKey:purchaseKey,reviewerId:99,refundDeadlineMs:recordedAt-1000,
  country:'KR',legalBasis:'법적 환불 및 선불 잔액 환급권 확인 근거 제시',
  evidenceSha256:'a'.repeat(64),reviewNote:'환급 가능 기간 및 잔액 귀속 심사 후 승인'
 }),/REFUND_DEADLINE_BEFORE_PURCHASE/);
 await api.reviewPurchasedTlMaturity(db,{
  userId:'11',paymentKey:purchaseKey,reviewerId:99,refundDeadlineMs:deadline,
  country:'KR',legalBasis:'거래별 법정 환불 및 선불 잔액 환급권을 각각 검토하고 확인하였음',
  evidenceSha256:'a'.repeat(64),reviewNote:'회원 권리를 검토하고 분쟁 여부를 확인한 테스트 승인'
 });
 const beforeDeadline=await api.previewPurchasedTlMaturity(db,'11',purchaseKey,deadline-1);
 assert.equal(beforeDeadline.eligible,false);
 assert.equal(beforeDeadline.decision,'REFUND_PERIOD_OPEN');
 preview=await api.previewPurchasedTlMaturity(db,'11',purchaseKey,deadline+1000);
 assert.equal(preview.eligible,true);
 assert.equal(preview.remainingPurchasedAtoms,300000);
 await assert.rejects(api.settleReviewedPurchasedTlMaturity(db,{
  userId:'11',paymentKey:purchaseKey,adminId:99,nowMs:deadline-1,expectedRemainingAtoms:300000
 }),/NOT_ELIGIBLE/);
 await assert.rejects(api.settleReviewedPurchasedTlMaturity(db,{
  userId:'11',paymentKey:purchaseKey,adminId:99,nowMs:deadline+1000,expectedRemainingAtoms:200000
 }),/QUOTE_CHANGED/);
 const paidBefore=await balance(11,'wallet_paid');
 const bonusBefore=await balance(11,'wallet_bonus');
 const conversion=await api.settleReviewedPurchasedTlMaturity(db,{
  userId:'11',paymentKey:purchaseKey,adminId:99,nowMs:deadline+1000,expectedRemainingAtoms:300000
 });
 assert.equal(conversion.converted,true);
 assert.equal(conversion.convertedAtoms,300000);
 assert.equal(await balance(11,'wallet_paid'),paidBefore-300000,'only reviewed purchase TL_P moves');
 assert.equal(await balance(11,'wallet_bonus'),bonusBefore+300000,'converted purchase TL_B is spendable, not cash');
 const converted=await api.readPurchasedTlAttribution(db,'11');
 assert.equal(converted.lots.find(x=>x.paymentKey===purchaseKey).remainingPurchasedAtoms,0);
 assert.equal(converted.lots.find(x=>x.paymentKey===purchaseKey).convertedAtoms,300000);
 assert.equal(converted.lots.find(x=>x.paymentKey==='v5-payment:virtual:receipt-001').remainingPurchasedAtoms,1000000,
  'unverified TEST lot must not be converted');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type=?').get('v5_purchase_maturity').n,1);
 assert.equal(sql.prepare('SELECT converted_atoms FROM v5_purchased_tl_lots WHERE payment_key=?').get(purchaseKey).converted_atoms,300000);
 await assert.rejects(api.settleReviewedPurchasedTlMaturity(db,{
  userId:'11',paymentKey:purchaseKey,adminId:99,nowMs:deadline+2000,expectedRemainingAtoms:300000
 }),/NOT_ELIGIBLE/);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type=?').get('v5_purchase_maturity').n,1);

 // API must forbid unauthenticated or unapproved write paths even after code deploy.
 sql.prepare("INSERT INTO users(id,role,is_active) VALUES(99,'admin',1)").run();
 const jwtSecret='fixture-admin-secret-001';
 const adminToken=await api.makeAccessToken(99,jwtSecret);
 const env={DB:db,JWT_SECRET:jwtSecret};
 const previewUrl='https://fixture/preview/11/'+encodeURIComponent(purchaseKey);
 let rr=await api.maturityAdmin.fetch(new Request(previewUrl),env);
 assert.equal(rr.status,403,'anonymous maturity preview is protected');
 rr=await api.maturityAdmin.fetch(new Request(previewUrl,{headers:{Authorization:'Bearer '+adminToken}}),env);
 assert.equal(rr.status,200,'admin can preview without mutating');
 const conversionUrl='https://fixture/convert/11/'+encodeURIComponent(purchaseKey);
 rr=await api.maturityAdmin.fetch(new Request(conversionUrl,{
  method:'POST',headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},
  body:JSON.stringify({confirmation:'CONVERT_REVIEWED_TL_P_TO_TL_B',expected_remaining_atoms:300000})
 }),env);
 assert.equal(rr.status,403,'production maturity write switch must be disabled by default');
 assert.equal((await rr.json()).error,'PURCHASE_MATURITY_DISABLED');
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM v3_economy_accounts WHERE bucket='wallet_ad'").get().n,0,
  'TL_A remains dormant and untouched');
 console.log('PASS reviewed TL_P maturity: legal hold, exact quote, atomic TL_P→TL_B, creator income excluded, no double conversion, JWT admin and safe default');

}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
