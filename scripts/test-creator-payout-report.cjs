const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const dbi=new DatabaseSync(':memory:');let writes=0;
const db={prepare(sql){let args=[];const s={bind(...values){args=values;return s},async first(){return dbi.prepare(sql).get(...args)||null},async all(){return {results:dbi.prepare(sql).all(...args)}},async run(){writes++;return dbi.prepare(sql).run(...args)}};return s},async batch(items){return Promise.all(items.map(s=>s.all()))}};
dbi.exec(`
CREATE TABLE users(id INTEGER,username TEXT,email TEXT);
INSERT INTO users VALUES(1,'Admin Creator','admin@fixture'),(2,'Creator','creator@fixture'),(3,'Collaborator','split@fixture');
CREATE TABLE v3_economy_assets(asset_code TEXT,decimals INTEGER);INSERT INTO v3_economy_assets VALUES('TL',4);
CREATE TABLE v3_economy_accounts(id TEXT,owner_type TEXT,owner_id TEXT,asset_code TEXT,bucket TEXT,status TEXT DEFAULT 'active');
CREATE TABLE v3_economy_balances(account_id TEXT,available_atoms INTEGER,held_atoms INTEGER);
CREATE TABLE v3_economy_transactions(id TEXT,transaction_type TEXT,source TEXT,status TEXT DEFAULT 'posted',metadata_json TEXT,created_at TEXT DEFAULT '2026-10-25 10:00:00');
CREATE TABLE v3_economy_entries(transaction_id TEXT,account_id TEXT,asset_code TEXT,amount_atoms INTEGER);
CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT);
CREATE TABLE tl_files(id INTEGER,title TEXT,artist TEXT,cover_image TEXT);
CREATE TABLE creator_payouts(id INTEGER,user_id INTEGER,amount_tl REAL,amount_krw INTEGER,status TEXT,note TEXT,created_at TEXT,processed_at TEXT);
INSERT INTO tl3_v5_releases VALUES(10,1,'sealed'),(20,2,'sealed');
INSERT INTO tl_files VALUES(10,'Admin song','A',''),(20,'Creator song','B','');
INSERT INTO v3_economy_accounts VALUES('admin','user','1','TL','wallet_paid','active'),('creator','user','2','TL','wallet_ad','active'),('split','user','3','TL','wallet_paid','active'),('pool','user','1','TL','track_pool:20:paid','active'),('company','platform','timelink','TL','playback_revenue_paid','active'),('held','escrow','1','TL','self_play_creator_share_bonus','active'),('system','system','issue','TL','issuance','active');
INSERT INTO v3_economy_balances VALUES('admin',10000000,0),('creator',700000,0),('split',350000,0),('company',600000,0),('held',700000,0);
INSERT INTO v3_economy_transactions(id,transaction_type,source,metadata_json) VALUES
('play','track_playback_settlement','tl3_actual_playback','{"file_id":20}'),
('admin-income','track_playback_settlement','tl3_actual_playback','{"file_id":10}'),
('self-play','track_playback_settlement','tl3_actual_playback','{"file_id":10,"self_play_held":true}'),
('topup','payment_credit','pg:toss','{}'),('unbalanced','admin_adjustment','admin','{}'),
('bad-play','track_playback_settlement','tl3_actual_playback','{"file_id":20}'),
('bad-source','track_playback_settlement','untrusted_fixture','{"file_id":20}');
INSERT INTO v3_economy_entries VALUES
('play','pool','TL',-1000000),('play','creator','TL',700000),('play','company','TL',300000),
('admin-income','pool','TL',-1000000),('admin-income','admin','TL',350000),('admin-income','split','TL',350000),('admin-income','company','TL',300000),
('self-play','pool','TL',-1000000),('self-play','held','TL',700000),('self-play','company','TL',300000),
('topup','admin','TL',9000000),('topup','system','TL',-9000000),('unbalanced','admin','TL',9990000),
('bad-play','creator','TL',5000000),('bad-source','creator','TL',6000000),('bad-source','pool','TL',-6000000);
`);
const context={console,Date,Number,String,Map,Set,JSON};vm.createContext(context);
const code=stripTypeScriptTypes(fs.readFileSync('src/creator-payout-report.ts','utf8'),{mode:'transform'}).replace(/^export /gm,'');
vm.runInContext(code,context);
async function main(){
 let r=await context.readCreatorPayoutReport(db);
 assert.equal(r.summary.earned_tl,140);assert.equal(r.platform.music_revenue_tl,90);
 assert.equal(r.summary.self_play_held_tl,70);assert.equal(r.creators.length,3);
 assert.equal(r.creators.find(c=>c.id===1).total_earned,35);assert.equal(r.creators.find(c=>c.id===1).tl_balance,1000);
 assert.equal(r.creators.find(c=>c.id===3).total_earned,35);
 assert.equal(r.tracks.find(t=>t.user_id===3).file_id,10);
 assert.equal(r.creators.find(c=>c.id===2).tracks[0].earned_tl,70);
 assert.equal(r.requests.length,0);assert.equal(r.summary.cash_redeemable_tl,null);
 assert.ok(r.warnings.length>0);
 const own=await context.readCreatorPayoutReport(db,2);
 assert.equal(own.creators.length,1);assert.equal(own.creators[0].id,2);assert.ok(own.tracks.every(t=>t.user_id===2));assert.equal(own.platform,undefined);
 assert.ok(!JSON.stringify(own).includes('admin@fixture'));
 dbi.prepare("INSERT INTO creator_payouts VALUES(1,2,5,5,'completed','fixture','2026-10-25',NULL)").run();
 const legacy=await context.readCreatorPayoutReport(db,2);
 assert.equal(legacy.creators[0].reported_paid_tl,5);assert.equal(legacy.creators[0].total_exchanged,null);
 assert.equal(legacy.summary.unpaid_tl,null);
 assert.equal((await context.readCreatorPayoutReport(db,3)).requests.length,0);
 assert.equal(writes,0);

 dbi.exec('ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1; ALTER TABLE users ADD COLUMN account_forfeited INTEGER DEFAULT 0;');
 class Hono{constructor(){this.handlers={}}get(path,fn){this.handlers[path]=fn}}
 context.Hono=Hono;context.verifyToken=async token=>token==='fixture-owner-2'?{sub:2}:null;
 const route=stripTypeScriptTypes(fs.readFileSync('src/routes/creator-earnings.ts','utf8'),{mode:'transform'}).replace(/^import .*;\n/gm,'').replace('export default router;','globalThis.earningsRouter=router;');
 vm.runInContext(route,context);
 async function get(token){return context.earningsRouter.handlers['/earnings']({env:{DB:db,JWT_SECRET:'fixture'},req:{header:()=>token,json:async()=>({user_id:1}),query:()=> '1'},json:(data,status=200)=>({data,status})});}
 assert.equal((await get('')).status,401);
 let response=await get('Bearer fixture-owner-2');assert.equal(response.status,200);assert.equal(response.data.account_id,2);
 assert.ok(response.data.creators.every(c=>c.id===2));assert.ok(!JSON.stringify(response.data).includes('admin@fixture'));
 dbi.prepare('UPDATE users SET is_active=0 WHERE id=2').run();assert.equal((await get('Bearer fixture-owner-2')).status,401);

 dbi.prepare("UPDATE v3_economy_assets SET decimals=0").run();
 await assert.rejects(context.readCreatorPayoutReport(db),/PRECISION/);
 console.log('PASS read-only V5 earnings: company vs administrator-as-creator vs collaborator, four-decimal atoms, wallet/top-up exclusion, self-play hold, unbalanced/untrusted exclusion, per-song earnings, scoped owner privacy, empty history, unverified legacy payout and precision guard');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>dbi.close());
