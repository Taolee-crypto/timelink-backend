const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-subscription-review-'));
buildSync({stdin:{contents:"export * from './src/v5-subscription-settlement-review';export {default as admin} from './src/routes/admin';export {makeAccessToken} from './src/auth';export {ensureMusicOrderSchema} from './src/v5-music-subscription-orders';export {ensureSubscriptionPlaybackSchema} from './src/v5-subscription-playback';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
const api=require(path.join(temp,'api.cjs')),sql=new DatabaseSync(':memory:');
sql.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));sql.exec("UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL'");
const db={prepare(q){let args=[];const s={q,bind(...a){args=a;return s},async first(){return sql.prepare(q).get(...args)||null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){const r=sql.prepare(q).run(...args);return {meta:{changes:Number(r.changes)}}}};return s},async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const out=[];for(const s of statements)out.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(s.q)?await s.all():await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};

const start=Date.parse('2026-10-26T00:00:00Z'),end=start+31*86400000;
const order=n=>'v5music_'+String(n).padStart(32,'0');
async function receipt(n,mode='live',user=1){
 await db.prepare('INSERT INTO v5_music_entitlements VALUES(?,?,?,?,?,?,?,?,?)').bind('ent-'+n,user,1,'UTC',start,end,'music_order:'+order(n),mode,'active').run();
 await db.prepare('INSERT INTO v5_music_receipts VALUES(?,?,?,?,?,?,?,?,?)').bind(order(n),'pg-'+n,user,1900,1330,570,mode,start,'ent-'+n).run();
}
async function usage(key,ent,file,included,snapshot=null,overage=0){
 await db.prepare(`INSERT INTO v5_music_usage_events(usage_key,user_id,file_id,session_id,entitlement_id,local_day,timezone,starts_at_ms,ends_at_ms,included_ms,overage_ms,overage_atoms,expected_daily_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(key,1,file,'session-'+key,ent,'2026-10-26','UTC',start,start+included+overage,included,overage,overage*10,0).run();
 if(snapshot!==null)await db.prepare('INSERT INTO v5_music_usage_rights(usage_key,file_id,creator_id,split_version,split_snapshot) VALUES(?,?,?,?,?)').bind(key,file,77,snapshot.version||null,JSON.stringify(snapshot)).run();
}
async function main(){
 await api.ensureMusicOrderSchema(db);await api.ensureSubscriptionPlaybackSchema(db);
 sql.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,account_forfeited INTEGER);INSERT INTO users VALUES(1,'user',1,0),(2,'admin',1,0)");
 const ready={version:1,ready:true,members:[{id:'a',share_bps:6000,recipient_user_id:77,consent:'accepted',active_recipient:1},{id:'b',share_bps:4000,recipient_user_id:88,consent:'accepted',active_recipient:1}]};
 assert.deepEqual(api.allocateMusicBudget(1,[{id:'b',includedMs:1},{id:'a',includedMs:1}]).map(r=>r.budgetKrw),[0,1]);
 for(const bad of [[{id:'x',includedMs:0}],[{id:'x',includedMs:1},{id:'x',includedMs:2}]])assert.throws(()=>api.allocateMusicBudget(10,bad));
 await receipt(1);await receipt(2,'test');await receipt(3);
 let r=await api.reviewMusicSettlement(db,order(1),end);assert.equal(r.summary.heldKrw,1330);assert(r.blockingReasons.includes('NO_INCLUDED_LISTENING_BUDGET_HELD'));
 await usage('first','ent-1',10,1000,ready,5000);await usage('unresolved','ent-1',11,1000,{creator_id:77});await usage('missing','ent-1',12,1000);
 await usage('overage-only','ent-1',13,0,ready,1000);
 const before=sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n;
 r=await api.reviewMusicSettlement(db,order(1),start+1000);assert.equal(r.tracks.length,3);assert.equal(r.summary.includedMs,3000);assert.equal(r.summary.rightsBudgetKrw,1330);assert.equal(r.summary.proposedRecipientKrw,444);assert.equal(r.summary.heldKrw,886);assert.equal(r.tracks[0].proposedRecipients.reduce((n,m)=>n+m.budgetKrw,0),444);assert(r.blockingReasons.includes('BILLING_PERIOD_NOT_FINISHED'));assert(r.blockingReasons.includes('RIGHTS_VERIFICATION_REQUIRED'));assert.equal(r.payoutEnabled,false);
 assert.equal(await api.reviewMusicSettlement(db,order(2),end),null);assert.equal((await api.listMusicSettlementReceipts(db)).receipts.length,2);
 await assert.rejects(api.listMusicSettlementReceipts(db,1000),/INVALID_MUSIC_REVIEW_PAGE/);
 sql.exec("UPDATE v5_music_entitlements SET status='cancelled' WHERE id='ent-1'");r=await api.reviewMusicSettlement(db,order(1),end);assert(!r.blockingReasons.includes('BILLING_PERIOD_NOT_FINISHED'));assert(r.blockingReasons.includes('CANCELLED_ENTITLEMENT_REVIEW_REQUIRED'));assert(r.blockingReasons.includes('PAYMENT_AND_REFUND_RECONCILIATION_REQUIRED'));
 await usage('invalid-shares','ent-3',14,1000,{...ready,members:[{...ready.members[0],share_bps:10000,recipient_user_id:0}]});assert.equal((await api.reviewMusicSettlement(db,order(3),end)).summary.heldKrw,1330);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n,before);assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_entries').get().n,0);assert.equal(sql.prepare("SELECT COUNT(*) n FROM v5_music_usage_rights WHERE settlement_status<>'unsettled'").get().n,0);
 const env={DB:db,JWT_SECRET:'review-fixture'},admin=await api.makeAccessToken(2,env.JWT_SECRET),user=await api.makeAccessToken(1,env.JWT_SECRET);
 assert.equal((await api.admin.request('/music-subscription-settlements',{},env)).status,403);
 assert.equal((await api.admin.request('/music-subscription-settlements',{headers:{Authorization:'Bearer '+user}},env)).status,403);
 const req=p=>api.admin.request(p,{headers:{Authorization:'Bearer '+admin}},env);
 assert.equal((await req('/music-subscription-settlements')).status,200);assert.equal((await req('/music-subscription-settlements?limit=NaN')).status,400);assert.equal((await req('/music-subscription-settlements/bad')).status,400);assert.equal((await req('/music-subscription-settlements/'+order(2))).status,404);
 const response=await req('/music-subscription-settlements/'+order(1));assert.equal(response.status,200);const detail=await response.json();assert.equal(detail.payoutEnabled,false);assert(!JSON.stringify(detail).includes('pg-1'));
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n,before);
 console.log('PASS actual SQLite/HTTP: admin-only live receipt review, exact 70:30 KRW budget, deterministic rounding, included-only weights, unresolved rights held, no listening held, cancellation/refund blocks, invalid shares held, test isolation, bounded pagination, no payment key leak, no ledger or payout writes');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
