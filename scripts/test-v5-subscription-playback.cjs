const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-subscription-playback-'));
buildSync({stdin:{contents:"export * from './src/v5-subscription-meter';export * from './src/v5-subscription-playback';export * from './src/economy-ledger';export * from './src/creator-payout-report';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
const api=require(path.join(temp,'api.cjs')),sql=new DatabaseSync(':memory:');
sql.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));sql.exec("UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL'");
const db={prepare(q){let args=[];const s={q,bind(...a){args=a;return s},async first(){return sql.prepare(q).get(...args)||null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){const r=sql.prepare(q).run(...args);return {meta:{changes:Number(r.changes)}}}};return s},async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const out=[];for(const s of statements)out.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(s.q)?await s.all():await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};

const H=3600000,start=Date.parse('2026-10-26T00:00:00Z');
sql.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,role TEXT);INSERT INTO users VALUES(1,'Payer','','user'),(3,'Self','','user'),(77,'Creator','','user');CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT);INSERT INTO tl3_v5_releases VALUES(10,77,'sealed');CREATE TABLE tl_files(id INTEGER,title TEXT,artist TEXT,cover_image TEXT);INSERT INTO tl_files VALUES(10,'Song','','');CREATE TABLE play_events(file_id INTEGER,player_user_id INTEGER,tl_deducted REAL,revenue_credited REAL,file_tl_after REAL,play_duration_seconds REAL,car_mode INTEGER)`);
async function grant(user,level=1,zone='Asia/Seoul',mode='live'){
 await db.prepare('INSERT INTO v5_music_entitlements VALUES(?,?,?,?,?,?,?,?,?)').bind('grant-'+user,user,level,zone,start,start+72*H,'receipt:'+user,mode,'active').run();
}
const sid=user=>'sub_fixture_session_'+user;
const input=(user,playedMs,creator=77)=>({sessionId:sid(user),userId:user,fileId:10,creatorId:creator,shareId:'song-10',playedMs});
async function begin(user,at=start){return api.beginSubscriptionSession(db,{sessionId:sid(user),userId:user,fileId:10,durationMs:24*H},at)}
async function seed(user,bucket,amount){const a=await api.ensureLedgerAccount(db,'user',user,'TL',bucket);sql.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').run(amount,a);return a}
const bal=a=>Number(sql.prepare('SELECT available_atoms n FROM v3_economy_balances WHERE account_id=?').get(a).n);
async function main(){
 await api.ensureSubscriptionPlaybackSchema(db);
 await grant(99,24,'Asia/Seoul','test');assert.equal(await api.subscriptionPreflight(db,99,start),null);await assert.rejects(begin(99),/ACTIVE_SUBSCRIPTION_REQUIRED/);
 await grant(1);await begin(1);await assert.rejects(api.beginSubscriptionSession(db,{sessionId:sid(1),userId:1,fileId:11,durationMs:24*H},start),/BINDING_CONFLICT/);
 let r=await api.meterSubscriptionPlayback(db,input(1,999999),start+1000);assert.equal(r.billed_seconds,1);assert.equal(r.charged_tl,0);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_usage_rights').get().n,1);
 r=await api.meterSubscriptionPlayback(db,input(1,1000),start+2000);assert.equal(r.delta_tl,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_usage_events').get().n,1);
 r=await api.meterSubscriptionPlayback(db,input(1,H),start+H);assert.equal(r.billed_seconds,3600);assert.equal(r.charged_tl,0);
 assert.equal((await api.subscriptionPreflight(db,1,start+H)).can_play,false);
 const ad=await seed(1,'wallet_ad',20000),bonus=await seed(1,'wallet_bonus',30000),paid=await seed(1,'wallet_paid',50000);
 r=await api.meterSubscriptionPlayback(db,input(1,H+10000),start+H+10000);assert.equal(r.delta_tl,10);assert.equal(bal(ad)+bal(bonus)+bal(paid),0);
 const cp=await api.ensureLedgerAccount(db,'user',77,'TL','wallet_paid'),cb=await api.ensureLedgerAccount(db,'user',77,'TL','wallet_bonus');assert.equal(bal(cp),35000);assert.equal(bal(cb),35000);
 r=await api.meterSubscriptionPlayback(db,input(1,H+20000),start+H+20000);assert.equal(r.stop,true);assert.equal(r.billed_seconds,3610);assert.equal(r.delta_tl,0);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM v3_economy_accounts WHERE bucket LIKE 'track_pool:%'").get().n,0);
 // Same member's overlapping reports across separate sessions must roll back.
 await grant(2);await begin(2);await api.beginSubscriptionSession(db,{sessionId:'sub_other_session_2',userId:2,fileId:10,durationMs:24*H},start);
 await api.meterSubscriptionPlayback(db,input(2,1000),start+1000);
 await assert.rejects(api.meterSubscriptionPlayback(db,{...input(2,1000),sessionId:'sub_other_session_2'},start+1000));
 assert.equal(sql.prepare("SELECT reported_ms FROM v5_music_player_sessions WHERE session_id='sub_other_session_2'").get().reported_ms,0);
 // Self creator wallet debit is net of the legitimate 70% credit; usage is gross.
 await grant(3);await begin(3);await api.meterSubscriptionPlayback(db,input(3,H,3),start+H);const self=await seed(3,'wallet_paid',100000);
 r=await api.meterSubscriptionPlayback(db,input(3,H+10000,3),start+H+10000);assert.equal(r.delta_tl,10);assert.equal(bal(self),70000);
 const selfBonus=await seed(3,'wallet_bonus',100000);
 r=await api.meterSubscriptionPlayback(db,input(3,H+20000,3),start+H+20000);assert.equal(r.delta_tl,10);assert.equal(bal(selfBonus),70000);
 // Local midnight splits one report and resets included time.
 await grant(4);const midnight=start+15*H;await begin(4,midnight-1000);
 r=await api.meterSubscriptionPlayback(db,input(4,2000),midnight+1000);assert.equal(r.billed_seconds,2);assert.equal(r.charged_tl,0);
 const days=sql.prepare('SELECT included_used_ms FROM v5_music_daily_usage WHERE user_id=4 ORDER BY local_day').all();assert.deepEqual(days.map(x=>x.included_used_ms),[1000,1000]);
 await api.closeSubscriptionSession(db,sid(4),4,10);await assert.rejects(api.meterSubscriptionPlayback(db,input(4,3000),midnight+2000),/CLOSED_OR_MISSING/);
 await grant(5);await begin(5);sql.exec("UPDATE v5_music_entitlements SET status='cancelled' WHERE user_id=5");await assert.rejects(api.meterSubscriptionPlayback(db,input(5,1000),start+1000),/ENTITLEMENT_CHANGED/);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM(SELECT transaction_id,SUM(amount_atoms) s FROM v3_economy_entries GROUP BY transaction_id,asset_code HAVING s<>0)').get().n,0);
 const report=await api.readCreatorPayoutReport(db);assert.equal(report.creators.find(x=>x.id===77).total_earned,7);assert.equal(report.creators.find(x=>x.id===3).total_earned,14);assert.equal(report.creators.find(x=>x.id===1),undefined);assert.equal(report.platform.music_revenue_tl,9);
 console.log('PASS subscription playback SQLite: server elapsed bound, included quota, mixed-source direct wallet overage, cash/TL_B 70:30, self creator, replay, concurrent session rollback, midnight reset, cancellation, close, rights snapshots and no track-pool consumption');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
