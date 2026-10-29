const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild'),{DatabaseSync}=require('node:sqlite');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-economy-renewal-'));
buildSync({stdin:{contents:`export * from './src/v5-contribution-policy';export * from './src/v5-contribution-store';export * from './src/v5-payment-ledger';export * from './src/economy-ledger';export {default as admin} from './src/routes/admin';export {default as eco} from './src/economics';export {makeAccessToken} from './src/auth';`,loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
const api=require(path.join(temp,'api.cjs')),sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
sqlite.exec(`UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';
CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0,tl_p_lifetime INTEGER DEFAULT 0,tlc_balance REAL NOT NULL DEFAULT 0,poc_index REAL DEFAULT 1.0);
INSERT INTO users(id,role) VALUES(1,'admin'),(2,'user'),(3,'user');
CREATE TABLE tl_payments(user_id TEXT,method TEXT,pg_id TEXT,merchant_uid TEXT,amount_krw INTEGER,tl_granted INTEGER,bonus_tl INTEGER,status TEXT);
CREATE TABLE play_events(file_id INTEGER,player_user_id INTEGER,tl_deducted REAL,revenue_credited REAL,file_tl_after REAL,play_duration_seconds REAL,car_mode INTEGER);
CREATE TABLE poc_logs(id INTEGER PRIMARY KEY,user_id INTEGER,mode TEXT,seconds INTEGER,tl_spent REAL,poc_gained REAL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE tl_shares(id INTEGER PRIMARY KEY,user_id INTEGER,content_kind TEXT,release_mode TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
const db={prepare(sql){let args=[];const st={sql,bind(...v){args=v;return st},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){const r=sqlite.prepare(sql).run(...args);return {results:[],meta:{changes:Number(r.changes)}}}};return st},async batch(stmts){sqlite.exec('BEGIN IMMEDIATE');try{const rs=[];for(const st of stmts)rs.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(st.sql)?await st.all():await st.run());sqlite.exec('COMMIT');return rs}catch(e){sqlite.exec('ROLLBACK');throw e}}};
const now=Date.now();
const ev=(activity,quantity,key=activity,extra={})=>({eventKey:key,userId:'2',activity,quantity,occurredAtMs:now-1000,evidenceRef:'fixture:'+key,economicKey:key,counterpartyId:['content_listen','score_share','score_use','share_listen'].includes(activity)||activity.startsWith('referral_')?'3':null,verified:true,revoked:false,...extra});
const evalP=(events,p=structuredClone(api.DEFAULT_CONTRIBUTION_POLICY))=>api.evaluateContributions(events,'2',now,p);
async function main(){
 const definitions=api.contributionTable();assert.equal(definitions.length,24);assert.equal(definitions.find(d=>d.activity==='paid_topup').categoryWeightBps,4000);
 assert.equal(evalP([]).index,0);assert.equal(evalP([ev('like',1)]).index,0);
 assert.equal(evalP([ev('paid_topup',50000)]).score,40);assert.equal(evalP([ev('paid_topup',999999)]).score,40);
 assert.equal(evalP([ev('paid_topup',10000),ev('paid_subscription',2500)]).score,10);
 assert.equal(evalP([ev('paid_topup',50000)]).index,.4);
 assert.throws(()=>evalP([ev('paid_topup',50000,'bad',{economicKey:{}})]),/INVALID_CONTRIBUTION_EVENT/);
 assert.equal(evalP([ev('listen',40*3600)]).score,10);assert.equal(evalP([ev('listen',40*3600)]).miningIndex,0);
 assert.equal(evalP([ev('paid_topup',50000,'future')].map(e=>({...e,eventKey:'future',economicKey:'future',occurredAtMs:now+1}))).score,0);
 assert.equal(evalP([ev('paid_topup',50000,'old',{occurredAtMs:now-30*86400000})]).score,0);
 assert.equal(evalP([ev('paid_topup',50000,'revoked',{revoked:true})]).score,0);
 assert.equal(evalP([ev('content_listen',72000,'self',{counterpartyId:'2'})]).score,0);
 assert.throws(()=>evalP([ev('like',1),ev('like',1)]),/DUPLICATE/);
 assert.throws(()=>evalP([ev('paid_topup',10000,'a',{economicKey:'same-receipt'}),ev('paid_subscription',10000,'b',{economicKey:'same-receipt'})]),/DUPLICATE_CONTRIBUTION_EVIDENCE/);
 assert.throws(()=>evalP([ev('referral_paid',1,'a',{economicKey:'same-first-payment'}),ev('referral_store',1,'b',{economicKey:'same-first-payment'})]),/DUPLICATE_CONTRIBUTION_EVIDENCE/);
 assert.throws(()=>evalP([ev('comment',2)]),/COUNT_EVENT/);
 const bad=structuredClone(api.DEFAULT_CONTRIBUTION_POLICY);bad.weightsBps.purchase=9999;assert.throws(()=>api.validateContributionPolicy(bad));
 const events=[ev('paid_topup',30000),ev('content_listen',36000),ev('listen',40*3600),ev('approved_work',2,'works')];
 // COUNT events are individual, not a client-provided bulk count.
 events.splice(3,1,ev('approved_work',1,'work1'),ev('approved_work',1,'work2'));
 let r=evalP(events);assert.equal(r.score,48);assert.equal(r.miningScore,42.222222);
 const referrals=Array.from({length:20},(_,i)=>ev('referral_paid',1,'ref:'+i));
 r=evalP(referrals);assert.equal(r.score,8);assert.equal(evalP([...referrals].reverse()).score,8);
 const full=[ev('paid_topup',50000),ev('content_listen',72000),ev('listen',144000),...Array.from({length:5},(_,i)=>ev('approved_work',1,'work:'+i)),...Array.from({length:4},(_,i)=>ev('score_register',1,'score:'+i)),...Array.from({length:20},(_,i)=>ev('score_share',1,'ss:'+i)),...Array.from({length:20},(_,i)=>ev('score_use',1,'su:'+i)),...Array.from({length:50},(_,i)=>ev('like',1,'like:'+i)),...Array.from({length:30},(_,i)=>ev('comment',1,'comment:'+i)),...Array.from({length:20},(_,i)=>ev('share_listen',1,'share:'+i)),...referrals,...Array.from({length:6},(_,i)=>ev('accepted_report',1,'report:'+i))];
 r=evalP(full);assert.equal(r.score,100);assert.equal(r.index,.9);assert.equal(r.grade,9);assert.equal(r.miningIndex,.9);
 console.log('PASS contribution: 24 activity definitions, 6 category caps, shared referral cap, continuous 0-.9, eligibility, evidence deduplication, rolling window and no double listening');
 const p=await api.readContributionPolicy(db);assert.equal(p.version,0);
 const changed=structuredClone(p.policy);changed.weightsBps.purchase=4500;changed.weightsBps.content=1500;
 await api.saveContributionPolicy(db,changed,0,1,'가중치 변경 검증');
 await assert.rejects(api.saveContributionPolicy(db,changed,0,1,'오래된 버전'),/VERSION_CONFLICT/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v5_contribution_policy_history').get().n,2);
 const payment={userId:'2',method:'stripe',paymentId:'live-pg',orderId:'',paidTL:10000,bonusTL:500,paymentMode:'live'};
 await api.creditVerifiedPayment(db,payment);await api.creditVerifiedPayment(db,payment);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v5_contribution_events').get().n,1);
 assert.equal(sqlite.prepare('SELECT quantity FROM v5_contribution_events').get().quantity,10000);
 await api.creditVerifiedPayment(db,{...payment,paymentId:'test-pg',paymentMode:'test'});
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v5_contribution_events').get().n,1);
 assert.equal((await api.readContributionEvaluation(db,2)).newMiningEnabled,false);
 // A failed receipt transaction must not retain a contribution event or wallet credit.
 sqlite.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON tl_payments WHEN NEW.pg_id='bad-pg' BEGIN SELECT RAISE(ABORT,'fixture payment failure'); END");
 const txBefore=sqlite.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n;
 await assert.rejects(api.creditVerifiedPayment(db,{...payment,paymentId:'bad-pg'}),/fixture payment failure/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v5_contribution_events').get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n,txBefore);
 console.log('PASS actual SQLite: approved policy version/CAS/history, live purchase source only, no bonus points, test exclusion, payment replay and atomic rollback');
 const env={DB:db,JWT_SECRET:'renewal-fixture-key'};
 const adminToken=await api.makeAccessToken(1,env.JWT_SECRET),userToken=await api.makeAccessToken(2,env.JWT_SECRET);
 let response=await api.admin.request('/contribution-policy',{},env);assert.equal(response.status,403);
 response=await api.admin.request('/contribution-policy',{headers:{Authorization:'Bearer '+userToken}},env);assert.equal(response.status,403);
 response=await api.admin.request('/contribution-policy',{headers:{Authorization:'Bearer '+adminToken}},env);assert.equal(response.status,200);let body=await response.json();assert.equal(body.policyStatus,'retired');assert.equal(body.activeRewardPolicy,'v5_reward_policy');assert.equal(body.definitions.length,24);assert.ok(body.products.every(p=>p.miningMode==='individual'));
 response=await api.admin.request('/contribution-policy',{method:'POST',headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},body:JSON.stringify({expected_version:0,policy:changed,note:'stale'})},env);assert.equal(response.status,410);assert.equal((await response.json()).error,'CONTRIBUTION_POLICY_RETIRED');
 response=await api.eco.request('/contribution',{headers:{Authorization:'Bearer '+userToken}},env);assert.equal(response.status,200);body=await response.json();assert.equal(body.newMiningEnabled,false);

 // POC and TLC must never trust arbitrary client-provided time, spending,
 // uploads or chosen mining amount. These requests cannot write wallet/POC.
 const forgedActivity=await api.eco.request('/activity',{
   method:'POST',headers:{Authorization:'Bearer '+userToken,'Content-Type':'application/json'},
   body:JSON.stringify({seconds:86400,tl_p_spent:999999999,new_uploads:99999})
 },env);
 assert.equal(forgedActivity.status,403);
 assert.equal((await forgedActivity.json()).code,'CLIENT_REPORTED_POC_DISABLED');
 const withoutLogin=await api.eco.request('/activity',{
   method:'POST',headers:{'Content-Type':'application/json'},body:'{}'
 },env);
 assert.equal(withoutLogin.status,401);
 // Valid server-owned activities are the only permissible POC source.
 sqlite.prepare("INSERT INTO poc_logs(user_id,mode,seconds,tl_spent) VALUES(2,'consume',0,5000)").run();
 sqlite.prepare("INSERT INTO poc_logs(user_id,mode,seconds,tl_spent) VALUES(2,'listen',3600,0)").run();
 const preview=await api.eco.request('/activity',{method:'POST',headers:{Authorization:'Bearer '+userToken,'Content-Type':'application/json'},body:'{}'},env);
 assert.equal(preview.status,200);let previewBody=await preview.json();
 assert.ok(previewBody.poc_index>.1);assert.ok(previewBody.tlc_mining.daily_max>0);
 const mint=await api.eco.request('/mine-tlc',{
   method:'POST',headers:{Authorization:'Bearer '+userToken,'Content-Type':'application/json'},
   body:JSON.stringify({tlc_amount:999999999})
 },env);
 assert.equal(mint.status,200,await mint.clone().text());
 const receipt=await mint.json();
 assert.ok(receipt.ok);assert.ok(receipt.mined>0);
 assert.ok(receipt.mined<=previewBody.tlc_mining.daily_max+1e-9);
 assert.equal(receipt.development_only,true);
 assert.equal(receipt.blockchain_minted,false);
 const ledgerMined=sqlite.prepare("SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type='tlc_development_mining'").get().n;
 assert.equal(ledgerMined,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_tlc_mining_records').get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM tlc_mining_v2').get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_poc_snapshots').get().n,1);
 const entries=sqlite.prepare("SELECT SUM(amount_atoms) n FROM v3_economy_entries WHERE transaction_id=?").get(receipt.ledger_receipt);
 assert.equal(entries.n,0);
 const minedBalance=sqlite.prepare('SELECT tlc_balance FROM users WHERE id=2').get().tlc_balance;
 assert.equal(minedBalance,receipt.mined);
 const repeatMint=await api.eco.request('/mine-tlc',{
   method:'POST',headers:{Authorization:'Bearer '+userToken,'Content-Type':'application/json'},
   body:'{}'
 },env);
 assert.equal(repeatMint.status,409);
 assert.equal((await repeatMint.json()).code,'ALREADY_MINED_TODAY');
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_tlc_mining_records').get().n,1);
 assert.equal(sqlite.prepare('SELECT tlc_balance FROM users WHERE id=2').get().tlc_balance,minedBalance);
 const history=await api.eco.request('/mining-history',{headers:{Authorization:'Bearer '+userToken}},env);
 assert.equal(history.status,200);assert.equal((await history.json()).history.length,1);
 console.log('PASS TLC mining: server POC only, atomic V3 ledger + legacy display, same-day dedup, amount cap, history');
 response=await api.eco.request('/daily-free-allowance',{},env);assert.equal(response.status,401);
 response=await api.eco.request('/daily-free-allowance?user_id=3',{headers:{Authorization:'Bearer '+userToken}},env);assert.equal(response.status,200);body=await response.json();assert.equal(body.active,false);assert.equal(body.subscriptionCheckoutEnabled,false);
 response=await api.eco.request('/daily-free-products',{},env);body=await response.json();assert.equal(body.products.length,24);assert.equal(body.purchasable,false);
 // Consume a mixed funded pool: paid cash source vs gifted TL_B.
 const beforeTotal=sqlite.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n;
 await api.chargeTrackPool(db,2,'mixed',api.tlToAtoms(2000),'mixed-charge');
 // User 2 has 1,000 bonus TL and 20,000 paid TL from the two fixture payments.
 const settlement=await api.settleTrackPlayback(db,{userId:2,creatorId:3,shareId:'mixed',amountAtoms:api.tlToAtoms(2000),idempotencyKey:'mixed-settlement',fileId:77,playedSeconds:2000});
 assert.equal(settlement.used.bonus,api.tlToAtoms(1000));assert.equal(settlement.used.paid,api.tlToAtoms(1000));
 const creatorPaid=await api.ensureLedgerAccount(db,'user',3,'TL','wallet_paid');
 const creatorBonus=await api.ensureLedgerAccount(db,'user',3,'TL','wallet_bonus');
 const balance=id=>sqlite.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').get(id).available_atoms;
 assert.equal(balance(creatorPaid),api.tlToAtoms(700));assert.equal(balance(creatorBonus),api.tlToAtoms(700));
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM v3_economy_accounts WHERE owner_id='3' AND bucket='wallet_ad'").get().n,0);
 assert.equal(sqlite.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n,beforeTotal);
 const repeat=await api.settleTrackPlayback(db,{userId:2,creatorId:3,shareId:'mixed',amountAtoms:api.tlToAtoms(2000),idempotencyKey:'mixed-settlement',fileId:77,playedSeconds:2000});
 assert.equal(repeat.replayed,true);assert.equal(balance(creatorBonus),api.tlToAtoms(700));
 console.log('PASS mixed funding: paid 70% stays cash source, gifted 70% becomes TL_B, conservation and replay');
 console.log('PASS HTTP: admin-only historical proposal, retired policy writes rejected, owner-scoped audit data and retained time products');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sqlite.close();fs.rmSync(temp,{recursive:true,force:true})});
