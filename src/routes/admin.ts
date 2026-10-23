import { currentTiloSlot,tiloLocalShow,TILO_ZONES,type TiloCountry } from '../tilo-server-timeline';
import { ensureCentralBroadcastSchema } from '../central-broadcast-schema';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

// ── 관리자 확인 ──
async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<number | null> {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return null;
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return null;
  const userId = Number(payload.sub || 0);
  if (!userId) return null;
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id=?').bind(userId).first<any>();
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
      AND EXISTS(SELECT 1 FROM tl3_releases r WHERE r.file_id=v.file_id AND r.status='released' AND r.rights_confirmed=1)
      AND EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?
        AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
      LIMIT 1`).bind(fileId,country).first();
    if(!eligible)return c.json({ok:false,error:'BROADCAST_RIGHTS_NOT_CLEARED'},403);
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:false,error:'TILO_SERVICE_NOT_ACTIVE'},409);
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

/** Read-only candidate audit: reports why published SharePlace V5 files are excluded. */
router.get('/central-broadcast/stations/:country/audit', async c => {
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  try{
    await ensureCentralBroadcastSchema(c.env.DB);
    const rows=await c.env.DB.prepare(`SELECT f.id AS file_id,f.title,f.file_type,f.shared,
      v.status AS v5_status,v.duration_ms,
      CASE WHEN EXISTS(SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id
        AND r.status='released' AND r.rights_confirmed=1) THEN 1 ELSE 0 END AS release_rights,
      CASE WHEN EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=f.id AND rg.creator_id=f.user_id AND rg.country=?
          AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
        THEN 1 ELSE 0 END AS country_broadcast_rights
      FROM tl_files f LEFT JOIN tl3_v5_releases v ON v.file_id=f.id
      WHERE f.shared=1 ORDER BY f.id DESC LIMIT 100`).bind(country).all<any>();
    const tracks=(rows.results||[]).map(r=>{
      const reasons:string[]=[];
      if(!r.v5_status)reasons.push('NO_V5_RELEASE');
      else if(r.v5_status!=='sealed')reasons.push('V5_NOT_SEALED');
      if(!r.release_rights)reasons.push('SHAREPLACE_RELEASE_RIGHTS_MISSING');
      if(!r.country_broadcast_rights)reasons.push('COUNTRY_BROADCAST_RIGHTS_MISSING');
      if(String(r.file_type||'').toLowerCase()!=='audio/tl3')reasons.push('FILE_TYPE_NOT_TL3');
      return {file_id:r.file_id,title:r.title,reasons,eligible:reasons.length===0};
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
    const grants=await c.env.DB.prepare(`SELECT v.file_id FROM tl3_v5_releases v
      JOIN tl_files f ON f.id=v.file_id
      WHERE v.status='sealed' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0


      ORDER BY RANDOM() LIMIT 100`).all<{file_id:number}>();
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
    const transactionId=crypto.randomUUID();
    const atoms=1000000*10000;
    // One-time issuance is not a transfer: record a positive mint entry and provenance.
    // Atomic batch prevents an issuance transaction without its wallet credit.
    await db.batch([
      db.prepare("INSERT INTO v3_economy_accounts(id,owner_type,owner_id,asset_code,bucket) VALUES (?,'user',?,'TL','wallet_bonus')").bind(accountId,String(adminId)),
      db.prepare("INSERT INTO v3_economy_balances(account_id,available_atoms) VALUES (?,?)").bind(accountId,atoms),
      db.prepare("INSERT INTO v3_economy_transactions(id,idempotency_key,transaction_type,source,reference_type,reference_id,actor_user_id,description,metadata_json) VALUES (?,'initial_dev_tl_issuance_20261022','initial_issuance','admin','user',?,?,'관리자 개발용 최초 TL 1,000,000 지급',?)").bind(transactionId,String(adminId),String(adminId),JSON.stringify({amount_atoms:atoms,non_redeemable:true,development_only:true})),
      db.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES (?,?,'TL',?)").bind(transactionId,accountId,atoms)
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
  try{
    const scale=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>();
    if(Number(scale?.decimals)!==4)return c.json({ok:false,error:'V5 경제원장 TL 정밀도 마이그레이션 미완료'},409);
    const user=await db.prepare('SELECT id FROM users WHERE lower(email)=?').bind(email).first<any>();
    if(!user)return c.json({ok:false,error:'회원을 찾을 수 없습니다.'},404);
    const targetBucket=bucket==='tl_a'?'wallet_ad':'wallet_bonus';
    const prior=await db.prepare('SELECT id,metadata_json FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>();
    const fingerprint=JSON.stringify({user_id:Number(user.id),bucket,amount,reason,admin_id:adminId});
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
    // Single D1 batch: account creation (when needed), balance update and audit entry.
    const accountId=existing?.id||crypto.randomUUID(),txId=crypto.randomUUID();
    const stmts:any[]=[];
    if(!existing){
      stmts.push(db.prepare("INSERT INTO v3_economy_accounts(id,owner_type,owner_id,asset_code,bucket) VALUES (?,'user',?,'TL',?)").bind(accountId,String(user.id),targetBucket));
      stmts.push(db.prepare('INSERT INTO v3_economy_balances(account_id,available_atoms) VALUES (?,0)').bind(accountId));
    }
    stmts.push(db.prepare("INSERT INTO v3_economy_transactions(id,idempotency_key,transaction_type,source,reference_type,reference_id,actor_user_id,description,metadata_json) VALUES (?,?,'admin_adjustment','admin','user',?,?,?,?)").bind(txId,key,String(user.id),String(adminId),reason,JSON.stringify({adjustment_fingerprint:fingerprint,amount_atoms:atoms,bucket,non_redeemable:true})));
    stmts.push(db.prepare("INSERT INTO v3_economy_entries(transaction_id,account_id,asset_code,amount_atoms) VALUES (?,?,'TL',?)").bind(txId,accountId,atoms));
    stmts.push(db.prepare("UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1,updated_at=datetime('now') WHERE account_id=? AND available_atoms+?>=0").bind(atoms,accountId,atoms));
    const results=await db.batch(stmts);
    if(Number(results[results.length-1]?.meta?.changes||0)!==1)throw new Error('원장 잔액 변경 실패');
    return c.json({ok:true,transaction_id:txId,bucket,amount,non_redeemable:true});
  }catch(e:any){
    const existing=await db.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>().catch(()=>null);
    if(existing)return c.json({ok:true,replayed:true,transaction_id:existing.id});
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

  const isSelect = /^\s*(SELECT|WITH)\b/i.test(sql);

  try {
    if (isSelect) {
      const result = await c.env.DB.prepare(sql).all();
      return c.json({ ok: true, results: result.results || [], rows: result.results || [] });
    }
    const result = await c.env.DB.prepare(sql).run();
    return c.json({ ok: true, changes: Number(result.meta?.changes || 0), meta: result.meta || null });
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
router.get('/revenue',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  // A financial figure must never be derived from an unverified payment/ledger schema.
  return c.json({ok:false,code:'FINANCIAL_SOURCE_NOT_VERIFIED',
    error:'결제 및 TL 원장 기준을 검증하기 전에는 재무 수치를 제공할 수 없습니다.',
    as_of:new Date().toISOString()},503);
});
router.get('/creators/payouts',async c=>{
  if(!await requireAdmin(c))return c.json({ok:false,error:'관리자 권한 필요'},403);
  return c.json({ok:false,code:'PAYOUT_SOURCE_NOT_VERIFIED',
    error:'크리에이터 정산 원장과 지급 상태 검증 후 조회를 제공합니다.'},503);
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
      verified_financial_totals:false,
      sources,assets:assetRows?.results||[],
      next_step:'결제 상태·환불·정산 거래유형·TL 소수점 정밀도 검증 후 실제 집계 API 연결'});
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
      AND EXISTS(SELECT 1 FROM tl3_releases r
        WHERE r.file_id=v.file_id AND r.status='released' AND r.rights_confirmed=1)
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