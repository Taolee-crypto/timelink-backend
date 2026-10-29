'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tlc-audit-'));
let sqlite;
async function main(){
 buildSync({stdin:{contents:"export {readTlcIssuanceIntegrity} from './src/v5-tlc-issuance-audit';",loader:'ts',resolveDir:process.cwd()},
  bundle:true,platform:'node',format:'cjs',outfile:path.join(dir,'audit.cjs'),logLevel:'silent'});
 const {readTlcIssuanceIntegrity}=require(path.join(dir,'audit.cjs'));
 sqlite=new DatabaseSync(':memory:');
 sqlite.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
 sqlite.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT NOT NULL);INSERT INTO users(id,role) VALUES(1,'admin'),(2,'user')");
 const db={prepare(sql){let args=[];const o={bind(...values){args=values;return o},async first(){return sqlite.prepare(sql).get(...args)||null}};return o;}};
 function account(id,ownerType,ownerId,bucket){
  sqlite.prepare("INSERT INTO v3_economy_accounts (id,owner_type,owner_id,asset_code,bucket) VALUES(?,?,?,'TLC',?)")
    .run(id,ownerType,String(ownerId),bucket);
  sqlite.prepare("INSERT INTO v3_economy_balances(account_id) VALUES(?)").run(id);
 }
 account('iss','system','v5-dev-mining','issuance');
 account('group','platform','tilo-group','permanent_value_reserve_locked');
 account('user1','user',1,'wallet');account('user2','user',2,'wallet');
 function post(user,gross,day){
  const key='v5-tlc-day:'+user+':'+day,tx='tx'+user;
  const member=Math.floor(gross/2),group=gross-member;
  sqlite.prepare("INSERT INTO v3_tlc_mining_records(id,user_id,idempotency_key,period_date,poc_index,plan_code,requested_atoms,minted_atoms,status) VALUES(?,?,?,?,1,'A',?,?,'posted')").run('min'+user,String(user),key,day,gross,gross);
  sqlite.prepare("INSERT INTO v3_economy_transactions(id,idempotency_key,transaction_type,source,actor_user_id,metadata_json) VALUES(?,?,'tlc_development_mining','server_poc_v1',?,?)").run(tx,key,String(user),JSON.stringify({split_policy:'tilo-group-5050-v1'}));
  for(const [id,atoms] of [['iss',-gross],['group',group],['user'+user,member]])
    sqlite.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES(?,?,'TLC',?)").run(tx,id,atoms);
  sqlite.prepare("UPDATE v3_economy_balances SET held_atoms=held_atoms+? WHERE account_id='group'").run(group);
  sqlite.prepare("UPDATE v3_economy_balances SET available_atoms=available_atoms+? WHERE account_id=?").run(member,'user'+user);
 }
 post(1,101,'2026-10-27');post(2,100,'2026-10-28');
 let audit=await readTlcIssuanceIntegrity(db);
 assert.equal(audit.ok,true);
 assert.equal(audit.no_fixed_max_supply,true);
 assert.equal(audit.checked_split_receipts,2);
 assert.equal(audit.gross_mined_atoms,201);
 assert.equal(audit.member_mined_atoms,100);
 assert.equal(audit.group_mined_atoms,101);
 assert.equal(audit.reserve_held_atoms,101);
 assert.equal(audit.reserve_available_atoms,0);
 assert.equal(audit.admin_regular_mining_credits,1);
 assert.equal(audit.invalid_split_count,0);
 assert.equal(audit.anomaly_free,true);
 // An administrator can mine as a verified creator but must NOT get
 // arbitrary privileged issuance. Ensure any such direct issuance is flagged.
 sqlite.prepare("INSERT INTO v3_economy_transactions(id,idempotency_key,transaction_type,source,actor_user_id) VALUES('bad','founder-extra','privileged_tlc_issue','admin_manual','1')").run();
 sqlite.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES('bad','iss','TLC',-10)").run();
 sqlite.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES('bad','user1','TLC',10)").run();
 audit=await readTlcIssuanceIntegrity(db);
 assert.equal(audit.nonmining_issuance_entries,1);
 assert.equal(audit.anomaly_free,false);
 sqlite.prepare("UPDATE v3_economy_balances SET available_atoms=available_atoms+1 WHERE account_id='group'").run();
 audit=await readTlcIssuanceIntegrity(db);
 assert.equal(audit.reserve_matches_mining,false);
 console.log('PASS TLC audit: regular founder mining allowed, 50:50 exact atom split, privileged mint flagged, group unlock anomaly flagged');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sqlite?.close();fs.rmSync(dir,{force:true,recursive:true})});
