'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {buildSync}=require('esbuild'),{DatabaseSync}=require('node:sqlite');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-attribution-'));
buildSync({entryPoints:['src/v5-purchased-tl-attribution.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'module.cjs'),logLevel:'silent'});
const {replayPurchasedTlAttribution,readPurchasedTlAttribution}=require(path.join(temp,'module.cjs'));
const lots=[
 {payment_key:'v5-payment:virtual:A',user_id:'9',paid_atoms:100,converted_atoms:0,payment_mode:'live'},
 {payment_key:'v5-payment:virtual:B',user_id:'9',paid_atoms:40,converted_atoms:0,payment_mode:'live'}
];
const raw=[
 // Purchase 100: only this creates purchase-tagged cash-source TL_P.
 ['payment_credit','v5-payment:virtual:A',null,{'wallet_paid':100}],
 // Creator earns paid royalties (must remain cash-source, NOT purchase maturity).
 ['track_playback_settlement','creator-income-9',null,{'wallet_paid':70}],
 // Move 60 purchased TL_P from wallet to one song, then listen 20.
 ['track_charge','charge-9',null,{'wallet_paid':-60,'track_pool:song:paid':60}],
 ['track_playback_settlement','play-9',null,{'track_pool:song:paid':-20}],
 // Return 40 unused TL_P to its original wallet_paid bucket.
 ['v5_early_stop','v5-early-stop:session-9',null,{'track_pool:song:paid':-40,'wallet_paid':40}],
 // Spend 30 on a premium service, leaving 50 purchased / 70 royalties.
 ['premium_checkout','premium-9',null,{'wallet_paid':-30}],
 // Second purchase creates a new lot; spend oldest purchase first.
 ['payment_credit','v5-payment:virtual:B',null,{'wallet_paid':40}],
 ['creator_royalty_adjustment','creator-2',null,{'wallet_paid':5}],
 ['premium_checkout','premium-10',null,{'wallet_paid':-55}]
];
const lotRows=[...lots];
function make(rawEvents=raw,lotData=lotRows){
 let id=0,entryIndex=0;
 const entries=[];
 for(const [type,key,ref,amounts] of rawEvents){
  const transaction_id='tx-'+(++id);
  for(const [bucket,amount] of Object.entries(amounts)){
   entries.push({id:++entryIndex,transaction_id,bucket,amount_atoms:amount,transaction_type:type,idempotency_key:key,reference_id:ref});
  }
 }
 const sums=new Map();
 for(const e of entries)sums.set(e.bucket,(sums.get(e.bucket)||0)+e.amount_atoms);
 const accounts=[...sums].map(([bucket,amount],i)=>({id:'a'+(i+1),bucket,available_atoms:amount,held_atoms:0,version:1+i}));
 return {userId:'9',lots:lotData,accounts,entries};
}
const a=replayPurchasedTlAttribution(make());
assert.equal(a.rowsChecked,11);
assert.equal(a.sourcePolicy,'PURCHASED_FIRST_FIFO');
assert.equal(a.lots.length,2);
assert.equal(a.lots[0].remainingPurchasedAtoms,0);
assert.equal(a.lots[1].remainingPurchasedAtoms,35);
assert.equal(a.lots[1].walletAtoms,35);
assert.equal(a.lots[1].pools.length,0);
assert.equal(a.accounts.find(x=>x.bucket==='wallet_paid').available_atoms,110);
assert.equal(a.accounts.find(x=>x.bucket==='track_pool:song:paid').available_atoms,0);
const legacy=[...raw];
legacy.splice(1,0,['payment_credit','v5-payment:old:untracked',null,{'wallet_paid':15}]);
assert.throws(()=>replayPurchasedTlAttribution(make(legacy)),/LEGACY_PAYMENT_NOT_BACKFILLED/);
assert.throws(()=>replayPurchasedTlAttribution(make(raw,lots.map(x=>({...x,paid_atoms:x.paid_atoms+10})))),/PAYMENT_MISMATCH/);
assert.throws(()=>replayPurchasedTlAttribution({...make(),accounts:make().accounts.map(x=>({...x,available_atoms:x.available_atoms-1}))}),/UNBALANCED|DRIFT|OPENING|INVALID_CURRENT/);
const paidConversion=[
 ...raw,
 ['v5_purchase_maturity','v5-purchased-maturity:B','v5-payment:virtual:B',{'wallet_paid':-30}]
];
const convertedLots=[lots[0],{...lots[1],converted_atoms:30}];
const c=replayPurchasedTlAttribution(make(paidConversion,convertedLots));
assert.equal(c.lots[1].convertedAtoms,30);
assert.equal(c.lots[1].remainingPurchasedAtoms,5);
assert.throws(()=>replayPurchasedTlAttribution(make(paidConversion,lots)),/CONVERSION_LEDGER_MISMATCH/);
const sqlite=new DatabaseSync(':memory:');
sqlite.exec("CREATE TABLE v5_purchased_tl_lots(payment_key TEXT,user_id TEXT,paid_atoms INTEGER,converted_atoms INTEGER,payment_mode TEXT,refund_deadline_ms INTEGER,remaining_purchased_atoms INTEGER,consumer_rights_cleared INTEGER,legal_review_approved INTEGER,refund_dispute_pending INTEGER,recorded_at_ms INTEGER)");
sqlite.exec("CREATE TABLE v3_economy_accounts(id TEXT,owner_type TEXT,owner_id TEXT,asset_code TEXT,bucket TEXT)");
sqlite.exec("CREATE TABLE v3_economy_balances(account_id TEXT,available_atoms INTEGER,held_atoms INTEGER,version INTEGER)");
sqlite.exec("CREATE TABLE v3_economy_entries(id INTEGER,transaction_id TEXT,account_id TEXT,asset_code TEXT,amount_atoms INTEGER)");
sqlite.exec("CREATE TABLE v3_economy_transactions(id TEXT PRIMARY KEY,transaction_type TEXT,idempotency_key TEXT,reference_id TEXT,status TEXT)");
const fixture=make();
for(const [i,l] of fixture.lots.entries())sqlite.prepare('INSERT INTO v5_purchased_tl_lots VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(l.payment_key,l.user_id,l.paid_atoms,l.converted_atoms,l.payment_mode,null,null,0,0,0,i+1);
for(const account of fixture.accounts){
 sqlite.prepare('INSERT INTO v3_economy_accounts VALUES(?,?,?,?,?)').run(account.id,'user','9','TL',account.bucket);
 sqlite.prepare('INSERT INTO v3_economy_balances VALUES(?,?,?,?)').run(account.id,account.available_atoms,account.held_atoms,account.version);
}
const accountId=new Map(fixture.accounts.map(x=>[x.bucket,x.id]));
for(const e of fixture.entries){
 sqlite.prepare('INSERT OR IGNORE INTO v3_economy_transactions VALUES(?,?,?,?,?)').run(e.transaction_id,e.transaction_type,e.idempotency_key,e.reference_id,'posted');
 sqlite.prepare('INSERT INTO v3_economy_entries VALUES(?,?,?,?,?)').run(e.id,e.transaction_id,accountId.get(e.bucket),'TL',e.amount_atoms);
}
const db={prepare(sql){let args=[];const s={bind(...x){args=x;return s},async all(){return {results:sqlite.prepare(sql).all(...args)}}};return s;}};
readPurchasedTlAttribution(db,'9').then(x=>{
 assert.deepEqual(x.lots.map(l=>l.remainingPurchasedAtoms),[0,35]);
 console.log('PASS TL_P purchased-first FIFO, creator income isolation, paid track charge/meter/stop, old receipt safety, conversion history and SQL reconstruction');
}).catch(err=>{console.error(err);process.exitCode=1}).finally(()=>{sqlite.close();fs.rmSync(temp,{recursive:true,force:true})});
