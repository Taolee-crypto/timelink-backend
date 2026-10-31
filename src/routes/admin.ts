import {listMusicSettlementReceipts,reviewMusicSettlement} from '../v5-subscription-settlement-review';
import {readContributionPolicy,readContributionEvaluation} from '../v5-contribution-store';
import {contributionTable} from '../v5-contribution-policy';
import {dailyFreeCatalogue} from '../v5-daily-free-policy';
import {readKrFinance,readKrPolicy,saveKrPolicy,saveKrProfile,postKrJournal,closeKrPeriod,krVat,krCorporate,krWithholding} from '../kr-finance';
import {readAdminFinance} from '../admin-finance-report';
import {readCreatorPayoutReport} from '../creator-payout-report';
import { permittedStationTracks } from '../tilo-station';
import { REWARD_RULES,readRewardPolicy,validateRewardRules } from '../v5-reward-policy';
import { currentTiloSlot,tiloLocalShow,TILO_ZONES,type TiloCountry } from '../tilo-server-timeline';
import { classifyTiloStationOperation } from '../tilo-v5-station-operations';
import { ensureCentralBroadcastSchema } from '../central-broadcast-schema';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import {reverseReferralReward,reverseStoreReferralForRefund} from '../v5-referral-reward';
import {readGroupTlcReserve} from '../v5-tlc-mining-split';
import {readTlcIssuanceIntegrity} from '../v5-tlc-issuance-audit';
import {ensureLedgerAccount,postLedgerTransaction} from '../economy-ledger';
import {readProfitSafetyControls,saveProfitSafetyLimits,readProfitSafetyHistory,evaluateProfitSafety} from '../v5-profit-safety';

const router = new Hono<{ Bindings: Env }>();

// Persist the attempt before executing an administrator action. A process crash
// leaves an explicit pending record rather than erasing the attempted operation.
router.use('*',async(c,next)=>{
  const actor=await requireAdmin(c);
  if(!actor)return c.json({error:'ADMIN_REQUIRED'},403);
  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS v5_admin_access_audit(
    id TEXT PRIMARY KEY,actor_user_id INTEGER NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,
    status INTEGER,outcome TEXT DEFAULT 'pending',created_at TEXT DEFAULT(datetime('now')),finished_at TEXT)`
  ).run();
  const id=crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO v5_admin_access_audit(id,actor_user_id,method,path) VALUES(?,?,?,?)')
    .bind(id,actor,c.req.method,new URL(c.req.url).pathname).run();
  try{await next();}
  finally{await c.env.DB.prepare("UPDATE v5_admin_access_audit SET status=?,outcome=?,finished_at=datetime('now') WHERE id=?")
    .bind(c.res.status,c.res.status<400?'completed':'failed',id).run();}
});
// TILO discount coefficient: administrator-only, auditable, prospective policy.
router.get('/central-broadcast/discount',async c=>{
  try{
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tilo_broadcast_discount_policy(
      id INTEGER PRIMARY KEY CHECK(id=1),coefficient_bps INTEGER NOT NULL,
      revision INTEGER NOT NULL,updated_by INTEGER NOT NULL,updated_at TEXT NOT NULL)`).run();
    const row=await c.env.DB.prepare('SELECT coefficient_bps,revision,updated_at FROM tilo_broadcast_discount_policy WHERE id=1').first();
    return c.json({ok:true,discount_coefficient_bps:row?.coefficient_bps??3000,revision:row?.revision??0,updated_at:row?.updated_at??null,settlement_integration:'pending'});
  }catch{return c.json({ok:false,error:'DISCOUNT_POLICY_UNAVAILABLE'},503)}
});
router.put('/central-broadcast/discount',async c=>{
  const actor=await requireAdmin(c);
  const body=await c.req.json().catch(()=>null) as any;
  if(!body||!Number.isInteger(body.coefficient_bps)||body.coefficient_bps<0||body.coefficient_bps>10000||!Number.isInteger(body.expected_revision)||body.expected_revision<0||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>500)
    return c.json({ok:false,error:'INVALID_DISCOUNT_POLICY'},400);
  try{
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tilo_broadcast_discount_policy(
      id INTEGER PRIMARY KEY CHECK(id=1),coefficient_bps INTEGER NOT NULL,
      revision INTEGER NOT NULL,updated_by INTEGER NOT NULL,updated_at TEXT NOT NULL)`).run();
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tilo_broadcast_discount_audit(
      id TEXT PRIMARY KEY,revision INTEGER NOT NULL,coefficient_bps INTEGER NOT NULL,
      actor INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL)`).run();
    const existing=await c.env.DB.prepare('SELECT revision FROM tilo_broadcast_discount_policy WHERE id=1').first<{revision:number}>();
    const revision=existing?.revision??0;
    if(revision!==body.expected_revision)return c.json({ok:false,error:'REVISION_CONFLICT',current_revision:revision},409);
    const next=revision+1,now=new Date().toISOString(),id=crypto.randomUUID();
    const statements=[
      c.env.DB.prepare(`INSERT INTO tilo_broadcast_discount_policy(id,coefficient_bps,revision,updated_by,updated_at)
        VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET coefficient_bps=excluded.coefficient_bps,
        revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at
        WHERE tilo_broadcast_discount_policy.revision=?`).bind(body.coefficient_bps,next,actor,now,revision),
      c.env.DB.prepare('INSERT INTO tilo_broadcast_discount_audit(id,revision,coefficient_bps,actor,reason,created_at) VALUES(?,?,?,?,?,?)')
        .bind(id,next,body.coefficient_bps,actor,body.reason.trim(),now)
    ];
    // D1 batch commits both the revision update and audit entry atomically.
    // The revision was checked before the batch; a concurrent update may
    // invalidate that check. Use a conditional audit insert tied to the
    // committed revision to prevent orphaned audit records.
    statements[1]=c.env.DB.prepare(`INSERT INTO tilo_broadcast_discount_audit
      (id,revision,coefficient_bps,actor,reason,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM tilo_broadcast_discount_policy WHERE id=1 AND revision=?)`)
      .bind(id,next,body.coefficient_bps,actor,body.reason.trim(),now,next);
    const results=await c.env.DB.batch(statements);
    if(!results[0].meta?.changes) return c.json({ok:false,error:'REVISION_CONFLICT'},409);
    return c.json({ok:true,discount_coefficient_bps:body.coefficient_bps,revision:next,settlement_integration:'pending'});
  }catch{return c.json({ok:false,error:'DISCOUNT_POLICY_SAVE_FAILED'},503)}
});
/**
 * Central TILO operational truth, restricted to authenticated administrators.
 * Listener eligibility, explicit country rights, verified broadcast evidence and
 * financial approval are deliberately distinct. A timetable is never "on air".
 * Does not create grants, sessions, airtime or ledger entries.
 */
router.get('/central-broadcast/operations',async c=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const serviceId='central-tilo-'+adminId;
  const now=new Date();
  try{
    const service=await c.env.DB.prepare(
      'SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?'
    ).bind(serviceId,adminId).first<{status:string}>();
    const enabled=service?.status==='active';
    const countries=await Promise.all((Object.keys(TILO_ZONES) as TiloCountry[]).map(async country=>{
      const [tracks,rights,airtime,settlements]=await Promise.all([
        enabled?permittedStationTracks(c.env.DB,country,adminId):Promise.resolve([]),
        c.env.DB.prepare(`SELECT COUNT(DISTINCT v.file_id) AS n
          FROM central_broadcast_service_file_grants sg
          JOIN central_broadcast_rights_grants rg
            ON rg.file_id=sg.file_id AND rg.country=sg.country
            AND rg.status='active'
            AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now'))
          JOIN tl3_v5_releases v ON v.file_id=sg.file_id
            AND v.user_id=rg.creator_id AND v.status='sealed'
          JOIN tl_files f ON f.id=v.file_id AND f.shared=1
            AND LOWER(f.file_type)='audio/tl3' AND COALESCE(f.revenue_held,0)=0
          WHERE sg.service_id=? AND sg.country=? AND sg.status='active'
            AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now'))
            AND EXISTS(SELECT 1 FROM tl_creator_metadata cm
              WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id
                AND cm.rights_declared=1
                AND cm.declaration_status IN ('declared','verified','approved'))`
        ).bind(serviceId,country).first<{n:number}>(),
        c.env.DB.prepare(`SELECT MAX(ended_at) AS last_ended_at,
          COUNT(*) AS event_count, COALESCE(SUM(audible_ms),0) AS audible_ms
          FROM tilo_v5_verified_airtime WHERE service_id=? AND country=?`
        ).bind(serviceId,country).first<{last_ended_at:string|null;event_count:number;audible_ms:number}>(),
        c.env.DB.prepare(`SELECT
          SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN state='approved' THEN 1 ELSE 0 END) AS approved,
          SUM(CASE WHEN state='posted' THEN 1 ELSE 0 END) AS posted
          FROM tilo_v5_settlement_approvals WHERE country=?`
        ).bind(country).first<{pending:number|null;approved:number|null;posted:number|null}>()
      ]);
      const licensedTracks=Number(rights?.n||0);
      const receiverTracks=tracks.length;
      const last=airtime?.last_ended_at||null;
      const condition=classifyTiloStationOperation({
        serviceEnabled:enabled,receiverTracks,licensedTracks,lastVerifiedEndAt:last,nowMs:now.getTime()
      });
      return {
        country,time_zone:TILO_ZONES[country],local_show:tiloLocalShow(country,now),
        service_enabled:enabled,receiver_candidate_tracks:receiverTracks,
        explicit_country_licensed_tracks:licensedTracks,
        receiver_clock_slot:enabled?currentTiloSlot(tracks,now.getTime(),Date.UTC(2026,0,1)):null,
        verified_airtime_events:Number(airtime?.event_count||0),
        verified_audible_ms:Number(airtime?.audible_ms||0),
        last_verified_airtime_end_at:last,
        pending_settlements:Number(settlements?.pending||0),
        approved_unposted_settlements:Number(settlements?.approved||0),
        posted_settlements:Number(settlements?.posted||0),
        condition,server_audio_stream:false,server_playout_verified:false,
      };
    }));
    return c.json({ok:true,service_id:serviceId,server_time:now.toISOString(),
      actual_server_audio_stream:false,source:'production_d1',countries,
      note:'Authorized browser playback and shared playlist clocks do not prove 24-hour server playout. Only verified broadcaster evidence may enter settlement.'});
  }catch(error){
    console.error('[TILO_OPERATIONS]',error);
    return c.json({ok:false,error:'TILO_OPERATIONS_UNAVAILABLE'},503);
  }
});

router.get('/cafe/channels',async c=>{
  try {
    const rows=await c.env.DB.prepare('SELECT channel_id,name,status FROM cafe_channels ORDER BY channel_id DESC LIMIT 500').all();
    return c.json({ok:true,channels:rows.results||[]});
  } catch(error) {
    console.error('[ADMIN_CAFE_CHANNELS]',error);
    return c.json({ok:false,error:'STORE_CHANNELS_UNAVAILABLE'},503);
  }
});
// Development-stage refund/chargeback review: the administrator supplies an
// externally verified refund reference. Do not allow clients to reverse rewards.
router.post('/referrals/reverse',async c=>{
 const actor=await requireAdmin(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const body=await c.req.json().catch(()=>null) as any;
 if(!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(k=>!['milestone_key','proof_reference'].includes(k))||
    typeof body.milestone_key!=='string'||typeof body.proof_reference!=='string')
   return c.json({ok:false,error:'INVALID_REFERRAL_REVERSAL'},400);
 try{return c.json(await reverseReferralReward(c.env.DB,actor,body.milestone_key,body.proof_reference));}
 catch(error:any){
   const code=String(error.message||error);
   if(['INVALID_REFERRAL_REVERSAL','REFERRAL_RECEIPT_NOT_FOUND','REFERRAL_REVERSAL_INVALID_STATUS'].includes(code))
    return c.json({ok:false,error:code},409);
   if(/negative|INSUFFICIENT/i.test(code))
    return c.json({ok:false,error:'BONUS_BALANCE_TOO_LOW_MANUAL_REVIEW_REQUIRED'},409);
   console.error('[ADMIN_REFERRAL_REVERSAL]',code);
   return c.json({ok:false,error:'REFERRAL_REVERSAL_UNAVAILABLE'},503);
 }
});
router.post('/referrals/store-refund',async c=>{
 const actor=await requireAdmin(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const body=await c.req.json().catch(()=>null) as any;
 if(!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(k=>!['order_id','proof_reference'].includes(k))||
    typeof body.order_id!=='string'||typeof body.proof_reference!=='string')
   return c.json({ok:false,error:'INVALID_STORE_REFERRAL_REFUND'},400);
 try{return c.json(await reverseStoreReferralForRefund(c.env.DB,actor,body.order_id,body.proof_reference));}
 catch(error:any){
   const code=String(error.message||error);
   if(['INVALID_STORE_REFERRAL_REFUND','VERIFIED_STORE_PAYMENT_REQUIRED','REFUND_REFERENCE_CONFLICT'].includes(code))
     return c.json({ok:false,error:code},409);
   if(/negative|INSUFFICIENT/i.test(code))
     return c.json({ok:false,error:'BONUS_BALANCE_TOO_LOW_MANUAL_REVIEW_REQUIRED'},409);
   console.error('[ADMIN_STORE_REFERRAL_REFUND]',code);
   return c.json({ok:false,error:'STORE_REFERRAL_REFUND_UNAVAILABLE'},503);
 }
});
router.get('/audit-events',async c=>{
  const rows=await c.env.DB.prepare(`SELECT * FROM v5_admin_access_audit ORDER BY created_at DESC,id DESC LIMIT 100`).all();
  const stats=await c.env.DB.prepare(`SELECT COUNT(*) AS requests,
    SUM(CASE WHEN path='/api/admin/sql' THEN 1 ELSE 0 END) AS sql_requests
    FROM v5_admin_access_audit WHERE created_at>=datetime('now','-30 days')`).first();
  return c.json({ok:true,events:rows.results||[],stats});
});
// Renewal policy and simulation only: never edits legacy PoC or mints TLC.
router.get('/contribution-policy',async c=>{
  const current=await readContributionPolicy(c.env.DB);
  return c.json({ok:true,...current,definitions:contributionTable(current.policy),products:dailyFreeCatalogue(),mode:'historical',newMiningEnabled:false,policyStatus:'retired',activeRewardPolicy:'v5_reward_policy',pricingStatus:'design'});
});
// The renewal reward proposal has been withdrawn. Existing versioned reward
// rules remain authoritative; historical policy and event records stay readable.
router.post('/contribution-policy',async c=>{
  const actor=await requireAdmin(c);if(!actor)return c.json({error:'ADMIN_REQUIRED'},403);
  return c.json({ok:false,error:'CONTRIBUTION_POLICY_RETIRED',activeRewardPolicy:'v5_reward_policy',message:'새 보상안은 폐기되었습니다. 기존 V5 보상 규칙을 사용하세요.'},410);
});
router.get('/contribution-policy/history',async c=>{
  await readContributionPolicy(c.env.DB);
  const history=await c.env.DB.prepare('SELECT version,policy_json,updated_by,note,updated_at FROM v5_contribution_policy_history ORDER BY version DESC LIMIT 50').all();
  return c.json({ok:true,history:history.results});
});
router.get('/contribution-members/:id',async c=>{
  const id=Number(c.req.param('id'));if(!Number.isSafeInteger(id)||id<=0)return c.json({error:'INVALID_USER'},400);
  const user=await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
  if(!user)return c.json({error:'USER_NOT_FOUND'},404);
  return c.json({ok:true,...await readContributionEvaluation(c.env.DB,id)});
});

router.get('/music-subscription-settlements',async c=>{
 c.header('Cache-Control','no-store');
 try{return c.json(await listMusicSettlementReceipts(c.env.DB,Number(c.req.query('limit')||25),Number(c.req.query('offset')||0)));}
 catch(error){if(String(error).includes('INVALID_MUSIC_REVIEW_PAGE'))return c.json({error:'INVALID_MUSIC_REVIEW_PAGE'},400);throw error;}
});
router.get('/music-subscription-settlements/:orderId',async c=>{
 c.header('Cache-Control','no-store');
 try{const result=await reviewMusicSettlement(c.env.DB,c.req.param('orderId'));return result?c.json(result):c.json({error:'MUSIC_RECEIPT_NOT_FOUND'},404);}
 catch(error){if(String(error).includes('INVALID_MUSIC_REVIEW_ORDER'))return c.json({error:'INVALID_MUSIC_REVIEW_ORDER'},400);throw error;}
});

/**
 * Administrator-controlled safety limits and non-mutating forecast.
 * No automatic optimizer or unattended policy rewrite is permitted.
 */
router.get('/profit-safety',async c=>{
 c.header('Cache-Control','no-store');
 const controls=await readProfitSafetyControls(c.env.DB);
 let verification:any={bank_settlement_verified:false,refund_totals_verified:false,
  rights_payouts_verified:false,cloud_cost_verified:false};
 try{
  const finance=await readAdminFinance(c.env.DB);
  verification={...verification,...finance.verification};
 }catch(error){
  // Never turn missing accounting schema / incomplete finance into a green status.
  verification.finance_unavailable=true;
 }
 const reward=await readRewardPolicy(c.env.DB);
 return c.json({ok:true,...controls,verification,reward_policy_version:reward.version,
  automation_preconditions_met:false,
  note:'재무 실측과 운영 증빙이 검증되기 전까지 자동 최적화는 비활성화됩니다. 관리자가 규칙을 직접 조정합니다.'});
});
router.get('/profit-safety/history',async c=>{
 c.header('Cache-Control','no-store');
 return c.json({ok:true,history:await readProfitSafetyHistory(c.env.DB)});
});
router.post('/profit-safety/simulate',async c=>{
 c.header('Cache-Control','no-store');
 try{
  const input=await c.req.json<any>();
  const controls=await readProfitSafetyControls(c.env.DB);
  if(input?.expected_version!==controls.version)return c.json({ok:false,code:'PROFIT_SAFETY_VERSION_CONFLICT'},409);
  return c.json(evaluateProfitSafety(input.scenario,controls.limits));
 }catch(error:any){return c.json({ok:false,code:String(error.message||'INVALID_PROFIT_SCENARIO')},400);}
});
router.post('/profit-safety/limits',async c=>{
 const actor=await requireAdmin(c);
 if(!actor)return c.json({ok:false,code:'ADMIN_REQUIRED'},403);
 try{
  const input=await c.req.json<any>();
  if(!input||typeof input!=='object'||Array.isArray(input)||input.mode!=='manual'||
    Object.keys(input).some(k=>!['mode','expected_version','limits'].includes(k)))
    return c.json({ok:false,code:'MANUAL_ONLY'},400);
  const result=await saveProfitSafetyLimits(c.env.DB,actor,input.expected_version,input.limits);
  return c.json(result);
 }catch(error:any){
  const code=String(error.message||error);
  return c.json({ok:false,code},code==='PROFIT_SAFETY_VERSION_CONFLICT'?409:400);
 }
});

/** Every user, including an administrator/founder, must receive exactly the same
 *  50:50 mining split. This reports anomalies; it cannot mint or modify TLC.
 */
router.get('/tlc-issuance-audit',async c=>{
 c.header('Cache-Control','private, no-store');
 try{
   return c.json(await readTlcIssuanceIntegrity(c.env.DB));
 }catch(error){console.error('[TLC_ISSUANCE_INTEGRITY]',String(error));return c.json({ok:false,code:'TLC_ISSUANCE_AUDIT_UNAVAILABLE'},503);}
});
/** Company TLC is a long-term held reserve, not operating cash or TON balance. */
router.get('/tlc-group-reserve',async c=>{
 c.header('Cache-Control','private, no-store');
 try{
   const reserve=await readGroupTlcReserve(c.env.DB);
   const summary=await c.env.DB.prepare(`SELECT
     COUNT(*) AS transaction_count,
     COALESCE(SUM(CASE WHEN json_valid(metadata_json)
       THEN json_extract(metadata_json,'$.group_mined_tlc') ELSE 0 END),0) AS total_group_mined_tlc
     FROM v3_economy_transactions
     WHERE transaction_type='tlc_development_mining'
       AND source='server_poc_v1' AND json_valid(metadata_json)
       AND json_extract(metadata_json,'$.split_policy')='tilo-group-5050-v1'`).first<any>();
   const lifetime=await c.env.DB.prepare(`SELECT
     COUNT(*) AS v3_records,COALESCE(SUM(CAST(minted_atoms AS REAL)),0)/1000000000.0 AS v3_gross_mined_tlc
     FROM v3_tlc_mining_records WHERE status='posted'`).first<any>();
   return c.json({ok:true,...reserve,
     issuance_model:'verified_activity_no_fixed_max_supply',
     fixed_max_supply:null,
     cumulative_v3_mined_tlc:Number(lifetime?.v3_gross_mined_tlc||0),
     cumulative_v3_record_count:Number(lifetime?.v3_records||0),
     cumulative_supply_scope:'v3_mining_records_only_excludes_legacy_or_nonmining_sources',
     mining_events:Number(summary?.transaction_count||0),
     minted_to_group_tlc:Number(summary?.total_group_mined_tlc||0),
     historical_rebalanced:false,redemption_enabled:false});
 }catch(error){console.error('[GROUP_TLC_RESERVE]',String(error));return c.json({ok:false,code:'TLC_RESERVE_UNAVAILABLE'},503);}
});
router.get('/reward-policy',async c=>c.json({ok:true,...await readRewardPolicy(c.env.DB),definitions:REWARD_RULES,mode:'manual'}));
router.get('/reward-policy/history',async c=>{
  await readRewardPolicy(c.env.DB);
  const rows=await c.env.DB.prepare('SELECT version,updated_by,note,updated_at FROM v5_reward_policy_history ORDER BY version DESC LIMIT 50').all();
  return c.json({ok:true,history:rows.results||[]});
});
router.post('/reward-policy',async c=>{
  const actor=await requireAdmin(c);if(!actor)return c.json({error:'ADMIN_REQUIRED'},403);
  try{
    const input=await c.req.json<any>();
    if(!Number.isSafeInteger(input.expected_version))return c.json({error:'VERSION_REQUIRED'},400);
    const rules=validateRewardRules(input.rules);
    await readRewardPolicy(c.env.DB);
    const result=await c.env.DB.prepare(`UPDATE v5_reward_policy SET version=version+1,rules_json=?,updated_by=?,updated_at=datetime('now') WHERE id=1 AND version=?`)
      .bind(JSON.stringify(rules),actor,input.expected_version).run();
    if(!result.meta?.changes)return c.json({error:'VERSION_CONFLICT'},409);
    return c.json({ok:true,version:input.expected_version+1});
  }catch(e:any){return c.json({error:e.message},400);}
});

async function ensureWorkLedger(db:D1Database){
  await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS v5_work_ledger (
    id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 0,
    state_json TEXT,updated_by INTEGER,updated_at TEXT)`),db.prepare('INSERT OR IGNORE INTO v5_work_ledger(id) VALUES(1)'),db.prepare(`CREATE TABLE IF NOT EXISTS v5_work_ledger_versions (
    version INTEGER PRIMARY KEY,state_json TEXT NOT NULL,updated_by INTEGER,updated_at TEXT)`),db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_work_ledger_history AFTER UPDATE ON v5_work_ledger
    BEGIN INSERT INTO v5_work_ledger_versions VALUES(NEW.version,NEW.state_json,NEW.updated_by,NEW.updated_at); END`)]);
}

router.get('/v5-work-ledger',async c=>{
  if(!await requireAdmin(c))return c.json({error:'ADMIN_REQUIRED'},403);
  await ensureWorkLedger(c.env.DB);
  const row=await c.env.DB.prepare('SELECT * FROM v5_work_ledger WHERE id=1').first<any>();
  return c.json({ok:true,version:row.version,state:row.state_json?JSON.parse(row.state_json):null});
});
router.post('/v5-work-ledger',async c=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({error:'ADMIN_REQUIRED'},403);
  const body=await c.req.json<any>().catch(()=>null);
  if(!body||!Number.isSafeInteger(body.expected_version)||body.expected_version<0||
    !Array.isArray(body.state?.tasks)||!Array.isArray(body.state?.events)||
    body.state.tasks.length>5000||body.state.events.length>10000)
    return c.json({error:'INVALID_WORK_LEDGER'},400);
  const serialized=JSON.stringify(body.state);
  if(serialized.length>1000000)return c.json({error:'WORK_LEDGER_TOO_LARGE'},413);
  await ensureWorkLedger(c.env.DB);
  const result=await c.env.DB.prepare(`UPDATE v5_work_ledger SET version=version+1,
    state_json=?,updated_by=?,updated_at=datetime('now') WHERE id=1 AND version=?`)
    .bind(serialized,adminId,body.expected_version).run();
  if(!result.meta?.changes)return c.json({error:'VERSION_CONFLICT'},409);
  return c.json({ok:true,version:body.expected_version+1});
});

// ── 관리자 확인 ──
async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<number | null> {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return null;
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return null;
  const userId = Number(payload.sub || 0);
  if (!userId) return null;
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(userId).first<any>();
  if (!user || String(user.role || '').toLowerCase() !== 'admin') return null;
  return userId;
}


/** Country-scoped TILO station readiness for the admin control room. */
/** Grant a sealed, rights-cleared SharePlace V5 track to the administrator's TILO station. */
router.post('/central-broadcast/stations/:country/grants', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const body=await c.req.json().catch(()=>null) as {file_id?:number}|null;
  const fileId=Number(body?.file_id);
  if(!Number.isSafeInteger(fileId)||fileId<=0)return c.json({ok:false,error:'INVALID_FILE_ID'},400);
  const serviceId='central-tilo-'+adminId;
  try{
    await ensureCentralBroadcastSchema(c.env.DB);
    const eligible=await c.env.DB.prepare(`
      SELECT v.file_id FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id
      WHERE v.file_id=? AND v.status='sealed' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0
      AND LOWER(f.file_type)='audio/tl3'
      AND EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved'))
      AND (v.user_id=? OR EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?
        AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now'))))
      LIMIT 1`).bind(fileId,adminId,country).first();
    if(!eligible)return c.json({ok:false,error:'BROADCAST_RIGHTS_NOT_CLEARED'},403);
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:false,error:'TILO_SERVICE_NOT_ACTIVE'},409);
    // A creator-admin may grant only their own declared recording. Other
    // creators still require a separately recorded country broadcast grant.
    await c.env.DB.prepare(`INSERT INTO central_broadcast_rights_grants
      (grant_id,file_id,creator_id,country,status)
      SELECT ?,v.file_id,v.user_id,?,'active' FROM tl3_v5_releases v
      WHERE v.file_id=? AND v.user_id=? AND NOT EXISTS(
        SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?)`)
      .bind('creator-admin:'+adminId+':'+fileId+':'+country,country,fileId,adminId,country).run();
    await c.env.DB.prepare(`
      INSERT INTO central_broadcast_service_file_grants
      (service_id,file_id,country,permission,status,granted_by_admin_user_id)
      VALUES(?,?,?,'stream','active',?)
      ON CONFLICT(service_id,file_id,country) DO UPDATE SET status='active',
        granted_by_admin_user_id=excluded.granted_by_admin_user_id`)
      .bind(serviceId,fileId,country,adminId).run();
    return c.json({ok:true,country,file_id:fileId,status:'active'});
  }catch(e:any){return c.json({ok:false,error:/no such table/i.test(String(e?.message))?'BROADCAST_SCHEMA_NOT_READY':'BROADCAST_GRANT_FAILED'},500)}
});

/**
 * Explicit administrator authorization of a bounded selection of OWN sealed
 * V5 recordings for ONE country. Never licenses a third party, and never
 * silently overrides an expired/revoked country or service grant.
 *
 * An independent grant audit is persisted with the same D1 batch as the
 * rights/service grants. This is not an audio broadcast or an accounting event.
 */
router.post('/central-broadcast/stations/:country/grants/bulk',async c=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))
    return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const body=await c.req.json().catch(()=>null) as {file_ids?:unknown;rights_confirmed?:unknown}|null;
  const ids=body?.file_ids;
  if(body?.rights_confirmed!==true||!Array.isArray(ids)||ids.length<1||ids.length>60||
     !ids.every(x=>Number.isSafeInteger(x)&&x>0)||new Set(ids).size!==ids.length)
    return c.json({ok:false,error:'EXPLICIT_OWNED_RIGHTS_CONFIRMATION_REQUIRED'},400);
  const fileIds=ids as number[];
  const serviceId='central-tilo-'+adminId;
  const placeholders=fileIds.map(()=>'?').join(',');
  try{
    await ensureCentralBroadcastSchema(c.env.DB);
    const service=await c.env.DB.prepare(`SELECT status FROM central_broadcast_service_accounts
      WHERE service_id=? AND parent_admin_user_id=?`
    ).bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:false,error:'TILO_SERVICE_NOT_ACTIVE'},409);
    const allowed=await c.env.DB.prepare(`SELECT v.file_id FROM tl3_v5_releases v
      JOIN tl_files f ON f.id=v.file_id
      WHERE v.file_id IN (${placeholders}) AND v.user_id=? AND f.user_id=?
        AND v.status='sealed' AND f.shared=1 AND LOWER(f.file_type)='audio/tl3'
        AND COALESCE(f.revenue_held,0)=0
        AND EXISTS(SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id
          AND cm.user_id=v.user_id AND cm.rights_declared=1
          AND cm.rights_role IN ('owner','authorized_agent','licensee')
          AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope')
          AND cm.declaration_status IN ('declared','verified','approved'))
        AND NOT EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
          WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?
            AND (rg.status<>'active' OR (rg.expires_at IS NOT NULL
            AND rg.expires_at<=datetime('now'))))
        AND NOT EXISTS(SELECT 1 FROM central_broadcast_service_file_grants sg
          WHERE sg.service_id=? AND sg.file_id=v.file_id AND sg.country=?
            AND (sg.status='revoked' OR (sg.expires_at IS NOT NULL
            AND sg.expires_at<=datetime('now'))))`
    ).bind(...fileIds,adminId,adminId,country,serviceId,country).all<{file_id:number}>();
    if((allowed.results||[]).length!==fileIds.length)
      return c.json({ok:false,error:'OWNER_OR_BROADCAST_RIGHTS_NOT_VERIFIED'},403);
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tilo_v5_country_grant_audit(
      event_id TEXT PRIMARY KEY,actor_user_id INTEGER NOT NULL,
      service_id TEXT NOT NULL,country TEXT NOT NULL,file_ids_json TEXT NOT NULL,
      verified_count INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
    // Check for withdrawals again INSIDE the atomic batch before inserting any grants.
    const guard=c.env.DB.prepare(`SELECT CASE WHEN
      (SELECT COUNT(*) FROM central_broadcast_rights_grants
       WHERE country=? AND file_id IN (${placeholders})
         AND (status<>'active' OR (expires_at IS NOT NULL AND expires_at<=datetime('now'))))=0
      AND (SELECT COUNT(*) FROM central_broadcast_service_file_grants
       WHERE service_id=? AND country=? AND file_id IN (${placeholders})
         AND (status='revoked' OR (expires_at IS NOT NULL AND expires_at<=datetime('now'))))=0
      THEN 1 ELSE json_extract('invalid',char(36)) END`)
      .bind(country,...fileIds,serviceId,country,...fileIds);
    const statements:D1PreparedStatement[]=[guard];
    for(const fileId of fileIds){
      statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO central_broadcast_rights_grants
        (grant_id,file_id,creator_id,country,status) VALUES(?,?,?,?,'active')`)
        .bind('creator-admin:'+adminId+':'+fileId+':'+country,fileId,adminId,country));
      statements.push(c.env.DB.prepare(`INSERT INTO central_broadcast_service_file_grants
        (service_id,file_id,country,permission,status,granted_by_admin_user_id)
        VALUES(?,?,?,'stream','active',?)
        ON CONFLICT(service_id,file_id,country) DO UPDATE SET status='active',
          granted_by_admin_user_id=excluded.granted_by_admin_user_id`)
        .bind(serviceId,fileId,country,adminId));
    }
    const eventId=crypto.randomUUID();
    statements.push(c.env.DB.prepare(`INSERT INTO tilo_v5_country_grant_audit
      (event_id,actor_user_id,service_id,country,file_ids_json,verified_count)
      VALUES (?,?,?,?,?,?)`).bind(eventId,adminId,serviceId,country,
        JSON.stringify(fileIds),fileIds.length));
    await c.env.DB.batch(statements);
    return c.json({ok:true,country,service_id:serviceId,authorized:fileIds.length,
      file_ids:fileIds,audit_event_id:eventId,settlement_posted:false});
  }catch(error){
    console.error('[TILO_COUNTRY_BULK_GRANT]',error);
    return c.json({ok:false,error:'BROADCAST_BULK_GRANT_FAILED'},503);
  }
});

/** Read-only candidate audit: reports why published SharePlace V5 files are excluded. */
router.get('/central-broadcast/stations/:country/audit', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  try{
    await ensureCentralBroadcastSchema(c.env.DB);
    const rows=await c.env.DB.prepare(`SELECT f.id AS file_id,f.title,f.file_type,f.shared,
      f.user_id AS owner_user_id,COALESCE(f.revenue_held,0) AS revenue_held,
      v.status AS v5_status,v.duration_ms,
      CASE WHEN EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=f.id AND cm.user_id=f.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved')) THEN 1 ELSE 0 END AS release_rights,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=f.id AND rg.creator_id=f.user_id AND rg.country=?
          AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
        THEN 1 ELSE 0 END AS country_broadcast_rights,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_service_file_grants sg
        WHERE sg.service_id=? AND sg.file_id=f.id AND sg.country=?
          AND sg.status='active' AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now')))
        THEN 1 ELSE 0 END AS service_granted,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=f.id AND rg.creator_id=f.user_id AND rg.country=?
          AND (rg.status<>'active' OR (rg.expires_at IS NOT NULL
            AND rg.expires_at<=datetime('now'))))
        THEN 1 ELSE 0 END AS rights_blocked
      FROM tl_files f LEFT JOIN tl3_v5_releases v ON v.file_id=f.id
      WHERE f.shared=1 ORDER BY f.id DESC LIMIT 100`)
      .bind(country,'central-tilo-'+adminId,country,country).all<any>();
    const tracks=(rows.results||[]).map(r=>{
      const reasons:string[]=[];
      if(!r.v5_status)reasons.push('NO_V5_RELEASE');
      else if(r.v5_status!=='sealed')reasons.push('V5_NOT_SEALED');
      if(!r.release_rights)reasons.push('SHAREPLACE_RELEASE_RIGHTS_MISSING');
      if(!r.country_broadcast_rights)reasons.push('COUNTRY_BROADCAST_RIGHTS_MISSING');
      if(!r.service_granted)reasons.push('COUNTRY_SERVICE_GRANT_MISSING');
      if(r.rights_blocked)reasons.push('BROADCAST_RIGHTS_BLOCKED');
      if(Number(r.revenue_held||0)!==0)reasons.push('REVENUE_HOLD');
      if(String(r.file_type||'').toLowerCase()!=='audio/tl3')reasons.push('FILE_TYPE_NOT_TL3');
      const canGrant=Number(r.owner_user_id)===adminId &&
        r.v5_status==='sealed'&&Number(r.release_rights)===1&&
        Number(r.revenue_held||0)===0&&!r.rights_blocked &&
        String(r.file_type||'').toLowerCase()==='audio/tl3'&&
        reasons.some(x=>x==='COUNTRY_BROADCAST_RIGHTS_MISSING'||x==='COUNTRY_SERVICE_GRANT_MISSING');
      return {file_id:r.file_id,title:r.title,reasons,eligible:reasons.length===0,
        can_grant:!!canGrant,owner_is_admin:Number(r.owner_user_id)===adminId};
    });
    return c.json({ok:true,country,total:tracks.length,eligible:tracks.filter(x=>x.eligible).length,tracks});
  }catch(e:any){
    console.error('[TILO_CANDIDATE_AUDIT]',String(e?.message||e));
    return c.json({ok:false,error:'BROADCAST_AUDIT_FAILED'},503);
  }
});

router.get('/central-broadcast/stations/:country', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  const languages:Record<string,string>={KR:'ko-KR',JP:'ja-JP',US:'en-US',CN:'zh-CN',TH:'th-TH',VN:'vi-VN'};
  if(!languages[country])return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const serviceId='central-tilo-'+adminId;
  try {
    await ensureCentralBroadcastSchema(c.env.DB);
    await c.env.DB.prepare(`INSERT INTO central_broadcast_service_accounts
      (service_id,parent_admin_user_id,display_name,status) VALUES (?,?,'TILO Central Broadcast','active')
      ON CONFLICT(service_id) DO NOTHING`).bind(serviceId,adminId).run();
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind(serviceId,adminId).first<{status:string}>();
    const grants={results:await permittedStationTracks(c.env.DB,country,adminId)};
    return c.json({ok:true,country,locale:languages[country],service_enabled:service?.status==='active',
      granted_file_ids:(grants.results||[]).map(g=>g.file_id),
      stream_ready:(grants.results||[]).length>0,reason:(grants.results||[]).length?'READY_FOR_BROWSER_TEST':'NO_ELIGIBLE_V5_TRACKS',
      note:'Auto-selected from published sealed V5 SharePlace tracks. Country station remains administrator-controlled; no listener billing.'});
   }catch(e:any){
    const message=String(e?.message||e||'unknown');
    console.error('[TILO_STATION_SCHEMA]',{country,error:message});
    const missing=message.match(/no such (?:table|column):\\s*([A-Za-z0-9_.]+)/i);
    return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY',
      detail:missing?'MISSING_SCHEMA_OBJECT: '+missing[1]:'Database query failed; inspect Worker logs',
      migration_hint:'Apply pending central_broadcast_rights_grants.sql and central_broadcast_service_identity_v5.sql migrations to the configured remote D1 database.'},503);
  }
});

/** Admin-owned TILO service switch; never bills listeners or grants audio downloads. */
router.get('/central-broadcast/tilo', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  try {
    const row=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind('central-tilo-'+adminId,adminId).first<{status:string}>();
    return c.json({ok:true,enabled:row?.status==='active',service_id:'central-tilo-'+adminId});
  }catch(_){return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY'},503)}
});
router.post('/central-broadcast/tilo', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const body=await c.req.json().catch(()=>null) as {enabled?:unknown}|null;
  if(typeof body?.enabled!=='boolean')return c.json({ok:false,error:'INVALID_ENABLED'},400);
  const serviceId='central-tilo-'+adminId;
  const status=body.enabled?'active':'disabled';
  try {
    await c.env.DB.prepare(`INSERT INTO central_broadcast_service_accounts
      (service_id,parent_admin_user_id,display_name,status)
      VALUES (?,?,'TILO Central Broadcast',?)
      ON CONFLICT(service_id) DO UPDATE SET status=excluded.status,updated_at=datetime('now')
      WHERE parent_admin_user_id=excluded.parent_admin_user_id`)
      .bind(serviceId,adminId,status).run();
    return c.json({ok:true,enabled:body.enabled,service_id:serviceId,broadcast_connected:false});
  }catch(_){return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY'},503)}
});

// Dedicated, read-only admin session verification.
router.get('/session', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ ok: false, error: '관리자 권한 필요' }, 403);
  return c.json({ ok: true, user_id: userId, role: 'admin' });
});

// Read-only preflight for the one-time development TL issuance.
router.get('/tl/initial-issuance/status', async (c) => {
  const adminId=await requireAdmin(c);
  if(!adminId) return c.json({ok:false,error:'관리자 권한 필요'},403);
  try {
    const db=c.env.DB;
    const [scale,tx,tlAccounts,legacy]=await Promise.all([
      db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>(),
      db.prepare("SELECT COUNT(*) AS n FROM v3_economy_transactions").first<any>(),
      db.prepare("SELECT COUNT(*) AS n FROM v3_economy_accounts WHERE asset_code='TL'").first<any>(),
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE COALESCE(tl,0)<>0 OR COALESCE(tl_p,0)<>0 OR COALESCE(tl_a,0)<>0 OR COALESCE(tl_b,0)<>0 OR COALESCE(tl_balance,0)<>0").first<any>()
    ]);
    const ready=Number(scale?.decimals)===4 && Number(tx?.n)===0 && Number(tlAccounts?.n)===0;
    return c.json({ok:true,admin_user_id:adminId,tl_decimals:Number(scale?.decimals??-1),v3_transactions:Number(tx?.n||0),v3_tl_accounts:Number(tlAccounts?.n||0),legacy_users_with_tl:Number(legacy?.n||0),initial_issuance_ready:ready,legacy_tl_not_reset:Number(legacy?.n||0)>0});
  }catch(e:any){return c.json({ok:false,error:e?.message||'원장 상태 확인 실패'},500);}
});

// One-time development bootstrap: only on a completely empty V5 경제원장 TL ledger.
// Does not touch legacy balances, TLC, POC, or TON state.
router.post('/tl/initial-issuance', async (c) => {
  const adminId = await requireAdmin(c);
  if (!adminId) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const confirmation = String((await c.req.json<any>().catch(()=>({}))).confirmation || '');
  if (confirmation !== 'ISSUE_INITIAL_1000000_TL') {
    return c.json({ok:false,error:'명시적 최초 지급 확인 문구가 필요합니다.'},400);
  }
  const db=c.env.DB;
  try {
    const scale=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>();
    if (Number(scale?.decimals)!==4) return c.json({ok:false,error:'TL 정밀도가 4가 아닙니다.'},409);
    const existing=await db.prepare("SELECT COUNT(*) AS n FROM v3_economy_transactions").first<any>();
    const accounts=await db.prepare("SELECT COUNT(*) AS n FROM v3_economy_accounts WHERE asset_code='TL'").first<any>();
    if(Number(existing?.n)!==0||Number(accounts?.n)!==0) {
      return c.json({ok:false,code:'TL_LEDGER_NOT_EMPTY',error:'V5 경제원장이 비어 있지 않습니다. 중복 발행을 방지하기 위해 중단했습니다.'},409);
    }
    const accountId=crypto.randomUUID();
    const sourceId=crypto.randomUUID();
    const transactionId=crypto.randomUUID();
    const atoms=1000000*10000;
    // One-time issuance is not a transfer: record a positive mint entry and provenance.
    // Atomic batch prevents an issuance transaction without its wallet credit.
    await db.batch([
      db.prepare("INSERT INTO v3_economy_accounts(id,owner_type,owner_id,asset_code,bucket) VALUES (?,'user',?,'TL','wallet_bonus')").bind(accountId,String(adminId)),
      db.prepare("INSERT INTO v3_economy_accounts(id,owner_type,owner_id,asset_code,bucket) VALUES (?,'system','v5-initial-bootstrap','TL','issuance')").bind(sourceId),
      db.prepare("INSERT INTO v3_economy_balances(account_id,available_atoms) VALUES (?,?)").bind(accountId,atoms),
      db.prepare("INSERT INTO v3_economy_balances(account_id,available_atoms) VALUES (?,0)").bind(sourceId),
      db.prepare("INSERT INTO v3_economy_transactions(id,idempotency_key,transaction_type,source,reference_type,reference_id,actor_user_id,description,metadata_json) VALUES (?,'initial_dev_tl_issuance_20261022','initial_issuance','admin','user',?,?,'관리자 개발용 최초 TL 1,000,000 지급',?)").bind(transactionId,String(adminId),String(adminId),JSON.stringify({amount_atoms:atoms,non_redeemable:true,development_only:true})),
      db.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES (?,?,'TL',?)").bind(transactionId,accountId,atoms),
      db.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES (?,?,'TL',?)").bind(transactionId,sourceId,-atoms)
    ]);
    return c.json({ok:true,admin_user_id:adminId,issued_tl:1000000,bucket:'wallet_bonus',development_only:true});
  }catch(e:any){return c.json({ok:false,error:e?.message||'최초 TL 지급 실패'},500);}
});


/** V5 경제원장 TL bucket adjustments. Never update legacy users.tl / tl_balance here. */
router.post('/tl/adjust', async (c) => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'관리자 권한 필요'},403);
  const body=await c.req.json<any>().catch(()=>({}));
  const email=String(body.email||'').trim().toLowerCase();
  const bucket=String(body.bucket||'');
  const amount=Number(body.amount);
  const reason=String(body.reason||'').trim();
  const key=String(body.idempotency_key||'');
  if(!email||email==='all'||!['tl_p','tl_a','tl_b'].includes(bucket)||
     !Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1000000||
     reason.length<5||reason.length>300||!/^admin-tl-[a-zA-Z0-9-]{12,100}$/.test(key))
    return c.json({ok:false,error:'대상, TL 종류, 금액(최대 100만), 사유(5자 이상), 요청 식별자를 확인하세요.'},400);
  // Paid TL is backed by real payment; manual issuance must not fabricate redeemable funds.
  if(bucket==='tl_p')return c.json({ok:false,error:'TL_P는 실결제·정산 원장으로만 처리합니다. 관리자 임의 충전/차감은 금지됩니다.'},403);
  const db=c.env.DB;
  let fingerprint='';
  try{
    const scale=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>();
    if(Number(scale?.decimals)!==4)return c.json({ok:false,error:'V5 경제원장 TL 정밀도 마이그레이션 미완료'},409);
    const user=await db.prepare('SELECT id FROM users WHERE lower(email)=?').bind(email).first<any>();
    if(!user)return c.json({ok:false,error:'회원을 찾을 수 없습니다.'},404);
    const targetBucket=bucket==='tl_a'?'wallet_ad':'wallet_bonus';
    const prior=await db.prepare('SELECT id,metadata_json FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>();
    fingerprint=JSON.stringify({user_id:Number(user.id),bucket,amount,reason,admin_id:adminId});
    if(prior){
      const meta=JSON.parse(prior.metadata_json||'{}');
      return meta.adjustment_fingerprint===fingerprint
        ?c.json({ok:true,replayed:true,transaction_id:prior.id})
        :c.json({ok:false,error:'요청 식별자가 다른 작업에 사용되었습니다.'},409);
    }
    const existing=await db.prepare("SELECT a.id,b.available_atoms FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL' AND a.bucket=? AND a.status='active'").bind(String(user.id),targetBucket).first<any>();
    const atoms=amount*10000;
    if(amount<0&&(!existing||Number(existing.available_atoms)<-atoms))
      return c.json({ok:false,error:'차감할 해당 TL 잔액이 부족합니다.'},409);
    // All new TL adjustments are true double-entry transactions. The
    // source/sink is explicit, while the member still receives exactly
    // the requested amount. Existing historic receipts remain immutable.
    const memberAccount=await ensureLedgerAccount(db,'user',String(user.id),'TL',targetBucket);
    const systemAccount=await ensureLedgerAccount(db,'system','v5-admin-adjustments','TL','issuance');
    // Positive issuance is prefunded solely in the same atomic D1 batch.
    // When negative, the system account receives returned nonredeemable TL.
    const issued=atoms>0?[db.prepare(`
      UPDATE v3_economy_balances
      SET available_atoms=available_atoms+?,version=version+1,updated_at=datetime('now')
      WHERE account_id=?`).bind(atoms,systemAccount)]:[];
    const posted=await postLedgerTransaction(db,{
      idempotencyKey:key,transactionType:'admin_adjustment',source:'admin',
      referenceType:'user',referenceId:String(user.id),actorUserId:String(adminId),
      description:reason,metadata:{adjustment_fingerprint:fingerprint,amount_atoms:atoms,
        bucket,non_redeemable:true,balanced:true},
      issuanceStatements:issued,
      lines:[
        {accountId:systemAccount,assetCode:'TL',amountAtoms:-atoms},
        {accountId:memberAccount,assetCode:'TL',amountAtoms:atoms}
      ]
    });
    return c.json({ok:true,replayed:posted.replayed,transaction_id:posted.id,
      bucket,amount,non_redeemable:true,balanced:true});
  }catch(e:any){
    const existing=await db.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>().catch(()=>null);
    if(existing){
      const recorded=await db.prepare('SELECT metadata_json FROM v3_economy_transactions WHERE id=?').bind(existing.id).first<any>().catch(()=>null);
      try{
        if(JSON.parse(recorded?.metadata_json||'{}').adjustment_fingerprint===fingerprint)
          return c.json({ok:true,replayed:true,transaction_id:existing.id});
      }catch(_){}
      return c.json({ok:false,code:'IDEMPOTENCY_CONFLICT',error:'요청 식별자가 다른 작업에 사용되었습니다.'},409);
    }
    return c.json({ok:false,error:e?.message||'TL 원장 반영 실패'},500);
  }
});

router.get('/tl/balances', async(c)=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const rows=await c.env.DB.prepare(`
      SELECT u.id,u.email,u.username,
        COALESCE(SUM(CASE WHEN a.bucket='wallet_paid' THEN b.available_atoms ELSE 0 END),0)/10000.0 AS tl_p,
        COALESCE(SUM(CASE WHEN a.bucket='wallet_ad' THEN b.available_atoms ELSE 0 END),0)/10000.0 AS tl_a,
        COALESCE(SUM(CASE WHEN a.bucket='wallet_bonus' THEN b.available_atoms ELSE 0 END),0)/10000.0 AS tl_b
      FROM users u LEFT JOIN v3_economy_accounts a ON a.owner_type='user'
        AND a.owner_id=CAST(u.id AS TEXT) AND a.asset_code='TL' AND a.status='active'
      LEFT JOIN v3_economy_balances b ON b.account_id=a.id
      GROUP BY u.id ORDER BY u.id DESC LIMIT 500
    `).all<any>();
    return c.json({ok:true,users:rows.results||[]});
  }catch(e:any){return c.json({ok:false,error:e?.message||'잔액 조회 실패'},503);}
});

// ── POST /api/admin/sql ──
// 관리자 전용 SQL 실행. DROP/ALTER/TRUNCATE는 차단.
router.post('/sql', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));
  const sql = String(body.sql || body.query || '').trim();
  if (!sql) return c.json({ error: 'sql 필요' }, 400);

  // 위험한 구문 차단 (DROP, ALTER, TRUNCATE, PRAGMA 등)
  const forbidden = /\b(DROP|ALTER|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;
  if (forbidden.test(sql)) {
    return c.json({ ok: false, error: '허용되지 않은 SQL 구문입니다.' }, 403);
  }

  // 여러 statement 차단 (세미콜론이 문자열 안에 있지 않은 경우)
  const stripped = sql.replace(/'(?:[^']|'')*'/g, '').replace(/"(?:[^"]|"")*"/g, '');
  if (stripped.includes(';') && stripped.trim().replace(/;+\s*$/, '').includes(';')) {
    return c.json({ ok: false, error: '여러 개의 SQL 문은 실행할 수 없습니다.' }, 400);
  }

  // A generic admin SQL console must never bypass V3 ledger invariants,
  // payout approvals, or immutable audit history. All writes use dedicated APIs.
  const normalized=stripped.replace(/\s+/g,' ').trim();
  const isSelect=/^SELECT\b/i.test(normalized)
    || (/^WITH\b/i.test(normalized)&&/\bSELECT\b/i.test(normalized)
        && !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|MERGE|UPSERT)\b/i.test(normalized));
  if(!isSelect)return c.json({ok:false,code:'ADMIN_SQL_READ_ONLY',
    error:'관리자 SQL은 조회만 가능합니다. 변경은 전용 관리자 승인 API를 사용하세요.'},403);
  try {
    const result=await c.env.DB.prepare(sql).all();
    return c.json({ok:true,results:result.results||[],rows:result.results||[],read_only:true});
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'SQL 실행 실패' }, 500);
  }
});

// ── POST /api/admin/settings/:key ── 설정 저장
router.post('/settings/:key', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  
  const key = c.req.param('key');
  const body = await c.req.json<any>().catch(() => ({}));
  const value = String(body.value || '');
  if (key === 'signup_hero') {
    if (value.length > 1400000) return c.json({ error: '이미지 크기 제한 초과' }, 413);
    let setting: any;
    try { setting = JSON.parse(value); } catch { return c.json({ error: '잘못된 이미지 설정' }, 400); }
    if (!setting || typeof setting.image !== 'string' ||
      (setting.image !== '' && !/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(setting.image))) {
      return c.json({ error: 'WebP 이미지 데이터만 허용됩니다.' }, 400);
    }
  }

  
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tl_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`
  ).run().catch(()=>{});
  
  await c.env.DB.prepare(
    `INSERT INTO tl_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value).run();
  
  return c.json({ ok: true });
});

// ── GET /api/admin/settings/:key ── 설정 조회
router.get('/settings/:key', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  
  const key = c.req.param('key');
  const row = await c.env.DB.prepare(
    'SELECT value FROM tl_settings WHERE key=?'
  ).bind(key).first<any>();
  
  return c.json({ value: row?.value || null });
});

// ══════════════════════════════════════════
// DJ 관리 (Admin)
// ══════════════════════════════════════════

// ── DJ 테이블 보장 ──
async function ensureDJTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    dj_name TEXT NOT NULL,
    bio TEXT DEFAULT '',
    genres TEXT DEFAULT '[]',
    mood TEXT DEFAULT '[]',
    avatar_url TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    instagram TEXT DEFAULT '',
    youtube TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    total_broadcasts INTEGER DEFAULT 0,
    total_listeners INTEGER DEFAULT 0,
    rating REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_cafe_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    schedule TEXT DEFAULT '[]',
    message TEXT DEFAULT '',
    cafe_message TEXT DEFAULT '',
    dj_rate REAL DEFAULT 0.3,
    cafe_rate REAL DEFAULT 0.5,
    revenue_share_dj REAL DEFAULT 0.5,
    revenue_share_cafe REAL DEFAULT 0.3,
    revenue_share_platform REAL DEFAULT 0.2,
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT,
    share_id TEXT,
    listeners INTEGER DEFAULT 0,
    seconds INTEGER DEFAULT 0,
    tl_charged REAL DEFAULT 0,
    revenue_dj REAL DEFAULT 0,
    revenue_cafe REAL DEFAULT 0,
    revenue_platform REAL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`).run().catch(()=>{});
}

// ── GET /api/admin/dj/list — 전체 DJ 목록 ──
router.get('/dj/list', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT d.*, u.email, u.username,
              (SELECT COUNT(*) FROM dj_cafe_links WHERE dj_id=d.id AND status='active') as active_contracts,
              (SELECT COUNT(*) FROM dj_cafe_links WHERE dj_id=d.id AND status='pending') as pending_apps
       FROM dj_profiles d
       LEFT JOIN users u ON d.user_id = u.id
       ORDER BY d.total_listeners DESC, d.rating DESC`
    ).all();
    return c.json({ ok: true, djs: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'DJ 목록 실패' }, 500);
  }
});

// ── GET /api/admin/dj/stats — DJ 통계 ──
router.get('/dj/stats', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const total = await c.env.DB.prepare('SELECT COUNT(*) cnt FROM dj_profiles').first<any>();
    const active = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_profiles WHERE status='active'").first<any>();
    const banned = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_profiles WHERE status='banned'").first<any>();
    const pending = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_cafe_links WHERE status='pending'").first<any>();
    const activeLinks = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_cafe_links WHERE status='active'").first<any>();
    return c.json({
      ok: true,
      stats: {
        total_djs: Number(total?.cnt || 0),
        active_djs: Number(active?.cnt || 0),
        banned_djs: Number(banned?.cnt || 0),
        pending_applications: Number(pending?.cnt || 0),
        active_links: Number(activeLinks?.cnt || 0)
      }
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '통계 실패' }, 500);
  }
});

// ── GET /api/admin/dj-links — 전체 매칭 목록 ──
router.get('/dj-links', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT l.*, d.dj_name, cc.name as cafe_name
       FROM dj_cafe_links l
       LEFT JOIN dj_profiles d ON l.dj_id = d.id
       LEFT JOIN cafe_channels cc ON l.cafe_channel_id = cc.channel_id
       ORDER BY l.created_at DESC LIMIT 200`
    ).all();
    return c.json({ ok: true, links: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '매칭 목록 실패' }, 500);
  }
});

// ── POST /api/admin/dj/:id/ban — DJ 정지 ──
router.post('/dj/:id/ban', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_profiles SET status='banned', updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '정지 실패' }, 500);
  }
});

// ── POST /api/admin/dj/:id/unban — DJ 해제 ──
router.post('/dj/:id/unban', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_profiles SET status='active', updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '해제 실패' }, 500);
  }
});

// ── POST /api/admin/dj-links/:id/force-end — 매칭 강제 종료 ──
router.post('/dj-links/:id/force-end', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_cafe_links SET status='ended', ended_at=?, updated_at=? WHERE id=?")
      .bind(Date.now(), Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '종료 실패' }, 500);
  }
});


/* Admin Center: read-only operational status, no writes or schema migrations. */
async function adminTableColumns(db: Env['DB'], table: string): Promise<string[]> {
  const rows=await db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{name:string}>();
  return (rows.results||[]).map(r=>String(r.name));
}
async function adminCount(db: Env['DB'],table:string,condition?:string):Promise<number|null>{
  const columns=await adminTableColumns(db,table);
  if(!columns.length)return null;
  const row=await db.prepare('SELECT COUNT(*) AS n FROM "'+table+'"'+(condition?' WHERE '+condition:'')).first<{n:number}>();
  return Number(row?.n??0);
}
async function adminSum(db:Env['DB'],table:string,column:string):Promise<number|null>{
  const cols=await adminTableColumns(db,table);
  if(!cols.includes(column))return null;
  const row=await db.prepare('SELECT SUM("'+column+'") AS n FROM "'+table+'"').first<{n:number|null}>();
  return Number(row?.n??0);
}
// Read-only music analytics; do not manufacture BPM or genre measurements.
router.get('/music/analytics',async c=>{
  try{
    const db=c.env.DB;
    const cols=await adminTableColumns(db,'tl_shares');
    if(!cols.includes('title'))return c.json({ok:true,available:false,totals:{total:null,pulse:null,avg_bpm:null},genres:[],bpm_dist:[],top_tracks:[]});
    const total=await adminCount(db,'tl_shares');
    const pulse=cols.includes('pulse')?await adminSum(db,'tl_shares','pulse'):null;
    const bpm=cols.includes('bpm')?await db.prepare('SELECT AVG(bpm) AS n FROM tl_shares WHERE bpm>0').first<{n:number|null}>():null;
    const genres=cols.includes('category')?(await db.prepare('SELECT category,COUNT(*) AS cnt FROM tl_shares GROUP BY category ORDER BY cnt DESC LIMIT 20').all()).results||[]:[];
    const bpmDist=cols.includes('bpm')?(await db.prepare(`SELECT CASE WHEN bpm IS NULL OR bpm<=0 THEN '미측정' WHEN bpm<90 THEN '느림' WHEN bpm<120 THEN '보통' WHEN bpm<150 THEN '신남' ELSE '빠름' END AS range,COUNT(*) AS cnt FROM tl_shares GROUP BY 1 ORDER BY 1`).all()).results||[]:[];
    const wanted=['title','artist','category','bpm','pulse','file_tl'];
    const projection=wanted.map(k=>cols.includes(k)?'"'+k+'"':'NULL AS "'+k+'"').join(',');
    const sort=cols.includes('pulse')?'pulse DESC':'rowid DESC';
    const tracks=(await db.prepare('SELECT '+projection+' FROM tl_shares ORDER BY '+sort+' LIMIT 20').all()).results||[];
    return c.json({ok:true,available:true,totals:{total,pulse,avg_bpm:bpm?.n??null},genres,bpm_dist:bpmDist,top_tracks:tracks});
  }catch(error){console.error('[ADMIN_MUSIC_ANALYTICS]',error);return c.json({ok:false,error:'MUSIC_ANALYTICS_UNAVAILABLE'},503);}
});
router.get('/realtime',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const db=c.env.DB;
    const [userCount,shareCount,pulse,fileTl,cafes]=await Promise.all([
      adminCount(db,'users'),adminCount(db,'tl_shares'),adminSum(db,'tl_shares','pulse'),
      adminSum(db,'tl_shares','file_tl'),adminCount(db,'cafe_channels')
    ]);
    const sharesCols=await adminTableColumns(db,'tl_shares');
    let topTracks:any[]=[];
    if(['title','pulse'].every(x=>sharesCols.includes(x))){
      const artist=sharesCols.includes('artist')?'artist':'NULL AS artist';
      const rows=await db.prepare('SELECT title,'+artist+',pulse FROM tl_shares ORDER BY pulse DESC LIMIT 10').all();
      topTracks=rows.results||[];
    }
    return c.json({ok:true,as_of:new Date().toISOString(),
      users:{total:userCount,total_tl:null},
      shares:{total:shareCount,total_pulse:pulse,total_file_tl:fileTl},
      today:{payments:null,revenue_krw:null},cafe_channels:cafes,top_tracks:topTracks,
      unavailable:['users.total_tl','today.payments','today.revenue_krw']
    });
  }catch(e:any){return c.json({ok:false,error:'실시간 데이터 조회 실패',detail:String(e?.message||'')},503);}
});
// Korean accounting sidecar: administrator only; no wallet debit, bank transfer or tax filing.
router.get('/finance/kr',async c=>{
 try{
  const month=String(c.req.query('month')||new Date(Date.now()+9*3600000).toISOString().slice(0,7));
  const [report,creator]=await Promise.all([readKrFinance(c.env.DB,month),readCreatorPayoutReport(c.env.DB)]);
  return c.json({...report,creator_economy:{lifetime_earned_tl:creator.summary.earned_tl,valuation_status:'회계 의무 평가·기표 전 금액을 원화 확정 부채로 자동 전환하지 않습니다.'}});
 }catch(e:any){return c.json({ok:false,error:e.message||'회계 조회 실패'},503);}
});
router.get('/finance/kr/journals/:id',async c=>{
 const journal=await c.env.DB.prepare("SELECT * FROM v5_kr_journals WHERE id=? AND status='posted'").bind(c.req.param('id')).first();
 if(!journal)return c.json({ok:false,error:'전표 없음'},404);
 const lines=await c.env.DB.prepare('SELECT l.account,a.name,l.amount_krw FROM v5_kr_lines l JOIN v5_kr_accounts a ON a.code=l.account WHERE l.journal_id=? ORDER BY l.id').bind(c.req.param('id')).all();
 return c.json({ok:true,journal,lines:lines.results||[]});
});
router.post('/finance/kr/:action',async c=>{
 const actor=await requireAdmin(c);if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 try{
  const body=await c.req.json<any>();const action=c.req.param('action');
  let data:unknown;
  if(action==='policy')data=await saveKrPolicy(c.env.DB,body,actor);
  else if(action==='tax-profile')data=await saveKrProfile(c.env.DB,body,actor);
  else if(action==='journal')data=await postKrJournal(c.env.DB,body,actor);
  else if(action==='close-period')data=await closeKrPeriod(c.env.DB,body,actor);
  else if(action==='tax-preview'){
   if(body.kind==='vat')data=krVat(body.gross_krw,body.vat_type);
   else if(body.kind==='corporate')data=krCorporate(body);
   else if(body.kind==='withholding'){
    const profile=await c.env.DB.prepare('SELECT * FROM v5_kr_tax_profiles WHERE user_id=?').bind(Number(body.user_id)).first();
    data=krWithholding(body,profile||{});
   }else return c.json({ok:false,error:'세금 유형 확인 필요'},400);
  }else return c.json({ok:false,error:'지원하지 않는 작업'},404);
  return c.json({ok:true,data});
 }catch(e:any){return c.json({ok:false,error:e.message||'회계 처리 실패'},400);}
});

router.get('/revenue',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{return c.json(await readAdminFinance(c.env.DB));}
  catch(error:any){console.error('[ADMIN_FINANCE]',error);return c.json({ok:false,code:'FINANCE_UNAVAILABLE',error:'결제 영수증 집계 실패',detail:String(error?.message||'')},503);}
});
router.get('/creators/payouts',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{return c.json(await readCreatorPayoutReport(c.env.DB));}
  catch(error:any){console.error('[CREATOR_PAYOUT_REPORT]',error);return c.json({ok:false,code:'CREATOR_REPORT_UNAVAILABLE',error:'V5 창작 수익 원장을 조회하지 못했습니다.',detail:String(error?.message||'')},503);}
});


/**
 * Read-only finance source inventory. Never exposes customer rows or payment secrets.
 * Explicitly does not compute financial totals until source semantics are verified.
 */
router.get('/finance/source-audit',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const db=c.env.DB;
    const candidates=[
      'v3_economy_assets','v3_economy_accounts','v3_economy_balances',
      'v3_economy_transactions','v3_economy_entries',
      'v3_economy_legacy_imports','v3_tlc_mining_records',
      'payments','payment_orders','payment_transactions',
      'tl_payments','tl_charge_orders','creator_payouts','payout_requests',
      'tl_shares','users'
    ];
    const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+
      candidates.map(() => '?').join(',')+")").bind(...candidates).all<{name:string}>();
    const present=new Set((rows.results||[]).map(r=>r.name));
    const sources=await Promise.all(candidates.map(async name=>{
      if(!present.has(name))return {name,exists:false,columns:[] as string[]};
      const columns=await adminTableColumns(db,name);
      return {name,exists:true,columns};
    }));
    const assetRows=present.has('v3_economy_assets')
      ? await db.prepare('SELECT asset_code,decimals FROM v3_economy_assets').all<{asset_code:string,decimals:number}>()
      : null;
    return c.json({ok:true,as_of:new Date().toISOString(),read_only:true,
      verified_financial_totals:false,receipt_report_available:true,
      sources,assets:assetRows?.results||[],
      next_step:'재무 현황에서 PG 영수증 매출 확인 가능. 환불·PG 입금액은 별도 대사 필요'});
  }catch(e:any){return c.json({ok:false,error:'재무 원천 테이블 검사 실패',detail:String(e?.message||'')},503);}
});


/* Administrator-only, read-only ledger integrity checks; no financial totals inferred. */
router.get('/finance/ledger-integrity',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const db=c.env.DB;
    const required=['v3_economy_assets','v3_economy_accounts','v3_economy_balances','v3_economy_transactions','v3_economy_entries'];
    const missing:string[]=[];
    for(const table of required){if(!(await adminTableColumns(db,table)).length)missing.push(table);}
    if(missing.length)return c.json({ok:false,code:'LEDGER_SCHEMA_INCOMPLETE',missing,error:'V5 경제원장 테이블이 누락되었습니다.'},503);
    const [types,imbalanced,orphans,assets]=await Promise.all([
      db.prepare("SELECT transaction_type,COUNT(*) AS count FROM v3_economy_transactions GROUP BY transaction_type ORDER BY count DESC LIMIT 100").all(),
      db.prepare("SELECT COUNT(*) AS count FROM (SELECT e.transaction_id,e.asset_code,SUM(e.amount_atoms) AS balance FROM v3_economy_entries e GROUP BY e.transaction_id,e.asset_code HAVING balance <> 0)").first<{count:number}>(),
      db.prepare("SELECT COUNT(*) AS count FROM v3_economy_entries e LEFT JOIN v3_economy_transactions t ON t.id=e.transaction_id WHERE t.id IS NULL").first<{count:number}>(),
      db.prepare("SELECT asset_code,decimals FROM v3_economy_assets ORDER BY asset_code").all()
    ]);
    const tl=(assets.results||[]).find((a:any)=>a.asset_code==='TL') as any;
    return c.json({ok:true,as_of:new Date().toISOString(),read_only:true,
      ledger_integrity:{imbalanced_transaction_assets:Number(imbalanced?.count||0),
        orphan_entries:Number(orphans?.count||0),tl_precision_ready:Number(tl?.decimals)===4},
      transaction_types:types.results||[],assets:assets.results||[],
      financial_totals_verified:false,
      note:'거래 유형은 원장 기록의 분류이며 매출·정산 금액을 뜻하지 않습니다.'});
  }catch(e:any){return c.json({ok:false,error:'원장 무결성 조회 실패',detail:String(e?.message||'')},503);}
});


// Browser-safe admin timeline: JWT authorization, never expose broadcaster secret.
router.get('/central-broadcast/stations/:country/now', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!(country in TILO_ZONES))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const serviceId='central-tilo-'+adminId;
  try{
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?').bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:true,country,enabled:false,slot:null});
    const result=await c.env.DB.prepare(`
      SELECT v.file_id,v.duration_ms,f.title,f.artist
      FROM central_broadcast_service_file_grants sg
      JOIN tl3_v5_releases v ON v.file_id=sg.file_id
      JOIN tl_files f ON f.id=v.file_id
      WHERE sg.service_id=? AND sg.country=? AND sg.status='active'
      AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now'))
      AND v.status='sealed' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0
      AND LOWER(f.file_type)='audio/tl3'
      AND EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?
        AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
      AND EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved'))
      ORDER BY v.file_id ASC LIMIT 200
    `).bind(serviceId,country,country).all<{file_id:number;duration_ms:number;title:string;artist:string}>();
    const now=new Date();
    return c.json({ok:true,country,enabled:true,serverTime:now.toISOString(),
      timeZone:TILO_ZONES[country as TiloCountry],show:tiloLocalShow(country as TiloCountry,now),
      slot:currentTiloSlot(result.results||[],now.getTime(),Date.UTC(2026,0,1)),
      note:'Clock metadata only; not proof of actual playback.'});
  }catch(error){console.error('[TILO_ADMIN_NOW]',error);return c.json({ok:false,error:'TIMELINE_UNAVAILABLE'},503);}
});

export default router;
) END`)
      .bind(country,...fileIds,serviceId,country,...fileIds);
    const statements:D1PreparedStatement[]=[guard];
    for(const fileId of fileIds){
      statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO central_broadcast_rights_grants
        (grant_id,file_id,creator_id,country,status) VALUES(?,?,?,?,'active')`
      ).bind('creator-admin:'+adminId+':'+fileId+':'+country,fileId,adminId,country));
      statements.push(c.env.DB.prepare(`INSERT INTO central_broadcast_service_file_grants
        (service_id,file_id,country,permission,status,granted_by_admin_user_id)
        VALUES(?,?,?,'stream','active',?)
        ON CONFLICT(service_id,file_id,country) DO UPDATE SET status='active',
          granted_by_admin_user_id=excluded.granted_by_admin_user_id`
      ).bind(serviceId,fileId,country,adminId));
    }
    const eventId=crypto.randomUUID();
    statements.push(c.env.DB.prepare(`INSERT INTO tilo_v5_country_grant_audit
      (event_id,actor_user_id,service_id,country,file_ids_json,verified_count)
      VALUES (?,?,?,?,?,?)`).bind(eventId,adminId,serviceId,country,
        JSON.stringify(fileIds),fileIds.length));
    await c.env.DB.batch(statements);
    return c.json({ok:true,country,service_id:serviceId,authorized: fileIds.length,
      file_ids:fileIds,audit_event_id:eventId,settlement_posted:false});
  }catch(error){
    console.error('[TILO_COUNTRY_BULK_GRANT]',error);
    return c.json({ok:false,error:'BROADCAST_BULK_GRANT_FAILED'},503);
  }
});

/** Read-only candidate audit: reports why published SharePlace V5 files are excluded. */
router.get('/central-broadcast/stations/:country/audit', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  try{
    await ensureCentralBroadcastSchema(c.env.DB);
    const rows=await c.env.DB.prepare(`SELECT f.id AS file_id,f.title,f.file_type,f.shared,
      f.user_id AS owner_user_id,COALESCE(f.revenue_held,0) AS revenue_held,
      v.status AS v5_status,v.duration_ms,
      CASE WHEN EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=f.id AND cm.user_id=f.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved')) THEN 1 ELSE 0 END AS release_rights,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=f.id AND rg.creator_id=f.user_id AND rg.country=?
          AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
        THEN 1 ELSE 0 END AS country_broadcast_rights,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_service_file_grants sg
        WHERE sg.service_id=? AND sg.file_id=f.id AND sg.country=?
          AND sg.status='active' AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now')))
        THEN 1 ELSE 0 END AS service_granted,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=f.id AND rg.creator_id=f.user_id AND rg.country=?
          AND (rg.status<>'active' OR (rg.expires_at IS NOT NULL
            AND rg.expires_at<=datetime('now'))))
        THEN 1 ELSE 0 END AS rights_blocked
      FROM tl_files f LEFT JOIN tl3_v5_releases v ON v.file_id=f.id
      WHERE f.shared=1 ORDER BY f.id DESC LIMIT 100`)
      .bind(country,'central-tilo-'+adminId,country,country).all<any>();
    const tracks=(rows.results||[]).map(r=>{
      const reasons:string[]=[];
      if(!r.v5_status)reasons.push('NO_V5_RELEASE');
      else if(r.v5_status!=='sealed')reasons.push('V5_NOT_SEALED');
      if(!r.release_rights)reasons.push('SHAREPLACE_RELEASE_RIGHTS_MISSING');
      if(!r.country_broadcast_rights)reasons.push('COUNTRY_BROADCAST_RIGHTS_MISSING');
      if(!r.service_granted)reasons.push('COUNTRY_SERVICE_GRANT_MISSING');
      if(r.rights_blocked)reasons.push('BROADCAST_RIGHTS_BLOCKED');
      if(Number(r.revenue_held||0)!==0)reasons.push('REVENUE_HOLD');
      if(String(r.file_type||'').toLowerCase()!=='audio/tl3')reasons.push('FILE_TYPE_NOT_TL3');
      const canGrant=Number(r.owner_user_id)===adminId &&
        r.v5_status==='sealed'&&Number(r.release_rights)===1&&
        Number(r.revenue_held||0)===0&&!r.rights_blocked &&
        String(r.file_type||'').toLowerCase()==='audio/tl3'&&
        reasons.some(x=>x==='COUNTRY_BROADCAST_RIGHTS_MISSING'||x==='COUNTRY_SERVICE_GRANT_MISSING');
      return {file_id:r.file_id,title:r.title,reasons,eligible:reasons.length===0,
        can_grant:!!canGrant,owner_is_admin:Number(r.owner_user_id)===adminId};
    });
    return c.json({ok:true,country,total:tracks.length,eligible:tracks.filter(x=>x.eligible).length,tracks});
  }catch(e:any){
    console.error('[TILO_CANDIDATE_AUDIT]',String(e?.message||e));
    return c.json({ok:false,error:'BROADCAST_AUDIT_FAILED'},503);
  }
});

router.get('/central-broadcast/stations/:country', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  const languages:Record<string,string>={KR:'ko-KR',JP:'ja-JP',US:'en-US',CN:'zh-CN',TH:'th-TH',VN:'vi-VN'};
  if(!languages[country])return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const serviceId='central-tilo-'+adminId;
  try {
    await ensureCentralBroadcastSchema(c.env.DB);
    await c.env.DB.prepare(`INSERT INTO central_broadcast_service_accounts
      (service_id,parent_admin_user_id,display_name,status) VALUES (?,?,'TILO Central Broadcast','active')
      ON CONFLICT(service_id) DO NOTHING`).bind(serviceId,adminId).run();
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind(serviceId,adminId).first<{status:string}>();
    const grants={results:await permittedStationTracks(c.env.DB,country,adminId)};
    return c.json({ok:true,country,locale:languages[country],service_enabled:service?.status==='active',
      granted_file_ids:(grants.results||[]).map(g=>g.file_id),
      stream_ready:(grants.results||[]).length>0,reason:(grants.results||[]).length?'READY_FOR_BROWSER_TEST':'NO_ELIGIBLE_V5_TRACKS',
      note:'Auto-selected from published sealed V5 SharePlace tracks. Country station remains administrator-controlled; no listener billing.'});
   }catch(e:any){
    const message=String(e?.message||e||'unknown');
    console.error('[TILO_STATION_SCHEMA]',{country,error:message});
    const missing=message.match(/no such (?:table|column):\\s*([A-Za-z0-9_.]+)/i);
    return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY',
      detail:missing?'MISSING_SCHEMA_OBJECT: '+missing[1]:'Database query failed; inspect Worker logs',
      migration_hint:'Apply pending central_broadcast_rights_grants.sql and central_broadcast_service_identity_v5.sql migrations to the configured remote D1 database.'},503);
  }
});

/** Admin-owned TILO service switch; never bills listeners or grants audio downloads. */
router.get('/central-broadcast/tilo', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  try {
    const row=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind('central-tilo-'+adminId,adminId).first<{status:string}>();
    return c.json({ok:true,enabled:row?.status==='active',service_id:'central-tilo-'+adminId});
  }catch(_){return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY'},503)}
});
router.post('/central-broadcast/tilo', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const body=await c.req.json().catch(()=>null) as {enabled?:unknown}|null;
  if(typeof body?.enabled!=='boolean')return c.json({ok:false,error:'INVALID_ENABLED'},400);
  const serviceId='central-tilo-'+adminId;
  const status=body.enabled?'active':'disabled';
  try {
    await c.env.DB.prepare(`INSERT INTO central_broadcast_service_accounts
      (service_id,parent_admin_user_id,display_name,status)
      VALUES (?,?,'TILO Central Broadcast',?)
      ON CONFLICT(service_id) DO UPDATE SET status=excluded.status,updated_at=datetime('now')
      WHERE parent_admin_user_id=excluded.parent_admin_user_id`)
      .bind(serviceId,adminId,status).run();
    return c.json({ok:true,enabled:body.enabled,service_id:serviceId,broadcast_connected:false});
  }catch(_){return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY'},503)}
});

// Dedicated, read-only admin session verification.
router.get('/session', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ ok: false, error: '관리자 권한 필요' }, 403);
  return c.json({ ok: true, user_id: userId, role: 'admin' });
});

// Read-only preflight for the one-time development TL issuance.
router.get('/tl/initial-issuance/status', async (c) => {
  const adminId=await requireAdmin(c);
  if(!adminId) return c.json({ok:false,error:'관리자 권한 필요'},403);
  try {
    const db=c.env.DB;
    const [scale,tx,tlAccounts,legacy]=await Promise.all([
      db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>(),
      db.prepare("SELECT COUNT(*) AS n FROM v3_economy_transactions").first<any>(),
      db.prepare("SELECT COUNT(*) AS n FROM v3_economy_accounts WHERE asset_code='TL'").first<any>(),
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE COALESCE(tl,0)<>0 OR COALESCE(tl_p,0)<>0 OR COALESCE(tl_a,0)<>0 OR COALESCE(tl_b,0)<>0 OR COALESCE(tl_balance,0)<>0").first<any>()
    ]);
    const ready=Number(scale?.decimals)===4 && Number(tx?.n)===0 && Number(tlAccounts?.n)===0;
    return c.json({ok:true,admin_user_id:adminId,tl_decimals:Number(scale?.decimals??-1),v3_transactions:Number(tx?.n||0),v3_tl_accounts:Number(tlAccounts?.n||0),legacy_users_with_tl:Number(legacy?.n||0),initial_issuance_ready:ready,legacy_tl_not_reset:Number(legacy?.n||0)>0});
  }catch(e:any){return c.json({ok:false,error:e?.message||'원장 상태 확인 실패'},500);}
});

// One-time development bootstrap: only on a completely empty V5 경제원장 TL ledger.
// Does not touch legacy balances, TLC, POC, or TON state.
router.post('/tl/initial-issuance', async (c) => {
  const adminId = await requireAdmin(c);
  if (!adminId) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const confirmation = String((await c.req.json<any>().catch(()=>({}))).confirmation || '');
  if (confirmation !== 'ISSUE_INITIAL_1000000_TL') {
    return c.json({ok:false,error:'명시적 최초 지급 확인 문구가 필요합니다.'},400);
  }
  const db=c.env.DB;
  try {
    const scale=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>();
    if (Number(scale?.decimals)!==4) return c.json({ok:false,error:'TL 정밀도가 4가 아닙니다.'},409);
    const existing=await db.prepare("SELECT COUNT(*) AS n FROM v3_economy_transactions").first<any>();
    const accounts=await db.prepare("SELECT COUNT(*) AS n FROM v3_economy_accounts WHERE asset_code='TL'").first<any>();
    if(Number(existing?.n)!==0||Number(accounts?.n)!==0) {
      return c.json({ok:false,code:'TL_LEDGER_NOT_EMPTY',error:'V5 경제원장이 비어 있지 않습니다. 중복 발행을 방지하기 위해 중단했습니다.'},409);
    }
    const accountId=crypto.randomUUID();
    const sourceId=crypto.randomUUID();
    const transactionId=crypto.randomUUID();
    const atoms=1000000*10000;
    // One-time issuance is not a transfer: record a positive mint entry and provenance.
    // Atomic batch prevents an issuance transaction without its wallet credit.
    await db.batch([
      db.prepare("INSERT INTO v3_economy_accounts(id,owner_type,owner_id,asset_code,bucket) VALUES (?,'user',?,'TL','wallet_bonus')").bind(accountId,String(adminId)),
      db.prepare("INSERT INTO v3_economy_accounts(id,owner_type,owner_id,asset_code,bucket) VALUES (?,'system','v5-initial-bootstrap','TL','issuance')").bind(sourceId),
      db.prepare("INSERT INTO v3_economy_balances(account_id,available_atoms) VALUES (?,?)").bind(accountId,atoms),
      db.prepare("INSERT INTO v3_economy_balances(account_id,available_atoms) VALUES (?,0)").bind(sourceId),
      db.prepare("INSERT INTO v3_economy_transactions(id,idempotency_key,transaction_type,source,reference_type,reference_id,actor_user_id,description,metadata_json) VALUES (?,'initial_dev_tl_issuance_20261022','initial_issuance','admin','user',?,?,'관리자 개발용 최초 TL 1,000,000 지급',?)").bind(transactionId,String(adminId),String(adminId),JSON.stringify({amount_atoms:atoms,non_redeemable:true,development_only:true})),
      db.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES (?,?,'TL',?)").bind(transactionId,accountId,atoms),
      db.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES (?,?,'TL',?)").bind(transactionId,sourceId,-atoms)
    ]);
    return c.json({ok:true,admin_user_id:adminId,issued_tl:1000000,bucket:'wallet_bonus',development_only:true});
  }catch(e:any){return c.json({ok:false,error:e?.message||'최초 TL 지급 실패'},500);}
});


/** V5 경제원장 TL bucket adjustments. Never update legacy users.tl / tl_balance here. */
router.post('/tl/adjust', async (c) => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'관리자 권한 필요'},403);
  const body=await c.req.json<any>().catch(()=>({}));
  const email=String(body.email||'').trim().toLowerCase();
  const bucket=String(body.bucket||'');
  const amount=Number(body.amount);
  const reason=String(body.reason||'').trim();
  const key=String(body.idempotency_key||'');
  if(!email||email==='all'||!['tl_p','tl_a','tl_b'].includes(bucket)||
     !Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1000000||
     reason.length<5||reason.length>300||!/^admin-tl-[a-zA-Z0-9-]{12,100}$/.test(key))
    return c.json({ok:false,error:'대상, TL 종류, 금액(최대 100만), 사유(5자 이상), 요청 식별자를 확인하세요.'},400);
  // Paid TL is backed by real payment; manual issuance must not fabricate redeemable funds.
  if(bucket==='tl_p')return c.json({ok:false,error:'TL_P는 실결제·정산 원장으로만 처리합니다. 관리자 임의 충전/차감은 금지됩니다.'},403);
  const db=c.env.DB;
  let fingerprint='';
  try{
    const scale=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>();
    if(Number(scale?.decimals)!==4)return c.json({ok:false,error:'V5 경제원장 TL 정밀도 마이그레이션 미완료'},409);
    const user=await db.prepare('SELECT id FROM users WHERE lower(email)=?').bind(email).first<any>();
    if(!user)return c.json({ok:false,error:'회원을 찾을 수 없습니다.'},404);
    const targetBucket=bucket==='tl_a'?'wallet_ad':'wallet_bonus';
    const prior=await db.prepare('SELECT id,metadata_json FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>();
    fingerprint=JSON.stringify({user_id:Number(user.id),bucket,amount,reason,admin_id:adminId});
    if(prior){
      const meta=JSON.parse(prior.metadata_json||'{}');
      return meta.adjustment_fingerprint===fingerprint
        ?c.json({ok:true,replayed:true,transaction_id:prior.id})
        :c.json({ok:false,error:'요청 식별자가 다른 작업에 사용되었습니다.'},409);
    }
    const existing=await db.prepare("SELECT a.id,b.available_atoms FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL' AND a.bucket=? AND a.status='active'").bind(String(user.id),targetBucket).first<any>();
    const atoms=amount*10000;
    if(amount<0&&(!existing||Number(existing.available_atoms)<-atoms))
      return c.json({ok:false,error:'차감할 해당 TL 잔액이 부족합니다.'},409);
    // All new TL adjustments are true double-entry transactions. The
    // source/sink is explicit, while the member still receives exactly
    // the requested amount. Existing historic receipts remain immutable.
    const memberAccount=await ensureLedgerAccount(db,'user',String(user.id),'TL',targetBucket);
    const systemAccount=await ensureLedgerAccount(db,'system','v5-admin-adjustments','TL','issuance');
    // Positive issuance is prefunded solely in the same atomic D1 batch.
    // When negative, the system account receives returned nonredeemable TL.
    const issued=atoms>0?[db.prepare(`
      UPDATE v3_economy_balances
      SET available_atoms=available_atoms+?,version=version+1,updated_at=datetime('now')
      WHERE account_id=?`).bind(atoms,systemAccount)]:[];
    const posted=await postLedgerTransaction(db,{
      idempotencyKey:key,transactionType:'admin_adjustment',source:'admin',
      referenceType:'user',referenceId:String(user.id),actorUserId:String(adminId),
      description:reason,metadata:{adjustment_fingerprint:fingerprint,amount_atoms:atoms,
        bucket,non_redeemable:true,balanced:true},
      issuanceStatements:issued,
      lines:[
        {accountId:systemAccount,assetCode:'TL',amountAtoms:-atoms},
        {accountId:memberAccount,assetCode:'TL',amountAtoms:atoms}
      ]
    });
    return c.json({ok:true,replayed:posted.replayed,transaction_id:posted.id,
      bucket,amount,non_redeemable:true,balanced:true});
  }catch(e:any){
    const existing=await db.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>().catch(()=>null);
    if(existing){
      const recorded=await db.prepare('SELECT metadata_json FROM v3_economy_transactions WHERE id=?').bind(existing.id).first<any>().catch(()=>null);
      try{
        if(JSON.parse(recorded?.metadata_json||'{}').adjustment_fingerprint===fingerprint)
          return c.json({ok:true,replayed:true,transaction_id:existing.id});
      }catch(_){}
      return c.json({ok:false,code:'IDEMPOTENCY_CONFLICT',error:'요청 식별자가 다른 작업에 사용되었습니다.'},409);
    }
    return c.json({ok:false,error:e?.message||'TL 원장 반영 실패'},500);
  }
});

router.get('/tl/balances', async(c)=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const rows=await c.env.DB.prepare(`
      SELECT u.id,u.email,u.username,
        COALESCE(SUM(CASE WHEN a.bucket='wallet_paid' THEN b.available_atoms ELSE 0 END),0)/10000.0 AS tl_p,
        COALESCE(SUM(CASE WHEN a.bucket='wallet_ad' THEN b.available_atoms ELSE 0 END),0)/10000.0 AS tl_a,
        COALESCE(SUM(CASE WHEN a.bucket='wallet_bonus' THEN b.available_atoms ELSE 0 END),0)/10000.0 AS tl_b
      FROM users u LEFT JOIN v3_economy_accounts a ON a.owner_type='user'
        AND a.owner_id=CAST(u.id AS TEXT) AND a.asset_code='TL' AND a.status='active'
      LEFT JOIN v3_economy_balances b ON b.account_id=a.id
      GROUP BY u.id ORDER BY u.id DESC LIMIT 500
    `).all<any>();
    return c.json({ok:true,users:rows.results||[]});
  }catch(e:any){return c.json({ok:false,error:e?.message||'잔액 조회 실패'},503);}
});

// ── POST /api/admin/sql ──
// 관리자 전용 SQL 실행. DROP/ALTER/TRUNCATE는 차단.
router.post('/sql', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));
  const sql = String(body.sql || body.query || '').trim();
  if (!sql) return c.json({ error: 'sql 필요' }, 400);

  // 위험한 구문 차단 (DROP, ALTER, TRUNCATE, PRAGMA 등)
  const forbidden = /\b(DROP|ALTER|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;
  if (forbidden.test(sql)) {
    return c.json({ ok: false, error: '허용되지 않은 SQL 구문입니다.' }, 403);
  }

  // 여러 statement 차단 (세미콜론이 문자열 안에 있지 않은 경우)
  const stripped = sql.replace(/'(?:[^']|'')*'/g, '').replace(/"(?:[^"]|"")*"/g, '');
  if (stripped.includes(';') && stripped.trim().replace(/;+\s*$/, '').includes(';')) {
    return c.json({ ok: false, error: '여러 개의 SQL 문은 실행할 수 없습니다.' }, 400);
  }

  // A generic admin SQL console must never bypass V3 ledger invariants,
  // payout approvals, or immutable audit history. All writes use dedicated APIs.
  const normalized=stripped.replace(/\s+/g,' ').trim();
  const isSelect=/^SELECT\b/i.test(normalized)
    || (/^WITH\b/i.test(normalized)&&/\bSELECT\b/i.test(normalized)
        && !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|MERGE|UPSERT)\b/i.test(normalized));
  if(!isSelect)return c.json({ok:false,code:'ADMIN_SQL_READ_ONLY',
    error:'관리자 SQL은 조회만 가능합니다. 변경은 전용 관리자 승인 API를 사용하세요.'},403);
  try {
    const result=await c.env.DB.prepare(sql).all();
    return c.json({ok:true,results:result.results||[],rows:result.results||[],read_only:true});
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'SQL 실행 실패' }, 500);
  }
});

// ── POST /api/admin/settings/:key ── 설정 저장
router.post('/settings/:key', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  
  const key = c.req.param('key');
  const body = await c.req.json<any>().catch(() => ({}));
  const value = String(body.value || '');
  if (key === 'signup_hero') {
    if (value.length > 1400000) return c.json({ error: '이미지 크기 제한 초과' }, 413);
    let setting: any;
    try { setting = JSON.parse(value); } catch { return c.json({ error: '잘못된 이미지 설정' }, 400); }
    if (!setting || typeof setting.image !== 'string' ||
      (setting.image !== '' && !/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(setting.image))) {
      return c.json({ error: 'WebP 이미지 데이터만 허용됩니다.' }, 400);
    }
  }

  
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tl_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`
  ).run().catch(()=>{});
  
  await c.env.DB.prepare(
    `INSERT INTO tl_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value).run();
  
  return c.json({ ok: true });
});

// ── GET /api/admin/settings/:key ── 설정 조회
router.get('/settings/:key', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  
  const key = c.req.param('key');
  const row = await c.env.DB.prepare(
    'SELECT value FROM tl_settings WHERE key=?'
  ).bind(key).first<any>();
  
  return c.json({ value: row?.value || null });
});

// ══════════════════════════════════════════
// DJ 관리 (Admin)
// ══════════════════════════════════════════

// ── DJ 테이블 보장 ──
async function ensureDJTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    dj_name TEXT NOT NULL,
    bio TEXT DEFAULT '',
    genres TEXT DEFAULT '[]',
    mood TEXT DEFAULT '[]',
    avatar_url TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    instagram TEXT DEFAULT '',
    youtube TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    total_broadcasts INTEGER DEFAULT 0,
    total_listeners INTEGER DEFAULT 0,
    rating REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_cafe_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    schedule TEXT DEFAULT '[]',
    message TEXT DEFAULT '',
    cafe_message TEXT DEFAULT '',
    dj_rate REAL DEFAULT 0.3,
    cafe_rate REAL DEFAULT 0.5,
    revenue_share_dj REAL DEFAULT 0.5,
    revenue_share_cafe REAL DEFAULT 0.3,
    revenue_share_platform REAL DEFAULT 0.2,
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT,
    share_id TEXT,
    listeners INTEGER DEFAULT 0,
    seconds INTEGER DEFAULT 0,
    tl_charged REAL DEFAULT 0,
    revenue_dj REAL DEFAULT 0,
    revenue_cafe REAL DEFAULT 0,
    revenue_platform REAL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`).run().catch(()=>{});
}

// ── GET /api/admin/dj/list — 전체 DJ 목록 ──
router.get('/dj/list', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT d.*, u.email, u.username,
              (SELECT COUNT(*) FROM dj_cafe_links WHERE dj_id=d.id AND status='active') as active_contracts,
              (SELECT COUNT(*) FROM dj_cafe_links WHERE dj_id=d.id AND status='pending') as pending_apps
       FROM dj_profiles d
       LEFT JOIN users u ON d.user_id = u.id
       ORDER BY d.total_listeners DESC, d.rating DESC`
    ).all();
    return c.json({ ok: true, djs: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'DJ 목록 실패' }, 500);
  }
});

// ── GET /api/admin/dj/stats — DJ 통계 ──
router.get('/dj/stats', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const total = await c.env.DB.prepare('SELECT COUNT(*) cnt FROM dj_profiles').first<any>();
    const active = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_profiles WHERE status='active'").first<any>();
    const banned = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_profiles WHERE status='banned'").first<any>();
    const pending = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_cafe_links WHERE status='pending'").first<any>();
    const activeLinks = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_cafe_links WHERE status='active'").first<any>();
    return c.json({
      ok: true,
      stats: {
        total_djs: Number(total?.cnt || 0),
        active_djs: Number(active?.cnt || 0),
        banned_djs: Number(banned?.cnt || 0),
        pending_applications: Number(pending?.cnt || 0),
        active_links: Number(activeLinks?.cnt || 0)
      }
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '통계 실패' }, 500);
  }
});

// ── GET /api/admin/dj-links — 전체 매칭 목록 ──
router.get('/dj-links', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT l.*, d.dj_name, cc.name as cafe_name
       FROM dj_cafe_links l
       LEFT JOIN dj_profiles d ON l.dj_id = d.id
       LEFT JOIN cafe_channels cc ON l.cafe_channel_id = cc.channel_id
       ORDER BY l.created_at DESC LIMIT 200`
    ).all();
    return c.json({ ok: true, links: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '매칭 목록 실패' }, 500);
  }
});

// ── POST /api/admin/dj/:id/ban — DJ 정지 ──
router.post('/dj/:id/ban', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_profiles SET status='banned', updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '정지 실패' }, 500);
  }
});

// ── POST /api/admin/dj/:id/unban — DJ 해제 ──
router.post('/dj/:id/unban', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_profiles SET status='active', updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '해제 실패' }, 500);
  }
});

// ── POST /api/admin/dj-links/:id/force-end — 매칭 강제 종료 ──
router.post('/dj-links/:id/force-end', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_cafe_links SET status='ended', ended_at=?, updated_at=? WHERE id=?")
      .bind(Date.now(), Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '종료 실패' }, 500);
  }
});


/* Admin Center: read-only operational status, no writes or schema migrations. */
async function adminTableColumns(db: Env['DB'], table: string): Promise<string[]> {
  const rows=await db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{name:string}>();
  return (rows.results||[]).map(r=>String(r.name));
}
async function adminCount(db: Env['DB'],table:string,condition?:string):Promise<number|null>{
  const columns=await adminTableColumns(db,table);
  if(!columns.length)return null;
  const row=await db.prepare('SELECT COUNT(*) AS n FROM "'+table+'"'+(condition?' WHERE '+condition:'')).first<{n:number}>();
  return Number(row?.n??0);
}
async function adminSum(db:Env['DB'],table:string,column:string):Promise<number|null>{
  const cols=await adminTableColumns(db,table);
  if(!cols.includes(column))return null;
  const row=await db.prepare('SELECT SUM("'+column+'") AS n FROM "'+table+'"').first<{n:number|null}>();
  return Number(row?.n??0);
}
// Read-only music analytics; do not manufacture BPM or genre measurements.
router.get('/music/analytics',async c=>{
  try{
    const db=c.env.DB;
    const cols=await adminTableColumns(db,'tl_shares');
    if(!cols.includes('title'))return c.json({ok:true,available:false,totals:{total:null,pulse:null,avg_bpm:null},genres:[],bpm_dist:[],top_tracks:[]});
    const total=await adminCount(db,'tl_shares');
    const pulse=cols.includes('pulse')?await adminSum(db,'tl_shares','pulse'):null;
    const bpm=cols.includes('bpm')?await db.prepare('SELECT AVG(bpm) AS n FROM tl_shares WHERE bpm>0').first<{n:number|null}>():null;
    const genres=cols.includes('category')?(await db.prepare('SELECT category,COUNT(*) AS cnt FROM tl_shares GROUP BY category ORDER BY cnt DESC LIMIT 20').all()).results||[]:[];
    const bpmDist=cols.includes('bpm')?(await db.prepare(`SELECT CASE WHEN bpm IS NULL OR bpm<=0 THEN '미측정' WHEN bpm<90 THEN '느림' WHEN bpm<120 THEN '보통' WHEN bpm<150 THEN '신남' ELSE '빠름' END AS range,COUNT(*) AS cnt FROM tl_shares GROUP BY 1 ORDER BY 1`).all()).results||[]:[];
    const wanted=['title','artist','category','bpm','pulse','file_tl'];
    const projection=wanted.map(k=>cols.includes(k)?'"'+k+'"':'NULL AS "'+k+'"').join(',');
    const sort=cols.includes('pulse')?'pulse DESC':'rowid DESC';
    const tracks=(await db.prepare('SELECT '+projection+' FROM tl_shares ORDER BY '+sort+' LIMIT 20').all()).results||[];
    return c.json({ok:true,available:true,totals:{total,pulse,avg_bpm:bpm?.n??null},genres,bpm_dist:bpmDist,top_tracks:tracks});
  }catch(error){console.error('[ADMIN_MUSIC_ANALYTICS]',error);return c.json({ok:false,error:'MUSIC_ANALYTICS_UNAVAILABLE'},503);}
});
router.get('/realtime',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const db=c.env.DB;
    const [userCount,shareCount,pulse,fileTl,cafes]=await Promise.all([
      adminCount(db,'users'),adminCount(db,'tl_shares'),adminSum(db,'tl_shares','pulse'),
      adminSum(db,'tl_shares','file_tl'),adminCount(db,'cafe_channels')
    ]);
    const sharesCols=await adminTableColumns(db,'tl_shares');
    let topTracks:any[]=[];
    if(['title','pulse'].every(x=>sharesCols.includes(x))){
      const artist=sharesCols.includes('artist')?'artist':'NULL AS artist';
      const rows=await db.prepare('SELECT title,'+artist+',pulse FROM tl_shares ORDER BY pulse DESC LIMIT 10').all();
      topTracks=rows.results||[];
    }
    return c.json({ok:true,as_of:new Date().toISOString(),
      users:{total:userCount,total_tl:null},
      shares:{total:shareCount,total_pulse:pulse,total_file_tl:fileTl},
      today:{payments:null,revenue_krw:null},cafe_channels:cafes,top_tracks:topTracks,
      unavailable:['users.total_tl','today.payments','today.revenue_krw']
    });
  }catch(e:any){return c.json({ok:false,error:'실시간 데이터 조회 실패',detail:String(e?.message||'')},503);}
});
// Korean accounting sidecar: administrator only; no wallet debit, bank transfer or tax filing.
router.get('/finance/kr',async c=>{
 try{
  const month=String(c.req.query('month')||new Date(Date.now()+9*3600000).toISOString().slice(0,7));
  const [report,creator]=await Promise.all([readKrFinance(c.env.DB,month),readCreatorPayoutReport(c.env.DB)]);
  return c.json({...report,creator_economy:{lifetime_earned_tl:creator.summary.earned_tl,valuation_status:'회계 의무 평가·기표 전 금액을 원화 확정 부채로 자동 전환하지 않습니다.'}});
 }catch(e:any){return c.json({ok:false,error:e.message||'회계 조회 실패'},503);}
});
router.get('/finance/kr/journals/:id',async c=>{
 const journal=await c.env.DB.prepare("SELECT * FROM v5_kr_journals WHERE id=? AND status='posted'").bind(c.req.param('id')).first();
 if(!journal)return c.json({ok:false,error:'전표 없음'},404);
 const lines=await c.env.DB.prepare('SELECT l.account,a.name,l.amount_krw FROM v5_kr_lines l JOIN v5_kr_accounts a ON a.code=l.account WHERE l.journal_id=? ORDER BY l.id').bind(c.req.param('id')).all();
 return c.json({ok:true,journal,lines:lines.results||[]});
});
router.post('/finance/kr/:action',async c=>{
 const actor=await requireAdmin(c);if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 try{
  const body=await c.req.json<any>();const action=c.req.param('action');
  let data:unknown;
  if(action==='policy')data=await saveKrPolicy(c.env.DB,body,actor);
  else if(action==='tax-profile')data=await saveKrProfile(c.env.DB,body,actor);
  else if(action==='journal')data=await postKrJournal(c.env.DB,body,actor);
  else if(action==='close-period')data=await closeKrPeriod(c.env.DB,body,actor);
  else if(action==='tax-preview'){
   if(body.kind==='vat')data=krVat(body.gross_krw,body.vat_type);
   else if(body.kind==='corporate')data=krCorporate(body);
   else if(body.kind==='withholding'){
    const profile=await c.env.DB.prepare('SELECT * FROM v5_kr_tax_profiles WHERE user_id=?').bind(Number(body.user_id)).first();
    data=krWithholding(body,profile||{});
   }else return c.json({ok:false,error:'세금 유형 확인 필요'},400);
  }else return c.json({ok:false,error:'지원하지 않는 작업'},404);
  return c.json({ok:true,data});
 }catch(e:any){return c.json({ok:false,error:e.message||'회계 처리 실패'},400);}
});

router.get('/revenue',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{return c.json(await readAdminFinance(c.env.DB));}
  catch(error:any){console.error('[ADMIN_FINANCE]',error);return c.json({ok:false,code:'FINANCE_UNAVAILABLE',error:'결제 영수증 집계 실패',detail:String(error?.message||'')},503);}
});
router.get('/creators/payouts',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{return c.json(await readCreatorPayoutReport(c.env.DB));}
  catch(error:any){console.error('[CREATOR_PAYOUT_REPORT]',error);return c.json({ok:false,code:'CREATOR_REPORT_UNAVAILABLE',error:'V5 창작 수익 원장을 조회하지 못했습니다.',detail:String(error?.message||'')},503);}
});


/**
 * Read-only finance source inventory. Never exposes customer rows or payment secrets.
 * Explicitly does not compute financial totals until source semantics are verified.
 */
router.get('/finance/source-audit',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const db=c.env.DB;
    const candidates=[
      'v3_economy_assets','v3_economy_accounts','v3_economy_balances',
      'v3_economy_transactions','v3_economy_entries',
      'v3_economy_legacy_imports','v3_tlc_mining_records',
      'payments','payment_orders','payment_transactions',
      'tl_payments','tl_charge_orders','creator_payouts','payout_requests',
      'tl_shares','users'
    ];
    const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+
      candidates.map(() => '?').join(',')+")").bind(...candidates).all<{name:string}>();
    const present=new Set((rows.results||[]).map(r=>r.name));
    const sources=await Promise.all(candidates.map(async name=>{
      if(!present.has(name))return {name,exists:false,columns:[] as string[]};
      const columns=await adminTableColumns(db,name);
      return {name,exists:true,columns};
    }));
    const assetRows=present.has('v3_economy_assets')
      ? await db.prepare('SELECT asset_code,decimals FROM v3_economy_assets').all<{asset_code:string,decimals:number}>()
      : null;
    return c.json({ok:true,as_of:new Date().toISOString(),read_only:true,
      verified_financial_totals:false,receipt_report_available:true,
      sources,assets:assetRows?.results||[],
      next_step:'재무 현황에서 PG 영수증 매출 확인 가능. 환불·PG 입금액은 별도 대사 필요'});
  }catch(e:any){return c.json({ok:false,error:'재무 원천 테이블 검사 실패',detail:String(e?.message||'')},503);}
});


/* Administrator-only, read-only ledger integrity checks; no financial totals inferred. */
router.get('/finance/ledger-integrity',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  try{
    const db=c.env.DB;
    const required=['v3_economy_assets','v3_economy_accounts','v3_economy_balances','v3_economy_transactions','v3_economy_entries'];
    const missing:string[]=[];
    for(const table of required){if(!(await adminTableColumns(db,table)).length)missing.push(table);}
    if(missing.length)return c.json({ok:false,code:'LEDGER_SCHEMA_INCOMPLETE',missing,error:'V5 경제원장 테이블이 누락되었습니다.'},503);
    const [types,imbalanced,orphans,assets]=await Promise.all([
      db.prepare("SELECT transaction_type,COUNT(*) AS count FROM v3_economy_transactions GROUP BY transaction_type ORDER BY count DESC LIMIT 100").all(),
      db.prepare("SELECT COUNT(*) AS count FROM (SELECT e.transaction_id,e.asset_code,SUM(e.amount_atoms) AS balance FROM v3_economy_entries e GROUP BY e.transaction_id,e.asset_code HAVING balance <> 0)").first<{count:number}>(),
      db.prepare("SELECT COUNT(*) AS count FROM v3_economy_entries e LEFT JOIN v3_economy_transactions t ON t.id=e.transaction_id WHERE t.id IS NULL").first<{count:number}>(),
      db.prepare("SELECT asset_code,decimals FROM v3_economy_assets ORDER BY asset_code").all()
    ]);
    const tl=(assets.results||[]).find((a:any)=>a.asset_code==='TL') as any;
    return c.json({ok:true,as_of:new Date().toISOString(),read_only:true,
      ledger_integrity:{imbalanced_transaction_assets:Number(imbalanced?.count||0),
        orphan_entries:Number(orphans?.count||0),tl_precision_ready:Number(tl?.decimals)===4},
      transaction_types:types.results||[],assets:assets.results||[],
      financial_totals_verified:false,
      note:'거래 유형은 원장 기록의 분류이며 매출·정산 금액을 뜻하지 않습니다.'});
  }catch(e:any){return c.json({ok:false,error:'원장 무결성 조회 실패',detail:String(e?.message||'')},503);}
});


// Browser-safe admin timeline: JWT authorization, never expose broadcaster secret.
router.get('/central-broadcast/stations/:country/now', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!(country in TILO_ZONES))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const serviceId='central-tilo-'+adminId;
  try{
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?').bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:true,country,enabled:false,slot:null});
    const result=await c.env.DB.prepare(`
      SELECT v.file_id,v.duration_ms,f.title,f.artist
      FROM central_broadcast_service_file_grants sg
      JOIN tl3_v5_releases v ON v.file_id=sg.file_id
      JOIN tl_files f ON f.id=v.file_id
      WHERE sg.service_id=? AND sg.country=? AND sg.status='active'
      AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now'))
      AND v.status='sealed' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0
      AND LOWER(f.file_type)='audio/tl3'
      AND EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?
        AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
      AND EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved'))
      ORDER BY v.file_id ASC LIMIT 200
    `).bind(serviceId,country,country).all<{file_id:number;duration_ms:number;title:string;artist:string}>();
    const now=new Date();
    return c.json({ok:true,country,enabled:true,serverTime:now.toISOString(),
      timeZone:TILO_ZONES[country as TiloCountry],show:tiloLocalShow(country as TiloCountry,now),
      slot:currentTiloSlot(result.results||[],now.getTime(),Date.UTC(2026,0,1)),
      note:'Clock metadata only; not proof of actual playback.'});
  }catch(error){console.error('[TILO_ADMIN_NOW]',error);return c.json({ok:false,error:'TIMELINE_UNAVAILABLE'},503);}
});

export default router;
