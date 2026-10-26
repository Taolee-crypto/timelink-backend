const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-subscription-meter-'));
buildSync({stdin:{contents:"export * from './src/v5-subscription-meter';export * from './src/economy-ledger';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
const api=require(path.join(temp,'api.cjs')),sql=new DatabaseSync(':memory:');
sql.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));sql.exec("UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL'");
const db={prepare(q){let args=[];const s={q,bind(...a){args=a;return s},async first(){return sql.prepare(q).get(...args)||null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){const r=sql.prepare(q).run(...args);return {meta:{changes:Number(r.changes)}}}};return s},async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const out=[];for(const s of statements)out.push(/^\s*(SELECT|WITH|PRAGMA)/i.test(s.q)?await s.all():await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const H=3600000,start=Date.parse('2026-10-26T00:00:00Z'),now=Date.parse('2026-11-03T00:00:00Z');
async function grant(id,user,level=1,mode='live',zone='Asia/Seoul',begins=start,ends=now+H){
 const e={id,userId:user,level,timezone:zone,startsAtMs:begins,endsAtMs:ends,paymentReference:'receipt:'+id,paymentMode:mode,status:'active'};
 api.validateMusicEntitlement(e);await db.prepare('INSERT INTO v5_music_entitlements VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user,level,zone,begins,ends,e.paymentReference,mode,e.status).run();return e;
}
const interval=(key,from,to,user=1)=>({usageKey:key,userId:user,fileId:10,sessionId:'session:'+user,startsAtMs:from,endsAtMs:to});
async function pay(plan,i,options={}){
 const wallet=await api.ensureLedgerAccount(db,'user',i.userId,'TL','wallet_paid');
 const creator=await api.ensureLedgerAccount(db,'user',77,'TL','wallet_paid'),platform=await api.ensureLedgerAccount(db,'platform','timelink','TL','subscription_overage_paid');
 const creatorPart=Math.round(plan.debitAtoms*.7);
 return api.postLedgerTransaction(db,{idempotencyKey:plan.overageIdempotencyKey,transactionType:'daily_free_overage',source:'verified_subscription_playback',referenceType:'music_usage',referenceId:i.usageKey,actorUserId:String(i.userId),metadata:{overage_atoms:options.wrongAmount?plan.debitAtoms+1:plan.debitAtoms},lines:[{accountId:wallet,assetCode:'TL',amountAtoms:-plan.debitAtoms},{accountId:creator,assetCode:'TL',amountAtoms:creatorPart},{accountId:platform,assetCode:'TL',amountAtoms:plan.debitAtoms-creatorPart}],atomicStatements:plan.statements});
}
async function main(){
 await api.ensureSubscriptionMeterSchema(db);assert.equal((await api.readDailyMusicAllowance(db,1,start)).active,false);
 await grant('test-only',2,24,'test');assert.equal(await api.readActiveMusicEntitlement(db,2,start),null);
 await grant('live-one-hour',1);const first=interval('included-hour',start,start+H),p=await api.prepareDailyMusicUsage(db,first,now);assert.equal(p.includedMs,H);assert.equal(p.debitAtoms,0);await db.batch(p.statements);
 let allowance=await api.readDailyMusicAllowance(db,1,start+H);assert.equal(allowance.remainingIncludedMs,0);assert.equal(allowance.usedMs,H);assert.equal(allowance.subscriptionCheckoutEnabled,false);
 const replay=await api.prepareDailyMusicUsage(db,first,now);assert.equal(replay.replayed,true);assert.equal(replay.statements.length,0);
 await assert.rejects(api.prepareDailyMusicUsage(db,{...first,fileId:11},now),/IDEMPOTENCY_CONFLICT/);
 const over=interval('over-ten-minutes',start+H,start+H+600000),op=await api.prepareDailyMusicUsage(db,over,now);assert.equal(op.overageMs,600000);assert.equal(op.debitAtoms,600*10000);
 await assert.rejects(db.batch(op.statements));assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_usage_events').get().n,1);
 const wallet=await api.ensureLedgerAccount(db,'user',1,'TL','wallet_paid');sql.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').run(1000*10000,wallet);
 const before=sql.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n;
 await assert.rejects(pay(op,over,{wrongAmount:true}));assert.equal(sql.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n,before);assert.equal(sql.prepare('SELECT COUNT(*) n FROM v3_economy_transactions').get().n,0);
 await pay(op,over);assert.equal(sql.prepare('SELECT available_atoms n FROM v3_economy_balances WHERE account_id=?').get(wallet).n,400*10000);
 allowance=await api.readDailyMusicAllowance(db,1,start+H);assert.equal(allowance.overageMs,600000);assert.equal(allowance.usedMs,H+600000);
 const secondDay=start+15*H;assert.equal((await api.readDailyMusicAllowance(db,1,secondDay)).remainingIncludedMs,H);
 const overlap=await api.prepareDailyMusicUsage(db,interval('overlap',start+100,start+200),now);await assert.rejects(db.batch(overlap.statements));
 const casA=await api.prepareDailyMusicUsage(db,interval('cas-a',secondDay,secondDay+1000),now),casB=await api.prepareDailyMusicUsage(db,interval('cas-b',secondDay+1000,secondDay+2000),now);
 await db.batch(casA.statements);await assert.rejects(db.batch(casB.statements));const retry=await api.prepareDailyMusicUsage(db,interval('cas-b',secondDay+1000,secondDay+2000),now);await db.batch(retry.statements);
 await assert.rejects(api.prepareDailyMusicUsage(db,interval('midnight',secondDay-1000,secondDay+1000),now),/SPLIT_AT_LOCAL_MIDNIGHT/);
 await assert.rejects(api.prepareDailyMusicUsage(db,interval('future',now,now+1000),now),/INVALID_VERIFIED/);
 await grant('cancel-before-use',3);const cancel=await api.prepareDailyMusicUsage(db,interval('cancelled',start,start+1000,3),now);sql.prepare("UPDATE v5_music_entitlements SET status='cancelled' WHERE id='cancel-before-use'").run();await assert.rejects(db.batch(cancel.statements));
 const dstStart=Date.parse('2026-11-01T04:00:00Z'),dstEnd=Date.parse('2026-11-02T05:00:00Z');await grant('dst-long-day',4,24,'live','America/New_York',dstStart,dstEnd);
 const dst=await api.prepareDailyMusicUsage(db,interval('dst-25-hours',dstStart,dstEnd,4),now);assert.equal(dst.includedMs,24*H);assert.equal(dst.overageMs,H);assert.equal(dst.debitAtoms,3600*10000);
 await assert.rejects(db.batch(dst.statements));
 await grant('overlapping-subscription',1,2);await assert.rejects(api.readActiveMusicEntitlement(db,1,start),/OVERLAPPING_MUSIC_ENTITLEMENTS/);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_usage_events').get().n,4);
 assert.equal(sql.prepare('SELECT SUM(available_atoms) n FROM v3_economy_balances').get().n,before);
 console.log('PASS actual SQLite: TL-1 included hour, exact 600TL overage, atomic quota/payment rollback, replay, evidence conflict, cross-session overlap, CAS retry, local midnight reset, cancellation, live/test isolation and 25-hour DST day');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
