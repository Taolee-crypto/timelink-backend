'use strict';
// Real Hono route + local SQLite. Toss provider responses are isolated fixtures.
// No real payment, bank account, live merchant key, external network or user data.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-store-payment-'));
let sqlite;
async function main(){
 try {
  buildSync({stdin:{contents:"export {default as payment} from './src/payment';export {makeAccessToken} from './src/auth';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(tmp,'routes.cjs'),logLevel:'silent'});
  const api=require(path.join(tmp,'routes.cjs'));
  sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0); INSERT INTO users(id) VALUES(1),(2);CREATE TABLE cafe_channels(channel_id TEXT PRIMARY KEY,owner_id INTEGER,status TEXT);INSERT INTO cafe_channels VALUES('cafe_0123456789abcdef',1,'active')");
  const DB={
   prepare(query){let params=[];const stmt={bind(...a){params=a;return stmt},
     async first(){return sqlite.prepare(query).get(...params)||null},
     async all(){return {results:sqlite.prepare(query).all(...params)}},
     async run(){const r=sqlite.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}
    };return stmt;
   },
   async batch(stmts){sqlite.exec('BEGIN IMMEDIATE');try{const values=[];for(const stmt of stmts)values.push(await stmt.run());sqlite.exec('COMMIT');return values}catch(e){sqlite.exec('ROLLBACK');throw e}}
  };
  const env={DB,JWT_SECRET:'store-fixture-key-only',TOSS_CLIENT_KEY:'test_ck_fixture',TOSS_SECRET_KEY:'test_sk_fixture'};
  const token1=await api.makeAccessToken(1,env.JWT_SECRET),token2=await api.makeAccessToken(2,env.JWT_SECRET);
  async function call(endpoint,body,user=token1,environment=env){
    const r=await api.payment.request('https://fixture.invalid'+endpoint,{method:'POST',
      headers:{Authorization:'Bearer '+user,'Content-Type':'application/json'},body:JSON.stringify(body)},environment);
    return {status:r.status,result:await r.json()};
  }
  const base='/v5/commercial-time',select={hours:1,period:'hour',area_tier:0};
  let r=await call(base+'/quote',select,token1,{...env,TOSS_SECRET_KEY:''});
  assert.equal(r.status,200);assert.equal(r.result.checkoutEnabled,false);
  assert.equal(r.result.checkoutMode,'disabled');
  r=await call(base+'/quote',select);
  assert.equal(r.status,200);assert.equal(r.result.checkoutEnabled,true);
  assert.equal(r.result.testCheckoutEnabled,true);assert.equal(r.result.checkoutMode,'test');
  assert.equal(r.result.entitlementGranted,false);assert.equal(r.result.amountKrw,3600);
  assert.equal((await call(base+'/quote',{hours:0,period:'hour',area_tier:0})).status,400);
  assert.equal((await call(base+'/toss/prepare',{...select,channel_id:'cafe_0123456789abcdef'},token2)).status,403);
  const prepared=await call(base+'/toss/prepare',{...select,channel_id:'cafe_0123456789abcdef'});
  assert.equal(prepared.status,200);assert.equal(prepared.result.amount,r.result.amountKrw);
  const {orderId,amount}=prepared.result;
  assert.equal((await call(base+'/toss/confirm',{orderId,amount:1000,paymentKey:'fixture-paid'})).status,403);
  const realFetch=global.fetch;
  let calls=0,forceMismatch=false;
  try{
   global.fetch=async (url,opts)=>{
    calls++;assert.equal(url,'https://api.tosspayments.com/v1/payments/confirm');
    const b=JSON.parse(opts.body);
    assert.equal(opts.headers['Idempotency-Key'],b.orderId);
    return Response.json({orderId:b.orderId,paymentKey:forceMismatch?'bogus':b.paymentKey,
      status:'DONE',totalAmount:b.amount});
   };
   let confirmed=await call(base+'/toss/confirm',{orderId,amount,paymentKey:'fixture-paid'});
   assert.equal(confirmed.status,200);assert.equal(confirmed.result.entitlementType,'store_airtime');
   assert.equal(confirmed.result.tlBCredited,false);
   assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM v5_store_airtime_grants').get().n,1);
   assert.equal(sqlite.prepare('SELECT granted_seconds AS n FROM v5_store_airtime_grants').get().n,3600);
   confirmed=await call(base+'/toss/confirm',{orderId,amount,paymentKey:'fixture-paid'});
   assert.equal(confirmed.status,200);assert.equal(confirmed.result.alreadyCompleted,true);
   assert.equal(confirmed.result.entitlementType,'store_airtime');
   assert.equal(confirmed.result.tlBCredited,false);
   assert.equal(confirmed.result.amount,amount);
   assert.equal(calls,1,'replay must not charge Toss again');
   assert.equal((await call(base+'/toss/confirm',{orderId,amount,paymentKey:'other-key'})).status,403);
   const second=await call(base+'/toss/prepare',{...select,channel_id:'cafe_0123456789abcdef'});
   forceMismatch=true;
   const failed=await call(base+'/toss/confirm',{orderId:second.result.orderId,amount,paymentKey:'unverified'});
   assert.equal(failed.status,400);
   assert.equal(sqlite.prepare("SELECT count(*) AS n FROM v5_store_airtime_grants WHERE order_id=?").get(second.result.orderId).n,0);
   assert.equal(sqlite.prepare("SELECT status FROM v5_store_airtime_orders WHERE order_id=?").get(second.result.orderId).status,'pending');
   const beforeReplay=calls;
   for(const [column,value] of [['user_id',2],['channel_id','other-store'],['granted_seconds',7200]]){
    const original=sqlite.prepare('SELECT '+column+' AS value FROM v5_store_airtime_grants WHERE order_id=?').get(orderId).value;
    sqlite.prepare('UPDATE v5_store_airtime_grants SET '+column+'=? WHERE order_id=?').run(value,orderId);
    const mismatch=await call(base+'/toss/confirm',{orderId,amount,paymentKey:'fixture-paid'});
    assert.equal(mismatch.status,503,'mismatched grant '+column+' must not claim success');
    sqlite.prepare('UPDATE v5_store_airtime_grants SET '+column+'=? WHERE order_id=?').run(original,orderId);
   }
   sqlite.prepare('UPDATE v5_store_airtime_grants SET used_seconds=3600,expires_at_ms=1 WHERE order_id=?').run(orderId);
   const consumed=await call(base+'/toss/confirm',{orderId,amount,paymentKey:'fixture-paid'});
   assert.equal(consumed.status,200,'historical paid receipt remains valid after consumption/expiry');
   assert.equal(consumed.result.seconds,3600);
   assert.deepEqual({...sqlite.prepare('SELECT used_seconds,expires_at_ms FROM v5_store_airtime_grants WHERE order_id=?').get(orderId)},{used_seconds:3600,expires_at_ms:1});
   sqlite.prepare('DELETE FROM v5_store_airtime_grants WHERE order_id=?').run(orderId);
   const missing=await call(base+'/toss/confirm',{orderId,amount,paymentKey:'fixture-paid'});
   assert.equal(missing.status,503,'paid receipt without airtime must not claim success');
   assert.equal(missing.result.error,'ENTITLEMENT_NOT_GRANTED');
   assert.equal(calls,beforeReplay,'broken local receipt must not charge the provider again');
   assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM v5_store_airtime_grants WHERE order_id=?').get(orderId).n,0,'replay must not silently recreate consumed or missing grants');
  }finally{global.fetch=realFetch}
  sqlite.exec('UPDATE users SET is_active=0 WHERE id=1');
  assert.equal((await call(base+'/quote',select)).status,401);
  console.log('PASS actual store quote/prepare/Toss sandbox proof: one pricing source, test-only, owner binding, single grant, replay-safe confirmation, denied mismatches/inactive users');
 }finally{sqlite?.close();fs.rmSync(tmp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
