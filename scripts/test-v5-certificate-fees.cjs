const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
let compiled;
try{compiled=require('esbuild').buildSync({stdin:{contents:"export * from './src/v5-certificate-fees'; export * from './src/economy-ledger';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;}
catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;const {stripTypeScriptTypes}=require('node:module');compiled=['src/creator-split-policy.ts','src/economy-ledger.ts','src/v5-certificate-fees.ts'].map(p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8').replace(/^import .*;\n/gm,''),{mode:'transform'}).replace(/export /g,'')).join('\n')+'\nmodule.exports={certificateFeeQuote,chargeCertificateFee,ensureLedgerAccount};';}
const context={module:{exports:{}},exports:null,require,crypto:globalThis.crypto,TextEncoder,CREATOR_SHARE_RATE:.7};context.exports=context.module.exports;
vm.runInNewContext(compiled,context);const {certificateFeeQuote,chargeCertificateFee,ensureLedgerAccount}=context.module.exports;
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
sqlite.exec("UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL'; CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0,tl_a REAL); INSERT INTO users(id,tl_a)VALUES(33,4000); CREATE TABLE issued(id TEXT PRIMARY KEY);");
function prepare(sql){let args=[];return{bind(...a){args=a;return this},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return{results:sqlite.prepare(sql).all(...args)}},async run(){return sqlite.prepare(sql).run(...args)},exec(){return /^\s*SELECT/i.test(sql)?sqlite.prepare(sql).all(...args):sqlite.prepare(sql).run(...args)}};}
const db={prepare,async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>s.exec());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
(async()=>{
const ad=await ensureLedgerAccount(db,'user',33,'TL','wallet_ad');
sqlite.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').run(11502142345,ad);
let q=await certificateFeeQuote(db,33);assert.equal(q.wallet.tl_total,1150214.2345);assert.equal(q.balance_after_tl,1145214.2345);
const charge=(key,fee=5000,extra=[],guards=[])=>chargeCertificateFee(db,{userId:33,feeTl:fee,kind:fee===5000?'issue':'download',reference:key,idempotencyKey:key,atomicStatements:extra,guards});
await charge('issue',5000,[prepare("INSERT INTO issued VALUES('cert')")]);
assert.equal((await certificateFeeQuote(db,33)).wallet.tl_total,1145214.2345);
assert.equal(sqlite.prepare('SELECT tl_a FROM users').get().tl_a,4000);
const before=sqlite.prepare('SELECT count(*) n FROM v3_economy_transactions').get().n;
await assert.rejects(charge('rollback',5000,[prepare("INSERT INTO issued VALUES('cert')")]));
assert.equal((await certificateFeeQuote(db,33)).wallet.tl_total,1145214.2345);
assert.equal(sqlite.prepare('SELECT count(*) n FROM v3_economy_transactions').get().n,before);
await charge('download',1000);assert.equal((await certificateFeeQuote(db,33)).wallet.tl_total,1144214.2345);
const guard=()=>prepare("SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM issued WHERE id='race') THEN 1 ELSE json_extract('invalid','$') END");
const raced=await Promise.allSettled([charge('race1',5000,[prepare("INSERT INTO issued VALUES('race')")],[guard()]),charge('race2',5000,[prepare("INSERT INTO issued VALUES('race')")],[guard()])]);
assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
assert.equal((await certificateFeeQuote(db,33)).wallet.tl_total,1139214.2345);
assert.equal(sqlite.prepare('SELECT SUM(amount_atoms) n FROM v3_economy_entries').get().n,0);
sqlite.prepare('UPDATE v3_economy_balances SET available_atoms=9999999 WHERE account_id=?').run(ad);
await assert.rejects(charge('poor'),e=>e.code==='TL_INSUFFICIENT'&&e.balance===999.9999);
console.log('PASS: V5 quote, exact issue/download debit, legacy isolation, atomic rollback, concurrent duplicate protection, balanced entries, insufficient balance');
})().catch(e=>{console.error(e);process.exitCode=1;});
