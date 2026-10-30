import {readRewardPolicy} from './v5-reward-policy';

/** Purchased listening time is an access entitlement, never a TL balance.
 * Sandbox orders grant sandbox listening access only, with no monetary rewards.
 * The server bounds reports by elapsed time and commits usage + contribution once.
 */
export async function ensureTimeFreeSchema(db:D1Database){
 const tables=await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('v5_time_free_passes','v5_time_free_sessions','v5_time_free_usage')").first<{n:number}>();
 if(Number(tables?.n)===3)return;
 for(const sql of [
  `CREATE TABLE IF NOT EXISTS v5_time_free_passes(quote_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,granted_ms INTEGER NOT NULL CHECK(granted_ms>0),used_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_ms>=0 AND used_ms<=granted_ms),payment_mode TEXT NOT NULL CHECK(payment_mode IN ('test','live')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_v5_time_free_user ON v5_time_free_passes(user_id,status)`,
  `CREATE TABLE IF NOT EXISTS v5_time_free_sessions(session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,file_id INTEGER NOT NULL,duration_ms INTEGER NOT NULL,last_end_ms INTEGER NOT NULL,reported_ms INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS v5_time_free_usage(usage_key TEXT PRIMARY KEY,session_id TEXT NOT NULL,quote_id TEXT NOT NULL,user_id INTEGER NOT NULL,file_id INTEGER NOT NULL,starts_at_ms INTEGER NOT NULL,ends_at_ms INTEGER NOT NULL,played_ms INTEGER NOT NULL CHECK(played_ms>0),payment_mode TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_v5_time_free_overlap ON v5_time_free_usage(user_id,starts_at_ms,ends_at_ms)`,
 ])await db.prepare(sql).run();
}
export function timeFreeGrantStatement(db:D1Database,quoteId:string,userId:number,seconds:number,mode:'test'|'live'){
 if(!quoteId||!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(seconds)||seconds<1||seconds>720*3600||!['test','live'].includes(mode))throw Error('INVALID_TIME_FREE_GRANT');
 return db.prepare(`INSERT OR IGNORE INTO v5_time_free_passes(quote_id,user_id,granted_ms,payment_mode) VALUES(?,?,?,?)`).bind(quoteId,userId,seconds*1000,mode);
}
/** Recover already-completed sandbox purchases without changing old wallets.
 * Only server receipts in terminal paid states qualify; quoted/pending do not.
 */
async function restoreCompletedTimeOrders(db:D1Database,userId:number){
 const exists=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v5_shareplace_time_test_orders'").first();
 if(exists)await db.prepare(`INSERT OR IGNORE INTO v5_time_free_passes(quote_id,user_id,granted_ms,payment_mode)
 SELECT quote_id,user_id,seconds*1000,'test' FROM v5_shareplace_time_test_orders WHERE user_id=? AND status IN ('test_paid','toss_paid') AND seconds BETWEEN 1 AND 2592000`).bind(userId).run();
}
export async function timeFreePreflight(db:D1Database,userId:number){
 await ensureTimeFreeSchema(db);await restoreCompletedTimeOrders(db,userId);
 const remaining=await remainingTimeFreeMs(db,userId);if(remaining<=0)return null;
 return {billing_mode:'time_free' as const,can_play:true,remaining_included_ms:remaining,time_free_remaining_ms:remaining,required_tl:0,charged_tl:0,tl_reward:0,contribution_only:true};
}
async function remainingTimeFreeMs(db:D1Database,userId:number){
 const row=await db.prepare("SELECT COALESCE(SUM(granted_ms-used_ms),0) remaining FROM v5_time_free_passes WHERE user_id=? AND status='active'").bind(userId).first<{remaining:number}>();
 return Number(row?.remaining||0);
}
async function timeFreeRewardRules(db:D1Database){
 // Use the shared, backward-compatible policy reader. Existing operator
 // policies predate newly added referral rules and intentionally lack those
 // keys; validating their raw JSON as a full policy stops TIME FREE meters.
 // The reader fills only absent fields from safe defaults, validates the
 // complete policy and never alters the administrator's stored JSON.
 return (await readRewardPolicy(db)).rules;
}
export async function beginTimeFreeSession(db:D1Database,input:{sessionId:string;userId:number;fileId:number;durationMs:number},nowMs=Date.now()){
 if(!/^tf_[A-Za-z0-9_-]{9,97}$/.test(input.sessionId)||!Number.isSafeInteger(input.durationMs)||input.durationMs<=0||!Number.isSafeInteger(nowMs))throw Error('INVALID_TIME_FREE_SESSION');
 if(!await timeFreePreflight(db,input.userId))throw Error('TIME_FREE_EXHAUSTED');
 await db.prepare('INSERT OR IGNORE INTO v5_time_free_sessions(session_id,user_id,file_id,duration_ms,last_end_ms) VALUES(?,?,?,?,?)').bind(input.sessionId,input.userId,input.fileId,input.durationMs,nowMs).run();
 const s=await db.prepare('SELECT * FROM v5_time_free_sessions WHERE session_id=?').bind(input.sessionId).first<Session>();
 if(!s||s.user_id!==input.userId||s.file_id!==input.fileId||s.duration_ms!==input.durationMs||s.closed)throw Error('TIME_FREE_SESSION_BINDING_CONFLICT');
}
interface Session {session_id:string;user_id:number;file_id:number;duration_ms:number;last_end_ms:number;reported_ms:number;closed:number;version:number;}
interface Pass {quote_id:string;granted_ms:number;used_ms:number;version:number;payment_mode:'test'|'live';}
export async function timeFreeSessionExists(db:D1Database,sessionId:string,userId:number,fileId:number){
 await ensureTimeFreeSchema(db);
 return !!await db.prepare('SELECT 1 FROM v5_time_free_sessions WHERE session_id=? AND user_id=? AND file_id=?').bind(sessionId,userId,fileId).first();
}
export async function meterTimeFreePlayback(db:D1Database,input:{sessionId:string;userId:number;fileId:number;playedMs:number},nowMs=Date.now()){
 if(!Number.isSafeInteger(input.playedMs)||input.playedMs<0||!Number.isSafeInteger(nowMs))throw Error('INVALID_TIME_FREE_PLAYED_MS');
 const s=await db.prepare('SELECT * FROM v5_time_free_sessions WHERE session_id=? AND user_id=? AND file_id=?').bind(input.sessionId,input.userId,input.fileId).first<Session>();
 if(!s||s.closed)throw Error('TIME_FREE_SESSION_CLOSED_OR_MISSING');
 const target=Math.min(input.playedMs,s.duration_ms);
 let remaining=await remainingTimeFreeMs(db,input.userId);
 const response=(delta:number)=>({ok:true,billing_mode:'time_free',billed_seconds:s.reported_ms/1000,charged_tl:0,delta_tl:0,tl_reward:0,contribution_only:true,contribution_seconds:delta/1000,time_free_remaining_ms:remaining,stop:remaining<=0&&s.reported_ms<s.duration_ms});
 if(target<=s.reported_ms)return response(0);
 const delta=Math.min(target-s.reported_ms,Math.max(0,nowMs-s.last_end_ms),remaining);
 if(delta<=0)return response(0);
 // Pauses do not spend the pass. Attribute a delayed audible report to the
 // most recent server interval, preventing parallel sessions from double use.
 let cursor=nowMs-delta,left=delta;
 const passes=(await db.prepare("SELECT * FROM v5_time_free_passes WHERE user_id=? AND status='active' AND used_ms<granted_ms ORDER BY quote_id").bind(input.userId).all<Pass>()).results;
 const statements:D1PreparedStatement[]=[
  db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_time_free_sessions WHERE session_id=? AND user_id=? AND file_id=? AND version=? AND reported_ms=? AND closed=0) THEN 1 ELSE json_extract('TIME_FREE_SESSION_CONFLICT','$') END`).bind(input.sessionId,input.userId,input.fileId,s.version,s.reported_ms),
  db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM v5_time_free_usage WHERE user_id=? AND starts_at_ms<? AND ends_at_ms>?) THEN 1 ELSE json_extract('TIME_FREE_OVERLAP','$') END`).bind(input.userId,nowMs,cursor),
 ];
 for(const p of passes){
  if(left<=0)break;
  const used=Math.min(left,p.granted_ms-p.used_ms),usageKey=input.sessionId+':'+s.reported_ms+':'+p.quote_id;
  statements.push(
   db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_time_free_passes WHERE quote_id=? AND user_id=? AND status='active' AND version=? AND used_ms=? AND granted_ms-used_ms>=?) THEN 1 ELSE json_extract('TIME_FREE_PASS_CONFLICT','$') END`).bind(p.quote_id,input.userId,p.version,p.used_ms,used),
   db.prepare('UPDATE v5_time_free_passes SET used_ms=used_ms+?,version=version+1 WHERE quote_id=? AND user_id=? AND version=?').bind(used,p.quote_id,input.userId,p.version),
   db.prepare('INSERT INTO v5_time_free_usage VALUES(?,?,?,?,?,?,?,?,?)').bind(usageKey,input.sessionId,p.quote_id,input.userId,input.fileId,cursor,cursor+used,used,p.payment_mode),
  );cursor+=used;left-=used;
 }
 if(left!==0)throw Error('TIME_FREE_BALANCE_CHANGED');
 // Keep the established administrator-controlled listening weights. No TL,
 // TLC, spend contribution, track-pool debit or creator payment is generated.
 const rules=await timeFreeRewardRules(db),seconds=delta/1000;
 const month="datetime(? / 1000, 'unixepoch', 'start of month')";
 const total=`(SELECT COALESCE(SUM(seconds),0) FROM poc_logs WHERE user_id=? AND created_at>=${month})`;
 const gain=`(MIN(?,${total}/3600/?)-MIN(?,MAX(0,${total}-?)/3600/?))*?*?`;
 const gainArgs=[rules.listen_cap,input.userId,nowMs,rules.listen_target,rules.listen_cap,input.userId,nowMs,seconds,rules.listen_target,rules.weight_listen,rules.poc_scale];
 statements.push(
  db.prepare("INSERT INTO poc_logs(user_id,mode,seconds,tl_spent,poc_gained,created_at) VALUES(?,'time_free',?,0,0,datetime(? / 1000,'unixepoch'))").bind(input.userId,seconds,nowMs),
  db.prepare(`UPDATE users SET poc_index=MIN(?,MAX(?,COALESCE(poc_index,?)+${gain})) WHERE id=?`).bind(rules.poc_max,rules.poc_min,rules.poc_min,...gainArgs,input.userId),
  db.prepare('UPDATE v5_time_free_sessions SET reported_ms=reported_ms+?,last_end_ms=?,version=version+1 WHERE session_id=? AND user_id=? AND version=?').bind(delta,nowMs,input.sessionId,input.userId,s.version),
 );
 await db.batch(statements);s.reported_ms+=delta;remaining-=delta;return response(delta);
}
export async function closeTimeFreeSession(db:D1Database,sessionId:string,userId:number,fileId:number){
 await db.prepare('UPDATE v5_time_free_sessions SET closed=1,version=version+1 WHERE session_id=? AND user_id=? AND file_id=? AND closed=0').bind(sessionId,userId,fileId).run();
 return {ok:true,billing_mode:'time_free',charged_tl:0,tl_reward:0,refunded_tl:0,platform_tl:0};
}
