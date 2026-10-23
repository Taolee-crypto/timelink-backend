#!/usr/bin/env node
// Runs the actual economy-ledger.ts functions against isolated in-memory SQLite.
// No Wrangler, Cloudflare credentials, network calls, or production D1.
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'timelink-v5-ledger-'));
try {
 const out=path.join(temp,'ledger.cjs');
 buildSync({entryPoints:['src/economy-ledger.ts'],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
 const {ensureLedgerAccount,postLedgerTransaction,settleTrackPlayback,getTrackPoolBalances,settleV5EarlyStop}=require(out);
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`
 CREATE TABLE v3_economy_assets(asset_code TEXT PRIMARY KEY,decimals INTEGER);
 INSERT INTO v3_economy_assets VALUES ('TL',4);
 CREATE TABLE v3_economy_accounts(id TEXT PRIMARY KEY,owner_type TEXT,owner_id TEXT,asset_code TEXT,bucket TEXT,status TEXT DEFAULT 'active',UNIQUE(owner_type,owner_id,asset_code,bucket));
 CREATE TABLE v3_economy_balances(account_id TEXT PRIMARY KEY,available_atoms INTEGER DEFAULT 0,held_atoms INTEGER DEFAULT 0,version INTEGER DEFAULT 0,updated_at TEXT);
 CREATE TABLE v3_economy_transactions(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,transaction_type TEXT,source TEXT,reference_type TEXT,reference_id TEXT,actor_user_id TEXT,description TEXT,metadata_json TEXT);
 CREATE TABLE v3_economy_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT,account_id TEXT,asset_code TEXT,amount_atoms INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE play_events(file_id INTEGER,player_user_id INTEGER,tl_deducted REAL,revenue_credited REAL,file_tl_after REAL,play_duration_seconds REAL,car_mode INTEGER);
 `);
 const db={
  prepare(sql){
   let args=[];
   const statement={bind(...a){args=a;return statement},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){return sqlite.prepare(sql).run(...args)}};
   return statement;
  },
  async batch(statements){
   sqlite.exec('BEGIN IMMEDIATE');
   try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results}
   catch(e){sqlite.exec('ROLLBACK');throw e}
  }
 };
 async function balance(id){return Number((await db.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').bind(id).first())?.available_atoms||0)}
 async function test(){
  const pool=await ensureLedgerAccount(db,'user',1,'TL','track_pool:fixture:paid');
  await db.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').bind(1800000,pool).run();
  const settled=await settleTrackPlayback(db,{userId:1,creatorId:2,shareId:'fixture',amountAtoms:300000,idempotencyKey:'play-fixture-30',fileId:10,playedSeconds:30});
  assert.equal(settled.replayed,false);assert.equal(settled.creatorShareAtoms,210000);assert.equal(settled.platformShareAtoms,90000);
  assert.equal(await balance(pool),1500000);
  const creator=await ensureLedgerAccount(db,'user',2,'TL','wallet_paid');
  const platform=await ensureLedgerAccount(db,'platform','timelink','TL','playback_revenue_paid');
  assert.equal(await balance(creator),210000);assert.equal(await balance(platform),90000);
  const replay=await settleTrackPlayback(db,{userId:1,creatorId:2,shareId:'fixture',amountAtoms:300000,idempotencyKey:'play-fixture-30',fileId:10,playedSeconds:30});
  assert.equal(replay.replayed,true);assert.equal(await balance(pool),1500000);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM play_events').first()).n,1);
  console.log('PASS actual settleTrackPlayback: 30 TL, creator 21, platform 9, idempotent replay');
  const stopped=await settleV5EarlyStop(db,{userId:1,shareId:'fixture',sessionId:'fixture-session-001',remainingAtoms:1500000});
  assert.equal(stopped.refundedAtoms,1500000);assert.equal(stopped.platformAtoms,0);
  assert.equal(await balance(pool),0);
  const walletBonus=await ensureLedgerAccount(db,'user',1,'TL','wallet_bonus');
  assert.equal(await balance(walletBonus),1500000);
  const stoppedAgain=await settleV5EarlyStop(db,{userId:1,shareId:'fixture',sessionId:'fixture-session-001',remainingAtoms:1500000});
  assert.equal(stoppedAgain.refundedAtoms,0);assert.equal(await balance(walletBonus),1500000);
  console.log('PASS actual settleV5EarlyStop: unused 150 TL => TL_B 150, platform 0');
  const total=await db.prepare('SELECT SUM(available_atoms) AS total FROM v3_economy_balances').first();
  assert.equal(Number(total.total),1800000);
  console.log('PASS total ledger conservation: 180 TL');
 }
 test().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sqlite.close());
}finally{
 process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true}));
}
