const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{stripTypeScriptTypes}=require('node:module');
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
sqlite.exec(`UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,role TEXT,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0);
 INSERT INTO users(id,username,email,role) VALUES(1,'Self creator','one@fixture','admin'),(2,'Collaborator','two@fixture','user'),(3,'Historical creator','three@fixture','user');
 CREATE TABLE play_events(file_id INTEGER,player_user_id INTEGER,tl_deducted REAL,revenue_credited REAL,file_tl_after REAL,play_duration_seconds REAL,car_mode INTEGER);
 CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT);
 CREATE TABLE tl_files(id INTEGER,title TEXT,artist TEXT,cover_image TEXT);
 INSERT INTO tl3_v5_releases VALUES(10,1,'sealed'),(20,3,'sealed'),(30,1,'sealed'),(40,1,'sealed');
 INSERT INTO tl_files VALUES(10,'Own song','A',''),(20,'Historical song','B',''),(30,'Split song','C',''),(40,'Unconfirmed split','D','');`);
const db={prepare(sql){let args=[];const s={sql,bind(...a){args=a;return s},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){return sqlite.prepare(sql).run(...args)}};return s},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements)results.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(s.sql)?await s.all():{results:[],meta:await s.run()});sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}}};
const api={console,crypto,CREATOR_SHARE_RATE:.7,Date,JSON,Map,Set,Number,String,Array,BigInt,TextEncoder};
vm.createContext(api);
for(const file of ['src/creator-split-policy.ts','src/economy-ledger.ts','src/self-play-income-release.ts','src/creator-payout-report.ts']){
 const code=stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');vm.runInContext(code,api);
}
async function balance(id){return Number((await db.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').bind(id).first()).available_atoms)}
async function pool(user,share,source,atoms){const id=await api.ensureLedgerAccount(db,'user',user,'TL','track_pool:'+share+':'+source);await db.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').bind(atoms,id).run();return id}
async function settle(file,share,key,user=1,creator=1){return api.settleTrackPlayback(db,{userId:user,creatorId:creator,shareId:share,amountAtoms:100000,idempotencyKey:key,fileId:file,playedSeconds:10})}
async function main(){
 await api.ensureCreatorSplitSchema(db);
 await pool(1,'self-paid','paid',100000);const totalBefore=sqlite.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n;
 await settle(10,'self-paid','self-paid-fixture');
 const paid=await api.ensureLedgerAccount(db,'user',1,'TL','wallet_paid');assert.equal(await balance(paid),70000);
 const company=await api.ensureLedgerAccount(db,'platform','timelink','TL','playback_revenue_paid');assert.equal(await balance(company),30000);
 assert.equal(sqlite.prepare('SELECT revenue_credited FROM play_events WHERE file_id=10').get().revenue_credited,7);
 assert.equal(sqlite.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n,totalBefore);
 assert.equal((await settle(10,'self-paid','self-paid-fixture')).replayed,true);assert.equal(await balance(paid),70000);
 await assert.rejects(settle(10,'self-paid','self-paid-empty'),/INSUFFICIENT_TRACK_TL/);
 await pool(1,'self-bonus','bonus',100000);await settle(10,'self-bonus','self-bonus-fixture');
 const ad=await api.ensureLedgerAccount(db,'user',1,'TL','wallet_ad');assert.equal(await balance(ad),70000);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM v3_economy_accounts WHERE bucket LIKE 'self_play_creator_share_%'").get().n,0);
 sqlite.exec(`INSERT INTO v5_creator_split_heads VALUES(30,1),(40,1);
 INSERT INTO v5_creator_split_versions(file_id,version,owner_user_id,total_bps) VALUES(30,1,1,10000),(40,1,1,10000);
 INSERT INTO v5_creator_split_members(id,file_id,version,role,name,share_bps,recipient_user_id,consent) VALUES
 ('a',30,1,'master','Self',6000,1,'accepted'),('b',30,1,'composition','Other',4000,2,'accepted'),
 ('c',40,1,'master','Pending',10000,1,'pending');`);
 await pool(1,'split-paid','paid',100000);await settle(30,'split-paid','split-self-fixture');
 assert.equal(await balance(paid),112000);
 const other=await api.ensureLedgerAccount(db,'user',2,'TL','wallet_paid');assert.equal(await balance(other),28000);
 await pool(1,'pending-paid','paid',100000);await settle(40,'pending-paid','pending-split-fixture');
 assert.equal(sqlite.prepare("SELECT b.available_atoms n FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.bucket='creator_split_pending_paid'").get().n,70000);
 const hp=await pool(3,'history','bonus',100000),held=await api.ensureLedgerAccount(db,'escrow',3,'TL','self_play_creator_share_bonus');
 const plat=await api.ensureLedgerAccount(db,'platform','timelink','TL','playback_revenue_bonus');
 await api.postLedgerTransaction(db,{idempotencyKey:'old-self-play',transactionType:'track_playback_settlement',source:'tl3_actual_playback',
 metadata:{file_id:20},lines:[{accountId:hp,assetCode:'TL',amountAtoms:-100000},{accountId:held,assetCode:'TL',amountAtoms:70000},{accountId:plat,assetCode:'TL',amountAtoms:30000}]});
 const count=sqlite.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n;
 const preview=await api.releaseHistoricalSelfPlayIncome(db);assert.equal(preview.total_atoms,70000);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n,count);
 const total=sqlite.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n;
 const release=await api.releaseHistoricalSelfPlayIncome(db,true);assert.equal(release.posted,1);assert.equal(await balance(held),0);
 const historic=await api.ensureLedgerAccount(db,'user',3,'TL','wallet_ad');assert.equal(await balance(historic),70000);
 assert.equal(sqlite.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n,total);
 assert.equal((await api.releaseHistoricalSelfPlayIncome(db,true)).posted,0);
 const report=await api.readCreatorPayoutReport(db,3);assert.equal(report.summary.earned_tl,7);assert.equal(report.tracks[0].earned_tl,7);
 const imbalance=sqlite.prepare('SELECT COUNT(*) n FROM(SELECT transaction_id,SUM(amount_atoms) n FROM v3_economy_entries GROUP BY transaction_id,asset_code HAVING n<>0)').get().n;assert.equal(imbalance,0);
 console.log('PASS self-play income: actual paid and bonus TL consumption, 70:30 split, recipient self-share, unresolved rights escrow, replay protection, insufficient funds, auditable historical release, no issuance/double count and per-song reporting');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sqlite.close());
