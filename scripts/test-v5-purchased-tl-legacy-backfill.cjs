'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-paid-tl-lots-'));
const out=path.join(temp,'entry.cjs');
buildSync({stdin:{contents:"export * from './src/v5-payment-ledger';export * from './src/v5-purchased-tl-lifecycle';export * from './src/economy-ledger';export * from './src/v5-purchased-tl-legacy';export * from './src/v5-purchased-tl-attribution';export * from './src/v5-purchased-tl-conversion';export {default as maturityAdmin} from './src/routes/admin-v5-purchased-tl';export {makeAccessToken} from './src/auth';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
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
 await api.ensurePurchasedTlLotSchema(db);
 const user='11';
 async function legacyReceipt({id,mode=null,paidTL=100,bonusTL=15,order='order-'+id}){
  const method='toss',key='v5-payment:toss:'+id;
  const source=await api.ensureLedgerAccount(db,'system','pg:toss','TL','verified_payment_issuance');
  const paid=await api.ensureLedgerAccount(db,'user',user,'TL','wallet_paid');
  const bonus=await api.ensureLedgerAccount(db,'user',user,'TL','wallet_bonus');
  const total=(paidTL+bonusTL)*10000;
  const result=await api.postLedgerTransaction(db,{
   idempotencyKey:key,transactionType:'payment_credit',source:'pg:toss',
   referenceType:'payment',referenceId:id,actorUserId:user,
   description:'legacy verified credit fixture',
   metadata:{user_id:user,order_id:order,paid_tl:paidTL,bonus_tl:bonusTL,...(mode?{payment_mode:mode}:{})},
   lines:[{accountId:source,assetCode:'TL',amountAtoms:-total},
    {accountId:paid,assetCode:'TL',amountAtoms:paidTL*10000},
    ...(bonusTL?[{accountId:bonus,assetCode:'TL',amountAtoms:bonusTL*10000}]:[])],
   issuanceStatements:[db.prepare('UPDATE v3_economy_balances SET available_atoms=available_atoms+? WHERE account_id=?').bind(total,source)],
   atomicStatements:[db.prepare("INSERT INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,bonus_tl,status) VALUES(?,?,?,?,?,?,?,'success')")
    .bind(user,method,id,order,paidTL,paidTL+bonusTL,bonusTL)]
  });
  assert.equal(result.replayed,false);
  return key;
 }
 const unknown=await legacyReceipt({id:'historic-01'});
 const oldTest=await legacyReceipt({id:'historic-02',mode:'test',paidTL:20,bonusTL:0});
 const paidBefore=await balance(11,'wallet_paid');
 const bonusBefore=await balance(11,'wallet_bonus');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_purchased_tl_lots').get().n,0);
 const listed=await api.listLegacyPurchasedTlCandidates(db,20);
 assert.equal(listed.scanned,2);
 assert.equal(listed.imported,0);
 assert.equal(listed.candidates.every(x=>x.eligible===true),true);
 const inspected=await api.inspectLegacyPurchasedTl(db,unknown);
 assert.equal(inspected.paymentMode,'unknown','old receipt without explicit payment mode must not become live');
 assert.equal(inspected.paidAtoms,1000000);
 assert.equal(inspected.bonusAtoms,150000);
 assert.equal(inspected.evidenceSha256.length,64);
 await assert.rejects(api.importLegacyPurchasedTl(db,{
   paymentKey:unknown,reviewerId:99,evidenceSha256:'f'.repeat(64),
   note:'Verified audit fixture old purchase evidence is intentionally incorrect'
 }),/PROOF_CHANGED/);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_purchased_tl_lots').get().n,0);
 const input={paymentKey:unknown,reviewerId:99,evidenceSha256:inspected.evidenceSha256,
  note:'Audited matching historical receipt and immutable ledger journal before import'};
 const imported=await api.importLegacyPurchasedTl(db,input);
 assert.equal(imported.imported,true);
 assert.equal(imported.conversionEligible,false);
 assert.equal(imported.paymentMode,'unknown');
 assert.equal(imported.ledgerBalancesChanged,false);
 assert.equal(await balance(11,'wallet_paid'),paidBefore);
 assert.equal(await balance(11,'wallet_bonus'),bonusBefore);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_purchased_tl_lots').get().n,1);
 const lot=sql.prepare('SELECT * FROM v5_purchased_tl_lots WHERE payment_key=?').get(unknown);
 assert.equal(lot.payment_mode,'unknown');
 assert.equal(lot.legal_review_approved,0);
 assert.equal(lot.remaining_purchased_atoms,null);
 assert.equal(lot.refund_deadline_ms,null);
 assert.equal(lot.converted_atoms,0);
 const audit=sql.prepare('SELECT * FROM v5_purchased_tl_legacy_import_audit WHERE payment_key=?').get(unknown);
 assert.equal(audit.imported_by_admin,99);
 assert.equal(audit.evidence_sha256,inspected.evidenceSha256);
 await assert.rejects(api.importLegacyPurchasedTl(db,input),/ALREADY_IMPORTED/);
 await assert.rejects(api.reviewPurchasedTlMaturity(db,{
  userId:user,paymentKey:unknown,reviewerId:99,refundDeadlineMs:Date.now()+86400000,
  country:'KR',legalBasis:'All applicable refund rights under review for legacy unknown mode',
  evidenceSha256:'a'.repeat(64),reviewNote:'A real payment verification has not been performed yet'
 }),/LIVE_PURCHASE_REQUIRED/);
 const testProof=await api.inspectLegacyPurchasedTl(db,oldTest);
 assert.equal(testProof.paymentMode,'test');
 await api.importLegacyPurchasedTl(db,{
  paymentKey:oldTest,reviewerId:99,evidenceSha256:testProof.evidenceSha256,
  note:'Confirmed historical test receipt against original double-entry journal'
 });
 assert.equal(sql.prepare('SELECT payment_mode FROM v5_purchased_tl_lots WHERE payment_key=?').get(oldTest).payment_mode,'test');
 assert.equal(await balance(11,'wallet_paid'),paidBefore);
 assert.equal(await balance(11,'wallet_bonus'),bonusBefore);
 assert.equal((await api.readPurchasedTlAttribution(db,user)).lots.length,2,'two historical payment entries can now be reconciled');
 const listAfter=await api.listLegacyPurchasedTlCandidates(db);
 assert.equal(listAfter.scanned,0);
 const invalid=await legacyReceipt({id:'historic-corrupt-03',paidTL:30,bonusTL:3});
 sql.prepare('UPDATE tl_payments SET tl_granted=99999 WHERE pg_id=?').run('historic-corrupt-03');
 await assert.rejects(api.inspectLegacyPurchasedTl(db,invalid),/RECEIPT_MISMATCH/);
 assert.equal((await api.listLegacyPurchasedTlCandidates(db)).candidates[0].eligible,false);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_purchased_tl_lots').get().n,2);

 // HTTP actions require administrator role and an explicit audited import.
 sql.prepare("INSERT INTO users(id,role,is_active) VALUES(99,'admin',1)").run();
 const jwtSecret='backfill-fixture-admin-secret';
 const token=await api.makeAccessToken(99,jwtSecret);
 const baseUrl='https://fixture';
 let response=await api.maturityAdmin.fetch(new Request(baseUrl+'/legacy-candidates'),{DB:db,JWT_SECRET:jwtSecret});
 assert.equal(response.status,403,'anonymous legacy payments must remain inaccessible');
 response=await api.maturityAdmin.fetch(new Request(baseUrl+'/legacy-candidates',{headers:{Authorization:'Bearer '+token}}),{DB:db,JWT_SECRET:jwtSecret});
 assert.equal(response.status,200);
 response=await api.maturityAdmin.fetch(new Request(baseUrl+'/legacy-import/'+encodeURIComponent(invalid),{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({evidence_sha256:'0'.repeat(64),review_note:'Unverified data import is forbidden'})
 }),{DB:db,JWT_SECRET:jwtSecret});
 assert.equal(response.status,400,'import requires explicit admin confirmation');
 console.log('PASS legacy TL_P purchase backfill: ledger/receipt parity, original timestamps, unknown/test preserved, no TL mint, replay idempotency, admin auth, invalid receipts refused');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
