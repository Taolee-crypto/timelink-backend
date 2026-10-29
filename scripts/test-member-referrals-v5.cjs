'use strict';
// Real Hono HTTP + isolated SQLite coverage. No production users, TL or payouts.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-referral-auth-'));
let sql;
async function run(){
 try{
  buildSync({stdin:{contents:"export {default as router} from './src/routes/member-referrals-v5';export {makeAccessToken} from './src/auth';",resolveDir:process.cwd(),loader:'ts'},outfile:path.join(dir,'api.cjs'),format:'cjs',platform:'node',bundle:true,logLevel:'silent'});
  const api=require(path.join(dir,'api.cjs'));
  sql=new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0); INSERT INTO users(id) VALUES(1),(2),(3),(4),(5)");
  const DB={
   prepare(query){
    let bindings=[];const stmt={
     bind(...args){bindings=args;return stmt},
     async first(){return sql.prepare(query).get(...bindings)||null},
     async all(){return {results:sql.prepare(query).all(...bindings)}},
     async run(){const r=sql.prepare(query).run(...bindings);return {meta:{changes:Number(r.changes)}}}
    };return stmt;
   }
  };
  const env={DB,JWT_SECRET:'test-only-referrals-key'};
  const tokens={};
  for(const id of [1,2,3,4,5])tokens[id]=await api.makeAccessToken(id,env.JWT_SECRET);
  async function req(id,endpoint,method='GET',data,header){
    const options={method,headers:{Authorization:header===undefined?'Bearer '+tokens[id]:header}};
    if(data!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(data)}
    const res=await api.router.request('https://example.invalid'+endpoint,options,env);
    return {status:res.status,json:await res.json()};
  }
  assert.equal((await req(1,'/me','GET',undefined,'')).status,401);
  assert.equal((await req(1,'/me','GET',undefined,tokens[1])).status,401,'bare JWT is not Bearer');
  assert.equal((await req(1,'/me','GET',undefined,'bearer '+tokens[1])).status,200,'standard bearer case-insensitive');
  const issued=await req(1,'/code','POST',{});assert.equal(issued.status,200);
  const code=issued.json.code;assert.match(code,/^TILO-[A-F0-9]{24}$/);
  assert.equal((await req(1,'/code','POST',{})).json.code,code,'issue is idempotent');
  assert.equal((await req(1,'/claim','POST',{code})).json.code,'SELF_REFERRAL');
  assert.equal((await req(2,'/claim','POST',{code})).status,200);
  assert.equal((await req(2,'/claim','POST',{code})).json.code,'ALREADY_CLAIMED');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM v5_member_referral_claims').get().n,1);
  sql.exec('UPDATE users SET is_active=0 WHERE id=1');
  assert.equal((await req(1,'/me')).status,401,'deactivated account loses access despite signed token');
  assert.equal((await req(3,'/claim','POST',{code})).json.code,'CODE_NOT_FOUND','inactive introducer code cannot be claimed');
  sql.exec('UPDATE users SET is_active=1 WHERE id=1; UPDATE users SET account_forfeited=1 WHERE id=4');
  assert.equal((await req(4,'/claim','POST',{code})).status,401,'forfeited applicant denied');
  assert.equal((await req(5,'/claim','POST',{code})).status,200);
  const summary=await req(1,'/me');assert.equal(summary.status,200);
  assert.equal(summary.json.rewards_enabled,false);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM v5_member_referral_claims').get().n,2);
  console.log('PASS HTTP + D1-compatible SQLite: real Bearer, active referrer/applicant, anti-self/duplicate, no reward creation');
 }finally{sql?.close();fs.rmSync(dir,{recursive:true,force:true})}
}
run().catch(e=>{console.error(e);process.exitCode=1});
