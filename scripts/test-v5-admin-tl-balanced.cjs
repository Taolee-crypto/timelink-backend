'use strict';
// Run the *real* admin /tl/adjust handler with an isolated SQLite V3 ledger.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tl-infra-adjust-'));
(async()=>{
let sqlite;
try{
 const out=path.join(dir,'admin.cjs');
 buildSync({stdin:{contents:"export {default as admin} from './src/routes/admin'; export {makeAccessToken} from './src/auth';",loader:'ts',resolveDir:process.cwd()},
   bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
 const {admin,makeAccessToken}=require(out);
 sqlite=new DatabaseSync(':memory:');
 sqlite.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
 sqlite.exec(`UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';
 CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,role TEXT,username TEXT,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0);
 INSERT INTO users(id,email,role,username) VALUES (1,'admin@example.test','admin','Admin'),(2,'owner@example.test','user','Member');`);
 const db={
  prepare(sql){let args=[];const statement={
   bind(...values){args=values;return statement},
   async first(){return sqlite.prepare(sql).get(...args)||null},
   async all(){return {results:sqlite.prepare(sql).all(...args)}},
   async run(){const meta=sqlite.prepare(sql).run(...args);return {meta:{changes:meta.changes,last_row_id:meta.lastInsertRowid}}}
  };return statement},
  async batch(stmts){sqlite.exec('BEGIN IMMEDIATE');try{const rows=[];for(const s of stmts)rows.push(await s.run());sqlite.exec('COMMIT');return rows}catch(e){sqlite.exec('ROLLBACK');throw e}}
 };
 const token=await makeAccessToken(1,'test-secret');
 const userToken=await makeAccessToken(2,'test-secret');
 const env={DB:db,JWT_SECRET:'test-secret'};
 const req=async(body,auth=token)=>admin.request('/tl/adjust',{method:'POST',
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(body)},env);
 const original={email:'owner@example.test',bucket:'tl_b',amount:150,reason:'verified manual fixture',idempotency_key:'admin-tl-fixture1234567890'};
 const unauthorized=await req(original,userToken);
 assert.equal(unauthorized.status,403);
 const first=await req(original);
 assert.equal(first.status,200,await first.text().catch(()=>''));const firstBody=await first.clone().json();
 assert.equal(firstBody.balanced,true);assert.equal(firstBody.replayed,false);
 let tx=sqlite.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').get(original.idempotency_key);
 assert.ok(tx);
 const entries=sqlite.prepare('SELECT e.amount_atoms,a.owner_type,a.bucket FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id WHERE e.transaction_id=? ORDER BY e.amount_atoms').all(tx.id);
 assert.equal(entries.length,2);
 assert.deepEqual(entries.map(x=>x.amount_atoms),[-1500000,1500000]);
 const balance=()=>sqlite.prepare("SELECT b.available_atoms FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id='2' AND a.bucket='wallet_bonus'").get()?.available_atoms;
 assert.equal(balance(),1500000);
 const replay=await req(original);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type=?').get('admin_adjustment').n,1);
 assert.equal(balance(),1500000);
 const negative={...original,amount:-60,idempotency_key:'admin-tl-fixture1234567891'};
 const debit=await req(negative);
 assert.equal(debit.status,200,await debit.text().catch(()=>''));
 assert.equal(balance(),900000);
 const overdraw=await req({...negative,amount:-9000,idempotency_key:'admin-tl-fixture1234567892'});
 assert.equal(overdraw.status,409);
 assert.equal(balance(),900000);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM (SELECT transaction_id,asset_code,SUM(amount_atoms) total FROM v3_economy_entries GROUP BY transaction_id,asset_code HAVING total<>0)").get().n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type=?').get('admin_adjustment').n,2);
 const paid=await req({...original,bucket:'tl_p',idempotency_key:'admin-tl-fixture1234567893'});
 assert.equal(paid.status,403);
 console.log('PASS infra admin TL: real signed-admin route, balanced issue/debit, replay no double credit, overdraw denied, TL_P cannot be fabricated');
}finally{sqlite?.close();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
