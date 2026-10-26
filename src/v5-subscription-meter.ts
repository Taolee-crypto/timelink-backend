import {dailyFreeProduct} from './v5-daily-free-policy';
/** Subscription metering core. Server-only: do not pass unverified browser time,
 * caller-selected entitlement or payment claims into these functions.
 * This module does not create a subscription or activate subscription checkout.
 */
export interface MusicEntitlement {
 id:string; userId:number; level:number; timezone:string; startsAtMs:number; endsAtMs:number;
 paymentReference:string; paymentMode:'live'|'test'; status:'active'|'cancelled';
}
export interface VerifiedListeningInterval {
 usageKey:string; userId:number; fileId:number; sessionId:string;
 startsAtMs:number; endsAtMs:number;
}
function safeInt(n:number,min=0){if(!Number.isSafeInteger(n)||n<min)throw Error('INVALID_SUBSCRIPTION_INTEGER');}
function key(s:string){if(typeof s!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(s))throw Error('INVALID_SUBSCRIPTION_KEY');}
export function subscriptionLocalDay(epochMs:number,timezone:string){
 safeInt(epochMs);if(typeof timezone!=='string'||timezone.length>100)throw Error('INVALID_SUBSCRIPTION_TIMEZONE');
 try{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(epochMs));
  const get=(type:string)=>parts.find(p=>p.type===type)?.value;
  return get('year')+'-'+get('month')+'-'+get('day');
 }catch{throw Error('INVALID_SUBSCRIPTION_TIMEZONE');}
}
export function validateMusicEntitlement(e:MusicEntitlement){
 key(e.id);safeInt(e.userId,1);dailyFreeProduct(e.level);safeInt(e.startsAtMs);safeInt(e.endsAtMs,1);
 if(e.endsAtMs<=e.startsAtMs||!e.paymentReference||typeof e.paymentReference!=='string'||e.paymentReference.length>200||
 !['live','test'].includes(e.paymentMode)||!['active','cancelled'].includes(e.status))throw Error('INVALID_MUSIC_ENTITLEMENT');
 subscriptionLocalDay(e.startsAtMs,e.timezone);
}
export async function ensureSubscriptionMeterSchema(db:D1Database){
 for(const sql of [
  `CREATE TABLE IF NOT EXISTS v5_music_entitlements(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 24),timezone TEXT NOT NULL,starts_at_ms INTEGER NOT NULL,ends_at_ms INTEGER NOT NULL,payment_reference TEXT NOT NULL UNIQUE,payment_mode TEXT NOT NULL CHECK(payment_mode IN ('live','test')),status TEXT NOT NULL CHECK(status IN ('active','cancelled')),CHECK(ends_at_ms>starts_at_ms))`,
  `CREATE INDEX IF NOT EXISTS idx_v5_music_entitlement_user ON v5_music_entitlements(user_id,status,payment_mode,starts_at_ms,ends_at_ms)`,
  `CREATE TABLE IF NOT EXISTS v5_music_daily_usage(user_id INTEGER NOT NULL,local_day TEXT NOT NULL,timezone TEXT NOT NULL,used_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_ms>=0),included_used_ms INTEGER NOT NULL DEFAULT 0 CHECK(included_used_ms>=0),overage_ms INTEGER NOT NULL DEFAULT 0 CHECK(overage_ms>=0),version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,local_day))`,
  `CREATE TABLE IF NOT EXISTS v5_music_usage_events(usage_key TEXT PRIMARY KEY,user_id INTEGER NOT NULL,file_id INTEGER NOT NULL,session_id TEXT NOT NULL,entitlement_id TEXT NOT NULL,local_day TEXT NOT NULL,timezone TEXT NOT NULL,starts_at_ms INTEGER NOT NULL,ends_at_ms INTEGER NOT NULL,included_ms INTEGER NOT NULL,overage_ms INTEGER NOT NULL,overage_atoms INTEGER NOT NULL,expected_daily_version INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),CHECK(ends_at_ms>starts_at_ms),CHECK(included_ms>=0 AND overage_ms>=0 AND overage_atoms>=0),CHECK(included_ms+overage_ms=ends_at_ms-starts_at_ms))`,
  `CREATE INDEX IF NOT EXISTS idx_v5_music_usage_overlap ON v5_music_usage_events(user_id,starts_at_ms,ends_at_ms)`,
 ])await db.prepare(sql).run();
}
interface EntitlementRow {id:string;user_id:number;level:number;timezone:string;starts_at_ms:number;ends_at_ms:number;payment_reference:string;payment_mode:'live'|'test';status:'active'|'cancelled';}
function entitlement(row:EntitlementRow):MusicEntitlement{return {id:row.id,userId:row.user_id,level:row.level,timezone:row.timezone,startsAtMs:row.starts_at_ms,endsAtMs:row.ends_at_ms,paymentReference:row.payment_reference,paymentMode:row.payment_mode,status:row.status};}
export async function readActiveMusicEntitlement(db:D1Database,userId:number,atMs=Date.now()){
 safeInt(userId,1);safeInt(atMs);await ensureSubscriptionMeterSchema(db);
 const rows=(await db.prepare(`SELECT * FROM v5_music_entitlements WHERE user_id=? AND status='active' AND payment_mode='live' AND starts_at_ms<=? AND ends_at_ms>? ORDER BY starts_at_ms DESC LIMIT 2`).bind(userId,atMs,atMs).all<EntitlementRow>()).results;
 if(rows.length>1)throw Error('OVERLAPPING_MUSIC_ENTITLEMENTS');
 if(!rows.length)return null;const e=entitlement(rows[0]);validateMusicEntitlement(e);return e;
}
export async function readDailyMusicAllowance(db:D1Database,userId:number,nowMs=Date.now()){
 const e=await readActiveMusicEntitlement(db,userId,nowMs);
 if(!e)return {active:false as const,subscriptionCheckoutEnabled:false};
 const day=subscriptionLocalDay(nowMs,e.timezone),product=dailyFreeProduct(e.level);
 const usage=await db.prepare('SELECT used_ms,included_used_ms,overage_ms,version,timezone FROM v5_music_daily_usage WHERE user_id=? AND local_day=?').bind(userId,day).first<{used_ms:number;included_used_ms:number;overage_ms:number;version:number;timezone:string}>();
 if(usage&&usage.timezone!==e.timezone)throw Error('SUBSCRIPTION_TIMEZONE_CHANGE_REVIEW_REQUIRED');
 return {active:true as const,subscriptionCheckoutEnabled:false,entitlementId:e.id,product:product.code,timezone:e.timezone,localDay:day,expiresAtMs:e.endsAtMs,
 dailyIncludedMs:product.dailyIncludedMs,usedMs:Number(usage?.used_ms||0),includedUsedMs:Number(usage?.included_used_ms||0),
 remainingIncludedMs:Math.max(0,product.dailyIncludedMs-Number(usage?.included_used_ms||0)),overageMs:Number(usage?.overage_ms||0),overageTlPerSecond:1};
}
interface UsageRow {user_id:number;file_id:number;session_id:string;entitlement_id:string;local_day:string;timezone:string;starts_at_ms:number;ends_at_ms:number;included_ms:number;overage_ms:number;overage_atoms:number;expected_daily_version:number;}
/** Produces SQL to join the SAME D1 batch as a posted V5 overage settlement.
 * Included-only intervals can be committed with db.batch(statements).
 * Overage cannot be committed alone: the batch checks the balanced, posted ledger
 * transaction with exact user, usage key, amount and idempotency key.
 * No browser route exposes this trusted-interval method.
 */
export async function prepareDailyMusicUsage(db:D1Database,interval:VerifiedListeningInterval,nowMs=Date.now()){
 key(interval.usageKey);key(interval.sessionId);safeInt(interval.userId,1);safeInt(interval.fileId,1);safeInt(interval.startsAtMs);safeInt(interval.endsAtMs,1);safeInt(nowMs);
 if(interval.endsAtMs<=interval.startsAtMs||interval.endsAtMs>nowMs)throw Error('INVALID_VERIFIED_LISTEN_INTERVAL');
 await ensureSubscriptionMeterSchema(db);
 const prior=await db.prepare('SELECT * FROM v5_music_usage_events WHERE usage_key=?').bind(interval.usageKey).first<UsageRow>();
 if(prior){
  if(prior.user_id!==interval.userId||prior.file_id!==interval.fileId||prior.session_id!==interval.sessionId||prior.starts_at_ms!==interval.startsAtMs||prior.ends_at_ms!==interval.endsAtMs)throw Error('MUSIC_USAGE_IDEMPOTENCY_CONFLICT');
  return {replayed:true as const,includedMs:prior.included_ms,overageMs:prior.overage_ms,debitAtoms:prior.overage_atoms,statements:[] as D1PreparedStatement[],overageIdempotencyKey:'daily-free-overage:'+interval.usageKey};
 }
 const e=await readActiveMusicEntitlement(db,interval.userId,interval.startsAtMs);
 if(!e||interval.endsAtMs>e.endsAtMs)throw Error('MUSIC_ENTITLEMENT_NOT_ACTIVE_FOR_INTERVAL');
 const day=subscriptionLocalDay(interval.startsAtMs,e.timezone);
 if(day!==subscriptionLocalDay(interval.endsAtMs-1,e.timezone))throw Error('LISTEN_INTERVAL_MUST_SPLIT_AT_LOCAL_MIDNIGHT');
 const usage=await db.prepare('SELECT used_ms,included_used_ms,overage_ms,version,timezone FROM v5_music_daily_usage WHERE user_id=? AND local_day=?').bind(interval.userId,day).first<{used_ms:number;included_used_ms:number;overage_ms:number;version:number;timezone:string}>();
 if(usage&&usage.timezone!==e.timezone)throw Error('SUBSCRIPTION_TIMEZONE_CHANGE_REVIEW_REQUIRED');
 const duration=interval.endsAtMs-interval.startsAtMs,previousIncluded=Number(usage?.included_used_ms||0),version=Number(usage?.version||0);
 const included=Math.min(duration,Math.max(0,dailyFreeProduct(e.level).dailyIncludedMs-previousIncluded));
 const overage=duration-included,atoms=overage*10;safeInt(atoms);
 const paymentKey='daily-free-overage:'+interval.usageKey;
 const statements=[
  db.prepare(`INSERT OR IGNORE INTO v5_music_daily_usage(user_id,local_day,timezone) VALUES(?,?,?)`).bind(interval.userId,day,e.timezone),
  db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_music_daily_usage WHERE user_id=? AND local_day=? AND timezone=? AND version=?) THEN 1 ELSE json_extract('DAILY_USAGE_VERSION_CONFLICT','$') END`).bind(interval.userId,day,e.timezone,version),
  db.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM v5_music_entitlements WHERE user_id=? AND status='active' AND payment_mode='live' AND starts_at_ms<=? AND ends_at_ms>?)=1 AND EXISTS(SELECT 1 FROM v5_music_entitlements WHERE id=? AND user_id=? AND level=? AND timezone=? AND starts_at_ms=? AND ends_at_ms=? AND status='active' AND payment_mode='live') THEN 1 ELSE json_extract('ENTITLEMENT_CHANGED','$') END`).bind(interval.userId,interval.startsAtMs,interval.startsAtMs,e.id,interval.userId,e.level,e.timezone,e.startsAtMs,e.endsAtMs),
  db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM v5_music_usage_events WHERE user_id=? AND starts_at_ms<? AND ends_at_ms>?) THEN 1 ELSE json_extract('OVERLAPPING_LISTEN_INTERVAL','$') END`).bind(interval.userId,interval.endsAtMs,interval.startsAtMs),
 ];
 if(atoms>0)statements.push(db.prepare(`SELECT CASE WHEN EXISTS(
   SELECT 1 FROM v3_economy_transactions t WHERE t.idempotency_key=? AND t.status='posted' AND t.transaction_type='daily_free_overage' AND t.source='verified_subscription_playback'
    AND t.actor_user_id=? AND t.reference_type='music_usage' AND t.reference_id=?
    AND json_valid(t.metadata_json) AND json_extract(t.metadata_json,'$.overage_atoms')=?
    AND EXISTS(SELECT 1 FROM v3_economy_entries x WHERE x.transaction_id=t.id AND x.asset_code='TL' AND x.amount_atoms<0)
    AND NOT EXISTS(SELECT 1 FROM v3_economy_entries x WHERE x.transaction_id=t.id GROUP BY x.asset_code HAVING SUM(x.amount_atoms)<>0)
    AND (SELECT COALESCE(SUM(-x.amount_atoms),0) FROM v3_economy_entries x JOIN v3_economy_accounts a ON a.id=x.account_id WHERE x.transaction_id=t.id AND x.asset_code='TL' AND x.amount_atoms<0 AND a.owner_type='user' AND a.owner_id=? AND a.bucket IN ('wallet_paid','wallet_ad','wallet_bonus'))=?
  ) THEN 1 ELSE json_extract('MISSING_POSTED_OVERAGE_SETTLEMENT','$') END`).bind(paymentKey,String(interval.userId),interval.usageKey,atoms,String(interval.userId),atoms));
 statements.push(
  db.prepare(`INSERT INTO v5_music_usage_events(usage_key,user_id,file_id,session_id,entitlement_id,local_day,timezone,starts_at_ms,ends_at_ms,included_ms,overage_ms,overage_atoms,expected_daily_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(interval.usageKey,interval.userId,interval.fileId,interval.sessionId,e.id,day,e.timezone,interval.startsAtMs,interval.endsAtMs,included,overage,atoms,version),
  db.prepare(`UPDATE v5_music_daily_usage SET used_ms=used_ms+?,included_used_ms=included_used_ms+?,overage_ms=overage_ms+?,version=version+1 WHERE user_id=? AND local_day=? AND version=?`).bind(duration,included,overage,interval.userId,day,version)
 );
 return {replayed:false as const,includedMs:included,overageMs:overage,debitAtoms:atoms,statements,overageIdempotencyKey:paymentKey};
}
