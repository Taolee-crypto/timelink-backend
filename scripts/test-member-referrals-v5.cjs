'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-referral-rewards-'));
let sql;
async function run(){
 try{
  buildSync({stdin:{contents:"export {default as router} from './src/routes/member-referrals-v5';export {makeAccessToken} from './src/auth';export {readReferralPocBonus,reverseReferralReward} from './src/v5-referral-reward';export {readRewardPolicy} from './src/v5-reward-policy';",resolveDir:process.cwd(),loader:'ts'},
   outfile:path.join(dir,'api.cjs'),format:'cjs',platform:'node',bundle:true,logLevel:'silent'});
  const api=require(path.join(dir,'api.cjs'));
  sql=new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
  sql.exec(`UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';
    CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0,
       email_verified INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users(id) VALUES(1),(2),(3),(4),(5),(6);
    CREATE TABLE cafe_channels(channel_id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE v5_store_airtime_orders(order_id TEXT PRIMARY KEY,user_id INTEGER,channel_id TEXT,
      status TEXT,payment_key TEXT,amount_krw INTEGER,paid_at TEXT);
    CREATE TABLE v5_store_airtime_grants(order_id TEXT PRIMARY KEY,user_id INTEGER);`);
  const DB={
   prepare(query){
    let bindings=[];const stmt={sql:query,
      bind(...args){bindings=args;return stmt},
      async first(){return sql.prepare(query).get(...bindings)||null},
      async all(){return {results:sql.prepare(query).all(...bindings)}},
      async run(){const r=sql.prepare(query).run(...bindings);return {meta:{changes:Number(r.changes)}}}
    };return stmt;
   },
   async batch(stmts){
    sql.exec('BEGIN IMMEDIATE');
    try{const out=[];for(const st of stmts)out.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(st.sql)?await st.all():await st.run());sql.exec('COMMIT');return out;}
    catch(e){sql.exec('ROLLBACK');throw e}
   }
  };
  const env={DB,JWT_SECRET:'test-only-referrals-key'};
  const tokens={};
  for(const id of [1,2,3,4,5,6])tokens[id]=await api.makeAccessToken(id,env.JWT_SECRET);
  async function req(id,endpoint,method='GET',data,header){
   const opts={method,headers:{Authorization:header===undefined?'Bearer '+tokens[id]:header}};
   if(data!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(data)}
   const res=await api.router.request('https://example.invalid'+endpoint,opts,env);
   return {status:res.status,json:await res.json()};
  }
  assert.equal((await req(1,'/me','GET',undefined,'')).status,401);
  assert.equal((await req(1,'/me','GET',undefined,tokens[1])).status,401);
  assert.equal((await req(1,'/me','GET',undefined,'bearer '+tokens[1])).status,200);
  const issued=await req(1,'/code','POST',{});assert.equal(issued.status,200);
  const code=issued.json.code;assert.match(code,/^TILO-[A-F0-9]{24}$/);
  assert.equal((await req(1,'/code','POST',{})).json.code,code,'code idempotent');
  assert.equal((await req(1,'/claim','POST',{code})).json.code,'SELF_REFERRAL');
  assert.equal((await req(2,'/claim','POST',{code})).status,200);
  assert.equal((await req(2,'/claim','POST',{code})).json.code,'ALREADY_CLAIMED');
  assert.equal((await req(1,'/settle','POST',{referred_user_id:1,milestone:'signup_verified'})).status,409);
  assert.equal((await req(2,'/settle','POST',{referred_user_id:2,milestone:'signup_verified'})).status,409,'not the referring user');
  assert.equal((await req(1,'/settle','POST',{referred_user_id:2,milestone:'store_first_paid'})).json.code,'VERIFIED_STORE_PAYMENT_REQUIRED');

  // Verified account but no payment: new-member milestone only; default TL_B=0.
  let payout=await req(1,'/settle','POST',{referred_user_id:2,milestone:'signup_verified'});
  assert.equal(payout.status,200);assert.equal(payout.json.tl_b,0);
  assert.equal(payout.json.poc_points,0.2);
  payout=await req(1,'/settle','POST',{referred_user_id:2,milestone:'signup_verified'});
  assert.equal(payout.status,200);assert.equal(payout.json.tl_b,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_referral_reward_receipts').get().n,1);
  assert.equal(await api.readReferralPocBonus(DB,'1','2020-01-01'),0.2);

  // Verify sandbox receipt from a real store owner + paid airtime entitlement.
  sql.exec("INSERT INTO cafe_channels VALUES ('cafe_2',2,'active')");
  sql.exec("INSERT INTO v5_store_airtime_orders VALUES ('order-2',2,'cafe_2','pending',NULL,5000,NULL)");
  assert.equal((await req(1,'/settle','POST',{referred_user_id:2,milestone:'store_first_paid'})).status,409);
  sql.exec("UPDATE v5_store_airtime_orders SET status='paid',payment_key='toss-test-proof',paid_at=CURRENT_TIMESTAMP WHERE order_id='order-2'");
  assert.equal((await req(1,'/settle','POST',{referred_user_id:2,milestone:'store_first_paid'})).status,409,'no grant means no verified service');
  sql.exec("INSERT INTO v5_store_airtime_grants VALUES ('order-2',2)");
  payout=await req(1,'/settle','POST',{referred_user_id:2,milestone:'store_first_paid'});
  assert.equal(payout.status,200);assert.equal(payout.json.poc_points,0.5);
  assert.equal(await api.readReferralPocBonus(DB,'1','2020-01-01'),0.7);
  assert.equal((await req(1,'/settle','POST',{referred_user_id:2,milestone:'store_first_paid'})).status,200);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_referral_reward_receipts').get().n,2);

  // An administrator can explicitly fund future verified milestones.
  let reward=await api.readRewardPolicy(DB);
  reward.rules.referral_signup_tl_b=500;
  reward.rules.referral_store_tl_b=1200;
  const nextVersion=reward.version+1;
  sql.prepare("UPDATE v5_reward_policy SET version=?,rules_json=? WHERE id=1").run(nextVersion,JSON.stringify(reward.rules));
  sql.exec("UPDATE users SET email_verified=0 WHERE id=3");
  assert.equal((await req(3,'/claim','POST',{code})).status,200);
  assert.equal((await req(1,'/settle','POST',{referred_user_id:3,milestone:'signup_verified'})).json.code,'REFERRAL_VERIFICATION_REQUIRED');
  sql.exec("UPDATE users SET email_verified=1 WHERE id=3");
  payout=await req(1,'/settle','POST',{referred_user_id:3,milestone:'signup_verified'});
  assert.equal(payout.status,200,JSON.stringify(payout.json));assert.equal(payout.json.tl_b,500);
  assert.ok(payout.json.ledger_transaction_id);
  assert.equal((await req(1,'/settle','POST',{referred_user_id:3,milestone:'signup_verified'})).json.ledger_transaction_id,payout.json.ledger_transaction_id);
  const wallet=sql.prepare("SELECT b.available_atoms FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id='1' AND a.asset_code='TL' AND a.bucket='wallet_bonus'").get();
  assert.equal(wallet.available_atoms,500*10000);
  const tid=payout.json.ledger_transaction_id;
  assert.equal(sql.prepare('SELECT SUM(amount_atoms) n FROM v3_economy_entries WHERE transaction_id=?').get(tid).n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions WHERE idempotency_key=?').get('referral:signup_verified:3').n,1);
  // Manual refund reversal is atomic: reverse TL_B while excluding POC.
  const reversed=await api.reverseReferralReward(DB,1,'referral:signup_verified:3','verified-refund-3');
  assert.equal(reversed.ok,true);assert.equal(reversed.tl_b_reversed,500);
  assert.equal(sql.prepare('SELECT available_atoms n FROM v3_economy_balances WHERE account_id=(SELECT id FROM v3_economy_accounts WHERE owner_type=\'user\' AND owner_id=\'1\' AND bucket=\'wallet_bonus\')').get().n,0);
  assert.equal(sql.prepare('SELECT status FROM v5_referral_reward_receipts WHERE milestone_key=\'referral:signup_verified:3\'').get().status,'reversed');
  assert.equal(await api.readReferralPocBonus(DB,'1','2020-01-01'),0.7);
  assert.equal((await api.reverseReferralReward(DB,1,'referral:signup_verified:3','verified-refund-3')).already_reversed,true);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type='referral_bonus_reversal'").get().n,1);
  // Re-submission with tampered amount field is invalid.
  assert.equal((await req(1,'/settle','POST',{referred_user_id:3,milestone:'signup_verified',tl_b:1000000})).status,400);
  // Original member must not be able to launder an old account through a new claim.
  sql.exec("UPDATE users SET created_at='2025-01-01 00:00:00' WHERE id=5");
  assert.equal((await req(5,'/claim','POST',{code})).status,200);
  assert.equal((await req(1,'/settle','POST',{referred_user_id:5,milestone:'signup_verified'})).json.code,'REFERRAL_SIGNUP_WINDOW_EXPIRED');
  // Inactive sponsor cannot redeem pending referral milestones.
  sql.exec('UPDATE users SET is_active=0 WHERE id=1');
  assert.equal((await req(1,'/me')).status,401);
  assert.equal((await req(4,'/claim','POST',{code})).json.code,'CODE_NOT_FOUND');
  sql.exec('UPDATE users SET is_active=1 WHERE id=1;UPDATE users SET account_forfeited=1 WHERE id=4');
  assert.equal((await req(4,'/claim','POST',{code})).status,401);
  const summary=await req(1,'/me');assert.equal(summary.status,200);
  assert.equal(summary.json.rewards_enabled,true);
  assert.equal(summary.json.rewards.length,3);
  console.log('PASS HTTP + SQLite: member verification, store paid grant, zero-default funding, admin funded atomic TL_B, POC, replay, isolation, old signup anti-abuse');
 }finally{sql?.close();fs.rmSync(dir,{recursive:true,force:true})}
}
run().catch(e=>{console.error(e);process.exitCode=1});
