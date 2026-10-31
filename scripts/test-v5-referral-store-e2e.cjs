'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-referral-store-e2e-'));let sqlite;
async function main(){
 try{
  buildSync({stdin:{contents:
    "export {default as payment} from './src/payment';"+
    "export {default as referrals} from './src/routes/member-referrals-v5';"+
    "export {default as admin} from './src/routes/admin';"+
    "export {makeAccessToken} from './src/auth';"+
    "export {readReferralPocBonus} from './src/v5-referral-reward';"+
    "export {readRewardPolicy} from './src/v5-reward-policy';",
    resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',
    outfile:path.join(tmp,'api.cjs'),logLevel:'silent'});
  const api=require(path.join(tmp,'api.cjs'));
  sqlite=new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
  sqlite.exec(`UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,role TEXT DEFAULT 'user',is_active INTEGER DEFAULT 1,
      account_forfeited INTEGER DEFAULT 0,email_verified INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users(id,role) VALUES(1,'user'),(2,'user'),(9,'admin');
    CREATE TABLE cafe_channels(channel_id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,status TEXT NOT NULL);
    INSERT INTO cafe_channels VALUES('cafe_referral_store_2',2,'active');`);
  const DB={
   prepare(query){let params=[];const stmt={sql:query,bind(...a){params=a;return stmt},
    async first(){return sqlite.prepare(query).get(...params)||null},
    async all(){return {results:sqlite.prepare(query).all(...params)}},
    async run(){const r=sqlite.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}
   };return stmt;},
   async batch(stmts){sqlite.exec('BEGIN IMMEDIATE');try{const out=[];for(const st of stmts){
    out.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(st.sql)?await st.all():await st.run());
   }sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}
  };
  const env={DB,JWT_SECRET:'referral-store-e2e-key',TOSS_CLIENT_KEY:'test_ck_referral',TOSS_SECRET_KEY:'test_sk_referral'};
  const tokens={};
  for(const id of [1,2,9])tokens[id]=await api.makeAccessToken(id,env.JWT_SECRET);
  async function call(router,id,endpoint,method='POST',body){
   const opts={method,headers:{Authorization:'Bearer '+tokens[id]}};
   if(body!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}
   const res=await router.request('https://fixture.invalid'+endpoint,opts,env);
   return {status:res.status,result:await res.json()};
  }

  const issued=await call(api.referrals,1,'/code','POST',{});
  assert.equal(issued.status,200);assert.match(issued.result.code,/^TILO-[A-F0-9]{24}$/);
  const claimed=await call(api.referrals,2,'/claim','POST',{code:issued.result.code});
  assert.equal(claimed.status,200);assert.equal(claimed.result.contribution_verified,true);

  const policy=await api.readRewardPolicy(DB);
  policy.rules.referral_store_tl_b=1200;
  policy.rules.referral_store_poc=0.5;
  sqlite.prepare('UPDATE v5_reward_policy SET version=version+1,rules_json=?,updated_by=9 WHERE id=1')
    .run(JSON.stringify(policy.rules));

  const base='/v5/commercial-time',select={hours:1,period:'hour',area_tier:0,channel_id:'cafe_referral_store_2'};
  const prepared=await call(api.payment,2,base+'/toss/prepare','POST',select);
  assert.equal(prepared.status,200,JSON.stringify(prepared.result));
  const realFetch=global.fetch;let providerCalls=0;
  try{
   global.fetch=async(url,opts)=>{
    providerCalls++;assert.equal(url,'https://api.tosspayments.com/v1/payments/confirm');
    const b=JSON.parse(opts.body);return Response.json({orderId:b.orderId,paymentKey:b.paymentKey,status:'DONE',totalAmount:b.amount});
   };
   const confirmed=await call(api.payment,2,base+'/toss/confirm','POST',{
    orderId:prepared.result.orderId,amount:prepared.result.amount,paymentKey:'referral-store-paid'
   });
   assert.equal(confirmed.status,200,JSON.stringify(confirmed.result));
   assert.equal(confirmed.result.referralReward.status,'posted');
   assert.equal(confirmed.result.referralReward.tl_b,1200);
   assert.equal(confirmed.result.referralReward.poc_points,0.5);
   const firstTx=confirmed.result.referralReward.ledger_transaction_id;assert.ok(firstTx);
   assert.equal(await api.readReferralPocBonus(DB,'1','2020-01-01'),0.7);
   const wallet=sqlite.prepare(`SELECT b.available_atoms n FROM v3_economy_accounts a
     JOIN v3_economy_balances b ON b.account_id=a.id
     WHERE a.owner_type='user' AND a.owner_id='1' AND a.asset_code='TL' AND a.bucket='wallet_bonus'`).get();
   assert.equal(wallet.n,1200*10000);

   const replay=await call(api.payment,2,base+'/toss/confirm','POST',{
    orderId:prepared.result.orderId,amount:prepared.result.amount,paymentKey:'referral-store-paid'
   });
   assert.equal(replay.status,200);assert.equal(replay.result.alreadyCompleted,true);
   assert.equal(replay.result.referralReward.ledger_transaction_id,firstTx);
   assert.equal(providerCalls,1,'confirmed payment replay must not call provider again');
   assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM v3_economy_transactions WHERE idempotency_key='referral:store_first_paid:2'").get().n,1);

   const refunded=await call(api.admin,9,'/referrals/store-refund','POST',{
    order_id:prepared.result.orderId,proof_reference:'toss-refund-proof-0002'
   });
   assert.equal(refunded.status,200,JSON.stringify(refunded.result));
   assert.equal(refunded.result.refund_recorded,true);assert.equal(refunded.result.reward_affected,true);
   assert.equal(refunded.result.tl_b_reversed,1200);
   assert.equal(sqlite.prepare("SELECT status FROM v5_referral_reward_receipts WHERE milestone_key='referral:store_first_paid:2'").get().status,'reversed');
   assert.equal(await api.readReferralPocBonus(DB,'1','2020-01-01'),0.2,'refunded store POC must be removed');
   assert.equal(sqlite.prepare(`SELECT b.available_atoms n FROM v3_economy_accounts a
     JOIN v3_economy_balances b ON b.account_id=a.id
     WHERE a.owner_type='user' AND a.owner_id='1' AND a.asset_code='TL' AND a.bucket='wallet_bonus'`).get().n,0);
   assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type='referral_bonus_reversal'").get().n,1);

   const refundReplay=await call(api.admin,9,'/referrals/store-refund','POST',{
    order_id:prepared.result.orderId,proof_reference:'toss-refund-proof-0002'
   });
   assert.equal(refundReplay.status,200);assert.equal(refundReplay.result.already_reversed,true);
   const conflict=await call(api.admin,9,'/referrals/store-refund','POST',{
    order_id:prepared.result.orderId,proof_reference:'different-refund-proof'
   });
   assert.equal(conflict.status,409);assert.equal(conflict.result.error,'REFUND_REFERENCE_CONFLICT');

   const afterRefund=await call(api.referrals,1,'/settle','POST',{referred_user_id:2,milestone:'store_first_paid'});
   assert.equal(afterRefund.status,200);assert.equal(afterRefund.result.status,'reversed','refunded first-payment milestone must never be reissued');
   assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM v5_referral_store_refunds").get().n,1);
  }finally{global.fetch=realFetch}
  console.log('PASS referral E2E: verified signup -> first store payment -> TL_B/POC -> replay-safe -> verified refund reversal -> no reissue');
 }finally{sqlite?.close();fs.rmSync(tmp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
