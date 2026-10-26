import {readDailyMusicAllowance,readActiveMusicEntitlement,prepareDailyMusicUsage,subscriptionLocalDay,ensureSubscriptionMeterSchema} from './v5-subscription-meter';
import {getLedgerWallet,settleTrackPlayback,atomsToTl} from './economy-ledger';
import {readCreatorSplit} from './creator-split-policy';
export async function ensureSubscriptionPlaybackSchema(db:D1Database){
 await ensureSubscriptionMeterSchema(db);
 await db.prepare(`CREATE TABLE IF NOT EXISTS v5_music_player_sessions(session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,file_id INTEGER NOT NULL,entitlement_id TEXT NOT NULL,duration_ms INTEGER NOT NULL,anchor_ms INTEGER NOT NULL,last_end_ms INTEGER NOT NULL,reported_ms INTEGER NOT NULL DEFAULT 0,charged_atoms INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),version INTEGER NOT NULL DEFAULT 0)`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS v5_music_usage_rights(usage_key TEXT PRIMARY KEY,file_id INTEGER NOT NULL,creator_id INTEGER NOT NULL,split_version INTEGER,split_snapshot TEXT NOT NULL,settlement_status TEXT NOT NULL DEFAULT 'unsettled')`).run();
}
export async function subscriptionSessionExists(db:D1Database,sessionId:string,userId:number,fileId:number){
 try{return !!await db.prepare('SELECT 1 FROM v5_music_player_sessions WHERE session_id=? AND user_id=? AND file_id=?').bind(sessionId,userId,fileId).first();}
 catch(error){if(/no such table.*v5_music_player_sessions/i.test(String(error)))return false;throw error;}
}
export async function subscriptionPreflight(db:D1Database,userId:number,nowMs=Date.now()){
 const allowance=await readDailyMusicAllowance(db,userId,nowMs);if(!allowance.active)return null;
 const wallet=await walletAtoms(db,userId);
 return {billing_mode:'subscription' as const,remaining_included_ms:allowance.remainingIncludedMs,wallet_tl:atomsToTl(wallet),can_play:allowance.remainingIncludedMs>0||wallet>=10,timezone:allowance.timezone,entitlement_id:allowance.entitlementId};
}
async function walletAtoms(db:D1Database,userId:number){
 const rows=await getLedgerWallet(db,userId) as {asset_code:string;bucket:string;available_atoms:number}[];
 return rows.filter(r=>r.asset_code==='TL'&&['wallet_paid','wallet_ad','wallet_bonus'].includes(r.bucket)).reduce((n,r)=>n+Number(r.available_atoms),0);
}
export async function beginSubscriptionSession(db:D1Database,input:{sessionId:string;userId:number;fileId:number;durationMs:number},nowMs=Date.now()){
 if(!/^[A-Za-z0-9_-]{12,100}$/.test(input.sessionId)||!Number.isSafeInteger(input.durationMs)||input.durationMs<=0)throw Error('INVALID_SUBSCRIPTION_PLAYER_SESSION');
 const e=await readActiveMusicEntitlement(db,input.userId,nowMs);if(!e)throw Error('ACTIVE_SUBSCRIPTION_REQUIRED');
 await ensureSubscriptionPlaybackSchema(db);
 await db.prepare(`INSERT OR IGNORE INTO v5_music_player_sessions(session_id,user_id,file_id,entitlement_id,duration_ms,anchor_ms,last_end_ms) VALUES(?,?,?,?,?,?,?)`).bind(input.sessionId,input.userId,input.fileId,e.id,input.durationMs,nowMs,nowMs).run();
 const row=await db.prepare('SELECT user_id,file_id,entitlement_id,duration_ms,closed FROM v5_music_player_sessions WHERE session_id=?').bind(input.sessionId).first<{user_id:number;file_id:number;entitlement_id:string;duration_ms:number;closed:number}>();
 if(!row||row.user_id!==input.userId||row.file_id!==input.fileId||row.entitlement_id!==e.id||row.duration_ms!==input.durationMs||row.closed)throw Error('SUBSCRIPTION_SESSION_BINDING_CONFLICT');
}
/** Reported media time is bounded by server elapsed time. This constrains fast
 * forward and overlap; it is NOT an independent proof that audio was audible.
 * Delayed reports are attributed to the most recent server reporting window.
 */
export function splitMusicReportingWindow(start:number,end:number,zone:string){
 const chunks:{start:number;end:number}[]=[];
 while(start<end){
  const day=subscriptionLocalDay(start,zone);let stop=end;
  if(subscriptionLocalDay(end-1,zone)!==day){let lo=start+1,hi=end;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(subscriptionLocalDay(mid,zone)===day)lo=mid+1;else hi=mid;}stop=lo;}
  chunks.push({start,end:stop});start=stop;if(chunks.length>4)throw Error('SUBSCRIPTION_REPORT_WINDOW_TOO_LONG');
 }
 return chunks;
}
interface PlayerSession {session_id:string;user_id:number;file_id:number;entitlement_id:string;duration_ms:number;anchor_ms:number;last_end_ms:number;reported_ms:number;charged_atoms:number;closed:number;version:number;}
export async function meterSubscriptionPlayback(db:D1Database,input:{sessionId:string;userId:number;fileId:number;creatorId:number;shareId:string;playedMs:number},nowMs=Date.now()){
 if(!Number.isSafeInteger(input.playedMs)||input.playedMs<0)throw Error('INVALID_SUBSCRIPTION_PLAYED_MS');
 await ensureSubscriptionPlaybackSchema(db);
 const s=await db.prepare('SELECT * FROM v5_music_player_sessions WHERE session_id=? AND user_id=? AND file_id=?').bind(input.sessionId,input.userId,input.fileId).first<PlayerSession>();
 if(!s||s.closed)throw Error('SUBSCRIPTION_SESSION_CLOSED_OR_MISSING');
 const target=Math.min(input.playedMs,s.duration_ms);
 if(target<=s.reported_ms)return {ok:true,billing_mode:'subscription',billed_seconds:s.reported_ms/1000,charged_tl:atomsToTl(s.charged_atoms),delta_tl:0,wallet_tl:atomsToTl(await walletAtoms(db,input.userId)),stop:false};
 const e=await readActiveMusicEntitlement(db,input.userId,s.last_end_ms);if(!e||e.id!==s.entitlement_id)throw Error('SUBSCRIPTION_ENTITLEMENT_CHANGED');
 const delta=Math.min(target-s.reported_ms,Math.max(0,nowMs-s.last_end_ms));
 if(delta<=0)return {ok:true,billing_mode:'subscription',billed_seconds:s.reported_ms/1000,charged_tl:atomsToTl(s.charged_atoms),delta_tl:0,wallet_tl:atomsToTl(await walletAtoms(db,input.userId)),stop:false};
 const start=Math.max(s.last_end_ms,nowMs-delta),end=Math.min(nowMs,e.endsAtMs);
 if(start>=end)throw Error('SUBSCRIPTION_ENTITLEMENT_EXPIRED');
 let addedAtoms=0,includedMs=0,stop=end<nowMs;
 const split=await readCreatorSplit(db,input.fileId);
 for(const chunk of splitMusicReportingWindow(start,end,e.timezone)){
  const allowance=await readDailyMusicAllowance(db,input.userId,chunk.start);if(!allowance.active)throw Error('SUBSCRIPTION_ENTITLEMENT_EXPIRED');
  const available=await walletAtoms(db,input.userId);
  const fundable=allowance.remainingIncludedMs+Math.floor(available/10);
  const duration=Math.min(chunk.end-chunk.start,fundable);
  if(duration<=0){stop=true;break;}
  const finish=chunk.start+duration,usageKey='sp:'+input.sessionId+':'+s.reported_ms+':'+duration;
  const plan=await prepareDailyMusicUsage(db,{usageKey,userId:input.userId,fileId:input.fileId,sessionId:input.sessionId,startsAtMs:chunk.start,endsAtMs:finish},nowMs);
  if(plan.replayed)throw Error('SUBSCRIPTION_SESSION_CHECKPOINT_MISMATCH');
  const statements=[...plan.statements,
   ...(split?[db.prepare(`SELECT CASE WHEN (SELECT version FROM v5_creator_split_heads WHERE file_id=?)=? THEN 1 ELSE json_extract('RIGHTS_SNAPSHOT_VERSION_CONFLICT','$') END`).bind(input.fileId,split.version)]:[]),
   db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_music_player_sessions WHERE session_id=? AND user_id=? AND version=? AND reported_ms=? AND closed=0) THEN 1 ELSE json_extract('SUBSCRIPTION_SESSION_VERSION_CONFLICT','$') END`).bind(input.sessionId,input.userId,s.version,s.reported_ms),
   db.prepare('INSERT INTO v5_music_usage_rights(usage_key,file_id,creator_id,split_version,split_snapshot) VALUES(?,?,?,?,?)').bind(usageKey,input.fileId,input.creatorId,split?.version??null,JSON.stringify(split||{creator_id:input.creatorId,rights_verification:'pending_settlement_review'})),
   db.prepare('UPDATE v5_music_player_sessions SET reported_ms=reported_ms+?,charged_atoms=charged_atoms+?,last_end_ms=?,version=version+1 WHERE session_id=? AND user_id=? AND version=? AND closed=0').bind(duration,plan.debitAtoms,finish,input.sessionId,input.userId,s.version),
  ];
  if(plan.debitAtoms>0)await settleTrackPlayback(db,{userId:input.userId,creatorId:input.creatorId,shareId:input.shareId,fileId:input.fileId,playedSeconds:plan.overageMs/1000,amountAtoms:plan.debitAtoms,idempotencyKey:plan.overageIdempotencyKey,walletUsageKey:usageKey,atomicStatements:statements});
  else await db.batch(statements);
  s.reported_ms+=duration;s.charged_atoms+=plan.debitAtoms;s.version++;s.last_end_ms=finish;addedAtoms+=plan.debitAtoms;includedMs+=plan.includedMs;
  if(finish<chunk.end){stop=true;break;}
 }
 const allowance=await readDailyMusicAllowance(db,input.userId,Math.min(nowMs,e.endsAtMs-1));
 return {ok:true,billing_mode:'subscription',billed_seconds:s.reported_ms/1000,charged_tl:atomsToTl(s.charged_atoms),delta_tl:atomsToTl(addedAtoms),subscription_included_ms:includedMs,subscription_remaining_ms:allowance.active?allowance.remainingIncludedMs:0,wallet_tl:atomsToTl(await walletAtoms(db,input.userId)),stop};
}
export async function closeSubscriptionSession(db:D1Database,sessionId:string,userId:number,fileId:number){
 await db.prepare('UPDATE v5_music_player_sessions SET closed=1,version=version+1 WHERE session_id=? AND user_id=? AND file_id=? AND closed=0').bind(sessionId,userId,fileId).run();
 return {ok:true,billing_mode:'subscription',refunded_tl:0,platform_tl:0};
}
