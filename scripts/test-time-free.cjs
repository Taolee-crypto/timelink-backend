const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'time-free-'));
buildSync({stdin:{contents:"export * from './src/v5-time-free';export * from './src/v5-reward-policy';export * from './src/auth';export {default as payment} from './src/payment';export {default as worker} from './src/index';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
const api=require(path.join(temp,'api.cjs')),sql=new DatabaseSync(':memory:');
const db={prepare(q){let args=[];const s={q,bind(...a){args=a;return s},async first(){return sql.prepare(q).get(...args)||null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){const r=sql.prepare(q).run(...args);return {meta:{changes:Number(r.changes)}}}};return s},async batch(items){sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of items)results.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(s.q)?await s.all():await s.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
const H=3600000,start=Date.parse('2026-10-27T00:00:00Z');
sql.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0,poc_index REAL DEFAULT 0.1);INSERT INTO users(id) VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9);
 CREATE TABLE poc_logs(id INTEGER PRIMARY KEY,user_id INTEGER,mode TEXT,seconds REAL,tl_spent REAL,poc_gained REAL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE tl_files(id INTEGER PRIMARY KEY,user_id INTEGER,revenue_held INTEGER,shared INTEGER);INSERT INTO tl_files VALUES(10,9,0,1),(11,9,0,1),(12,9,0,0);
 CREATE TABLE tl3_v5_releases(file_id INTEGER,share_id TEXT,duration_ms INTEGER,status TEXT);INSERT INTO tl3_v5_releases VALUES(10,'song10',240000,'sealed'),(11,'song11',180000,'sealed'),(12,'private12',180000,'sealed');
 CREATE TABLE tl3_releases(file_id INTEGER,share_id TEXT,status TEXT);CREATE TABLE tl3_spine_v4_releases(file_id INTEGER,share_id TEXT,status TEXT,duration_ms INTEGER,segment_count INTEGER);
 CREATE TABLE v5_shareplace_time_test_orders(quote_id TEXT PRIMARY KEY,user_id INTEGER,seconds INTEGER,first_discount INTEGER DEFAULT 0,second_discount INTEGER DEFAULT 0,discounted_tl INTEGER DEFAULT 3600,method TEXT,status TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,paid_at TEXT);
 INSERT INTO v5_shareplace_time_test_orders(quote_id,user_id,seconds,status) VALUES('legacy-paid',1,3600,'test_paid'),('legacy-toss',2,3600,'toss_paid'),('unpaid',3,3600,'quoted'),('pending',4,3600,'pending_toss');`);
async function grant(user,seconds=3600,id='grant-'+user){await api.ensureTimeFreeSchema(db);await db.batch([api.timeFreeGrantStatement(db,id,user,seconds,'test')]);}
const input=(user,playedMs,fileId=10,sessionId='tf_fixture_session_'+user)=>({userId:user,fileId,sessionId,playedMs});
const begin=(user,fileId=10,durationMs=2*H,sessionId='tf_fixture_session_'+user,at=start)=>api.beginTimeFreeSession(db,{sessionId,userId:user,fileId,durationMs},at);
const env={DB:db,JWT_SECRET:'isolated-fixture-secret',TOSS_CLIENT_KEY:'test_ck_fixture',TOSS_SECRET_KEY:'test_sk_fixture'};
async function requestPayment(user,url,body){const token=await api.makeAccessToken(user,env.JWT_SECRET);const r=await api.payment.fetch(new Request('https://fixture'+url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);return {status:r.status,data:await r.json()};}
async function main(){
 // Production policy JSON was saved before new referral rules existed.
 // That legacy partial JSON must remain unchanged, while missing new keys
 // receive their current defaults and operator-defined weights are retained.
 await api.ensureRewardPolicy(db);
 const oldPolicy={...api.DEFAULT_REWARD_RULES,listen_target:23};
 for(const key of Object.keys(oldPolicy))if(key.startsWith('referral_'))delete oldPolicy[key];
 const oldJson=JSON.stringify(oldPolicy);
 sql.prepare('UPDATE v5_reward_policy SET rules_json=?,updated_by=1,version=version+1 WHERE id=1').run(oldJson);
 const normalized=(await api.readRewardPolicy(db)).rules;
 assert.equal(normalized.listen_target,23,'preserve actual administrator policy values');
 assert.equal(normalized.referral_signup_tl_b,api.DEFAULT_REWARD_RULES.referral_signup_tl_b);
 await grant(9,600,'legacy-rule-pass');
 await begin(9,10,240000,'tf_legacy_rules_session_9',start);
 const firstMeter=await api.meterTimeFreePlayback(db,input(9,1000,10,'tf_legacy_rules_session_9'),start+1000);
 assert.equal(firstMeter.time_free_remaining_ms,599000,'first real TIME FREE meter must succeed with legacy policy');
 assert.equal(firstMeter.charged_tl,0,'TIME FREE never spends TL');
 assert.equal(sql.prepare('SELECT rules_json FROM v5_reward_policy WHERE id=1').get().rules_json,oldJson,'never rewrite administrator JSON during metering');
 let pre=await api.timeFreePreflight(db,1);assert.equal(pre.time_free_remaining_ms,H);assert.equal((await api.timeFreePreflight(db,1)).time_free_remaining_ms,H);assert.equal((await api.timeFreePreflight(db,2)).time_free_remaining_ms,H);assert.equal(await api.timeFreePreflight(db,3),null);assert.equal(await api.timeFreePreflight(db,4),null);
 // Actual worker preflight must bypass wallet/track TL for any public V5 song.
 const token=await api.makeAccessToken(1,env.JWT_SECRET);
 for(const file of [10,11]){const r=await api.worker.fetch(new Request('https://fixture/api/v1/tl3/play/preflight/'+file,{method:'POST',headers:{Authorization:'Bearer '+token}}),env,{});assert.equal(r.status,200);const d=await r.json();assert.equal(d.billing_mode,'time_free');assert.equal(d.can_play,true);assert.equal(d.required_tl,0);}
 const privateResponse=await api.worker.fetch(new Request('https://fixture/api/v1/tl3/play/preflight/12',{method:'POST',headers:{Authorization:'Bearer '+token}}),env,{});assert.equal(privateResponse.status,404);
 await begin(1);let r=await api.meterTimeFreePlayback(db,input(1,1000),start+1000);assert.equal(r.charged_tl,0);assert.equal(r.tl_reward,0);assert.equal(r.time_free_remaining_ms,H-1000);assert.equal(r.contribution_seconds,1);
 const poc=sql.prepare('SELECT poc_index FROM users WHERE id=1').get().poc_index;assert.ok(poc>0.1);
 r=await api.meterTimeFreePlayback(db,input(1,1000),start+2000);assert.equal(r.contribution_seconds,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM poc_logs').get().n,1);
 // A pause of one hour followed by one second consumes one second only.
 r=await api.meterTimeFreePlayback(db,input(1,2000),start+H+2000);assert.equal(r.time_free_remaining_ms,H-2000);
 await api.closeTimeFreeSession(db,'tf_fixture_session_1',1,10);await assert.rejects(api.meterTimeFreePlayback(db,input(1,3000),start+H+3000),/CLOSED/);
 await begin(1,11,2*H,'tf_another_song_1',start+H+3000);r=await api.meterTimeFreePlayback(db,input(1,H+5000,11,'tf_another_song_1'),start+3*H);assert.equal(r.billed_seconds,3598);assert.equal(r.stop,true);assert.equal(r.time_free_remaining_ms,0);assert.equal(await api.timeFreePreflight(db,1),null);
 assert.equal(sql.prepare('SELECT SUM(seconds) n,SUM(tl_spent) spent FROM poc_logs WHERE user_id=1').get().n,3600);assert.equal(sql.prepare('SELECT SUM(tl_spent) n FROM poc_logs').get().n,0);
 // Fast-forward cannot consume more time or contribution than server elapsed.
 await grant(5);await begin(5);r=await api.meterTimeFreePlayback(db,input(5,H),start+1000);assert.equal(r.billed_seconds,1);
 await begin(5,11,2*H,'tf_parallel_session_5');await assert.rejects(api.meterTimeFreePlayback(db,input(5,1000,11,'tf_parallel_session_5'),start+1000));assert.equal(sql.prepare("SELECT reported_ms FROM v5_time_free_sessions WHERE session_id='tf_parallel_session_5'").get().reported_ms,0);
 await assert.rejects(begin(6,10,1000,'tf_fixture_session_5'),/EXHAUSTED|CONFLICT/);
 await grant(6,1,'first-six');await grant(6,2,'second-six');await begin(6);r=await api.meterTimeFreePlayback(db,input(6,3000),start+3000);assert.equal(r.billed_seconds,3);assert.equal(r.time_free_remaining_ms,0);
 // Payment and entitlement are atomic; repeat checkout never grants twice.
 const q='11111111-1111-1111-1111-111111111111';sql.prepare("INSERT INTO v5_shareplace_time_test_orders(quote_id,user_id,seconds,status) VALUES(?,7,3600,'quoted')").run(q);
 let checkout=await requestPayment(8,'/v5/shareplace-time/test-checkout',{quoteId:q,method:'tl'});assert.equal(checkout.status,404);
 checkout=await requestPayment(7,'/v5/shareplace-time/test-checkout',{quoteId:q,method:'tl'});assert.equal(checkout.status,200);assert.equal(checkout.data.time_free_remaining_ms,H);
 checkout=await requestPayment(7,'/v5/shareplace-time/test-checkout',{quoteId:q,method:'tl'});assert.equal(checkout.data.time_free_remaining_ms,H);assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_time_free_passes WHERE user_id=7').get().n,1);
 const status=await requestPayment(7,'/v5/shareplace-time/status');assert.equal(status.data.contribution_only,true);
 // No financial ledger or wallet is required or created by TIME FREE playback.
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'v3_economy_%'").get().n,0);
 console.log('PASS TIME FREE: completed purchase recovery, real worker preflight on different zero-TL songs, private-song denial, atomic checkout, idempotency, exact 3600s cap, pause, seek bound, parallel-session rollback, multiple passes, no TL/TLC ledger or rewards, existing listening contribution');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
