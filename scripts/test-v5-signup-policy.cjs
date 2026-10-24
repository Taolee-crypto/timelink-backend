#!/usr/bin/env node
const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild'),fs=require('node:fs');
const temp=fs.mkdtempSync('/tmp/timelink-signup-');
buildSync({stdin:{contents:"export {default as worker} from './src/index';export {readV5Wallet} from './src/v5-wallet';export {readRewardPolicy} from './src/v5-reward-policy';",loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:temp+'/worker.cjs',logLevel:'silent'});
const api=require(temp+'/worker.cjs'),sql=new DatabaseSync(':memory:');
sql.exec(fs.readFileSync('migrations/0001_initial.sql','utf8'));sql.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
for(const def of ['tl REAL DEFAULT 0','tl_p REAL DEFAULT 0','tl_a REAL DEFAULT 0','tl_b REAL DEFAULT 0','tlc REAL DEFAULT 0','tl_p_lifetime REAL DEFAULT 0','tl_p_exchanged REAL DEFAULT 0','is_advertiser INTEGER DEFAULT 0','biz_reg_num TEXT','business_name TEXT','email_verified INTEGER DEFAULT 0'])sql.exec('ALTER TABLE users ADD COLUMN '+def);
sql.exec("UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';CREATE TABLE email_verifications(id INTEGER PRIMARY KEY,email TEXT,code TEXT,expires_at TEXT,created_at TEXT)");
const db={prepare(q){let a=[];const st={bind(...v){a=v;return st},async first(){return sql.prepare(q).get(...a)||null},async all(){return {results:sql.prepare(q).all(...a)}},async run(){const r=sql.prepare(q).run(...a);return {meta:{changes:Number(r.changes)}}}};return st},async batch(stmts){sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const st of stmts)results.push(await st.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}},async exec(q){sql.exec(q)}};
(async()=>{try{const p=await api.readRewardPolicy(db);p.rules.signup_bonus=1234;sql.prepare('UPDATE v5_reward_policy SET rules_json=?,updated_by=1,version=1 WHERE id=1').run(JSON.stringify(p.rules));
const routes=['/api/auth/register','/api/v1/auth/register','/api/auth/verify'];let n=0;
for(const route of routes){const email='fixture'+(++n)+'@example.test';sql.prepare("INSERT INTO email_verifications(email,code,expires_at) VALUES(?,'123456',?)").run(email,new Date(Date.now()+600000).toISOString());const body={email,username:'fixture'+n,password:'fixture-password',verify_code:'123456',code:'123456'};
const response=await api.worker.fetch(new Request('https://fixture.test'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{DB:db,JWT_SECRET:'fixture-key'},{});const d=await response.json();assert.equal(response.status,200,JSON.stringify(d));assert.equal(d.user.tl_b,1234);assert.equal(d.user.tl_p,0);assert.equal((await api.readV5Wallet(db,d.user_id)).tl_b,1234);}
assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type=\'signup_bonus\'').get().n,3);
console.log('PASS actual registration handlers: email verification, identical policy and V5 TL_B across all three API aliases');
}finally{sql.close();fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
