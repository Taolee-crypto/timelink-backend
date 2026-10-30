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
const consent={consent_terms:true,consent_privacy:true,age_14_confirmed:true,marketing:false};
for(const route of ['/api/auth/signup',...routes]){
 const invalid={email:'invalidconsent@example.test',username:'invalidconsent',password:'fixture-password',verify_code:'123456',code:'123456'};
 for(const input of [invalid,{...invalid,consent_terms:true,consent_privacy:true,age_14_confirmed:false},{...invalid,...consent,consent_privacy:'true'}]){
  const response=await api.worker.fetch(new Request('https://fixture.test'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),{DB:db,JWT_SECRET:'fixture-key'},{});const result=await response.json();
  assert.equal(response.status,400,route+': missing/forged required consent must fail');assert.equal(result.code,'SIGNUP_REQUIRED_CONSENT');
 }
}
assert.equal(sql.prepare('SELECT COUNT(*) n FROM users').get().n,0,'invalid registrations must not mint a member or TL');
for(const route of routes){const email='fixture'+(++n)+'@example.test';sql.prepare("INSERT INTO email_verifications(email,code,expires_at) VALUES(?,'123456',?)").run(email,new Date(Date.now()+600000).toISOString());const body={email,username:'fixture'+n,password:'fixture-password',verify_code:'123456',code:'123456',...consent,marketing:n===2};
const response=await api.worker.fetch(new Request('https://fixture.test'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{DB:db,JWT_SECRET:'fixture-key'},{});const d=await response.json();assert.equal(response.status,200,JSON.stringify(d));assert.equal(d.user.tl_b,1234);assert.equal(d.user.tl_p,0);assert.equal((await api.readV5Wallet(db,d.user_id)).tl_b,1234);
const audited=sql.prepare('SELECT * FROM v5_signup_consents WHERE user_id=?').get(d.user_id);
assert.ok(audited,'verified signup must record consent inside the same registration batch');
assert.equal(audited.terms_accepted,1);assert.equal(audited.privacy_accepted,1);
assert.equal(audited.age_14_confirmed,1);assert.equal(audited.marketing_accepted,n===2?1:0);
assert.equal(audited.consent_context,'v5-public-registration-20261030');
}
assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type=\'signup_bonus\'').get().n,3);
console.log('PASS actual registration handlers: all aliases reject unchecked/forged consent, verified users record mandatory and optional consent atomically with V5 TL_B');

const request=async(path,body)=>{
 const response=await api.worker.fetch(new Request('https://fixture.test'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{DB:db,JWT_SECRET:'fixture-key'},{});
 return {status:response.status,body:await response.json()};
};
const validLogin={email:'fixture1@example.test',password:'fixture-password'};
let login=await request('/api/auth/login',validLogin);
assert.equal(login.status,200,JSON.stringify(login.body));
assert.equal(typeof login.body.token,'string');
assert.ok(login.body.token.length>20,'verified login returns signed session token');
const firstUser=sql.prepare('SELECT id FROM users WHERE email=?').get(validLogin.email);
sql.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(firstUser.id);
login=await request('/api/auth/login',validLogin);
assert.equal(login.status,403);assert.equal(login.body.code,'EMAIL_VERIFICATION_REQUIRED');
sql.prepare('UPDATE users SET email_verified=1,is_active=0 WHERE id=?').run(firstUser.id);
login=await request('/api/auth/login',validLogin);
assert.equal(login.status,403);assert.equal(login.body.code,'ACCOUNT_DISABLED');
sql.prepare('UPDATE users SET is_active=1,password_hash=? WHERE id=?').run(validLogin.password,firstUser.id);
login=await request('/api/auth/login',validLogin);
assert.equal(login.status,401,'legacy plaintext comparison must not authenticate');
assert.equal(login.body.token,undefined);
sql.prepare('UPDATE users SET password_hash=? WHERE id=?').run('not-a-legacy-password',firstUser.id);
login=await request('/api/auth/login',validLogin);
assert.equal(login.status,401);

const pending='pending@example.test';
sql.prepare("INSERT INTO email_verifications(email,code,expires_at,created_at) VALUES(?,'123456',?,datetime('now'))").run(pending,new Date(Date.now()+600000).toISOString());
for(const url of ['/api/auth/resend','/api/auth/send-code','/api/auth/signup']){
 const input=url.endsWith('/signup')?{email:pending,username:'pending',password:'secure-password',...consent}:{email:pending};
 const reply=await request(url,input);
 assert.equal(reply.status,429,url+' must throttle repeated verification emails');
 assert.equal(reply.body.code,'VERIFY_CODE_RATE_LIMIT');
}
const bad=await request('/api/auth/verify',{email:pending,username:'pending',password:'secure-password',code:'123x56',...consent});
assert.equal(bad.status,400,'non-numeric code must not be accepted as valid challenge');
assert.equal(sql.prepare('SELECT COUNT(*) n FROM email_verifications WHERE email=?').get(pending).n,1);

const interruptedEmail='failed-atomic@example.test';
sql.prepare("INSERT INTO email_verifications(email,code,expires_at) VALUES(?,'222222',?)").run(interruptedEmail,new Date(Date.now()+600000).toISOString());
sql.exec("CREATE TRIGGER reject_test_member BEFORE INSERT ON users WHEN NEW.email='failed-atomic@example.test' BEGIN SELECT RAISE(ABORT,'intentional db failure'); END;");
const failed=await request('/api/auth/verify',{email:interruptedEmail,username:'failed-member',password:'secure-password',code:'222222',...consent});
assert.equal(failed.status,500);
assert.equal(sql.prepare('SELECT COUNT(*) n FROM email_verifications WHERE email=? AND code=?').get(interruptedEmail,'222222').n,1,'verification code must remain after atomic user creation failure');
assert.equal(sql.prepare('SELECT COUNT(*) n FROM users WHERE email=?').get(interruptedEmail).n,0);
sql.exec('DROP TRIGGER reject_test_member');
console.log('PASS email verification/login: signed verified login, disabled/unverified/plaintext denied, resend throttled, cryptographic challenge format and failed-batch code retention');

}finally{sql.close();fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
