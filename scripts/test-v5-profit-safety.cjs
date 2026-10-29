'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-profit-safety-'));
let sqlite;
async function test(){
 try{
  buildSync({stdin:{contents:"export * from './src/v5-profit-safety';export {default as router} from './src/routes/admin';export {makeAccessToken} from './src/auth';",loader:'ts',resolveDir:process.cwd()},
   outfile:path.join(dir,'test.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const x=require(path.join(dir,'test.cjs'));
  assert.equal(x.DEFAULT_PROFIT_SAFETY_LIMITS.min_margin_bps,1000);
  assert.throws(()=>x.validateProfitSafetyLimits({...x.DEFAULT_PROFIT_SAFETY_LIMITS,mode:'auto'}),/INVALID_PROFIT_LIMIT_KEYS/);
  assert.throws(()=>x.validateProfitSafetyLimits({...x.DEFAULT_PROFIT_SAFETY_LIMITS,min_margin_bps:-1}),/INVALID_MIN_MARGIN/);
  const base={gross_krw:100000,refund_krw:5000,pg_fees_krw:2000,rights_krw:70000,
   infrastructure_krw:4000,marketing_krw:2000,other_krw:1000,tl_b_expected_redemption_krw:1000,tlc_reserve_krw:1000};
  const limits=x.DEFAULT_PROFIT_SAFETY_LIMITS;
  const pass=x.evaluateProfitSafety(base,limits);
  assert.equal(pass.assessment,'modeled_within_limits');
  assert.equal(pass.contribution_krw,14000);
  assert.equal(pass.estimated_margin_percent,14);
  assert.equal(pass.auto_optimizer_enabled,false);
  assert.equal(pass.reward_policy_modified,false);
  assert.deepEqual(x.evaluateProfitSafety({...base,gross_krw:0},limits).assessment,'blocked');
  assert.ok(x.evaluateProfitSafety({...base,rights_krw:95000},limits).alerts.includes('MIN_MARGIN_BREACHED'));
  assert.ok(x.evaluateProfitSafety({...base,tl_b_expected_redemption_krw:40000},limits).alerts.includes('INCENTIVE_RATIO_EXCEEDED'));
  assert.ok(x.evaluateProfitSafety({...base,tlc_reserve_krw:100000001},limits).alerts.includes('INCENTIVE_CEILING_EXCEEDED'));
  assert.throws(()=>x.evaluateProfitSafety({...base,gross_krw:-1},limits),/INVALID_PROFIT_AMOUNT/);
  assert.throws(()=>x.evaluateProfitSafety({...base,verified:true},limits),/INVALID_PROFIT_SCENARIO/);
  sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0);INSERT INTO users VALUES(1,'admin',1,0),(2,'member',1,0)");
  sqlite.exec("CREATE TABLE tl_payments(id INTEGER PRIMARY KEY, amount_krw INTEGER NOT NULL);INSERT INTO tl_payments VALUES(1,10000)");
  const DB={
   prepare(q){let args=[];const obj={bind(...a){args=a;return obj},async first(){return sqlite.prepare(q).get(...args)||null},
      async all(){return {results:sqlite.prepare(q).all(...args)}},
      async run(){const r=sqlite.prepare(q).run(...args);return {meta:{changes:Number(r.changes)}}}};return obj;},
   async batch(stmts){sqlite.exec('BEGIN IMMEDIATE');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}
  };
  const env={DB,JWT_SECRET:'test-only-safety-secret',ENVIRONMENT:'test'};
  const admin=await x.makeAccessToken(1,env.JWT_SECRET),user=await x.makeAccessToken(2,env.JWT_SECRET);
  async function call(route,method='GET',payload,token=admin){
   const headers={Authorization:token?'Bearer '+token:'','Content-Type':'application/json'};
   const response=await x.router.request('https://fixture.invalid'+route,{method,headers,body:payload?JSON.stringify(payload):undefined},env);
   return {status:response.status,body:await response.json()};
  }
  assert.equal((await call('/profit-safety','GET',undefined,user)).status,403);
  assert.equal((await call('/profit-safety','GET',undefined,'')).status,403);
  let r=await call('/profit-safety');
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.auto_optimizer_enabled,false);
  assert.equal(r.body.automation_preconditions_met,false);
  assert.equal(r.body.verification.bank_settlement_verified,false);
  assert.equal(r.body.mode,'manual');
  const simulated=await call('/profit-safety/simulate','POST',{expected_version:0,scenario:base});
  assert.equal(simulated.status,200);assert.equal(simulated.body.assessment,'modeled_within_limits');
  assert.equal((await call('/profit-safety/simulate','POST',{expected_version:100,scenario:base})).status,409);
  assert.equal((await call('/profit-safety/limits','POST',{mode:'automatic',expected_version:0,limits})).status,400);
  const newLimits={...limits,min_margin_bps:2000};
  const updated=await call('/profit-safety/limits','POST',{mode:'manual',expected_version:0,limits:newLimits});
  assert.equal(updated.status,200,JSON.stringify(updated.body));assert.equal(updated.body.version,1);
  assert.equal((await call('/profit-safety/limits','POST',{mode:'manual',expected_version:0,limits})).status,409);
  assert.equal((await call('/profit-safety/limits','POST',{mode:'manual',expected_version:1,limits},user)).status,403);
  const current=await call('/profit-safety');
  assert.equal(current.body.limits.min_margin_bps,2000);
  assert.equal((await call('/profit-safety/simulate','POST',{expected_version:1,scenario:base})).body.assessment,'blocked');
  const history=await call('/profit-safety/history');
  assert.equal(history.body.history.length,1);
  assert.equal(history.body.history[0].updated_by,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM tl_payments').get().n,1);
  assert.equal(sqlite.prepare('SELECT amount_krw FROM tl_payments WHERE id=1').get().amount_krw,10000);
  assert.equal(sqlite.prepare("SELECT mode FROM v5_profit_safety_controls WHERE id=1").get().mode,'manual');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v5_admin_access_audit').get().n>5,true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM v5_reward_policy_history").get().n,0,'Risk preview does not update actual reward policy');
  console.log('PASS: admin-only/manual-only safety forecast; alerts, approval limits, optimistic concurrency, audit; no rewards or balances mutated');
 }finally{sqlite?.close();fs.rmSync(dir,{recursive:true,force:true});}
}
test().catch(e=>{console.error(e);process.exitCode=1});
