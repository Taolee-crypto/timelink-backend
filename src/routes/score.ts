// src/routes/score.ts
// TimeLink 악보(Score) — TL3 공유 악보 시스템
//
// 개념:
//   - 창작자가 악보를 공유 (upload_score)
//   - 사용자가 악보를 사용 (score_use, 1,000 TL)
//   - 사용자가 악보를 봄 (score_view, POC 기여)
//
// 저장:
//   - tl3_releases.header_json.score (ScoreData)
//
// API:
//   POST /api/v1/tl3/score/:shareId/attach    — 악보 첨부 (창작자)
//   GET  /api/v1/tl3/score/:shareId            — 악보 조회 (공개)
//   POST /api/v1/scores/:shareId/use           — 악보 사용 (1,000 TL)
//   POST /api/v1/scores/:shareId/log-view      — 보기 로그 (POC)
//   GET  /api/v1/scores/:shareId/status        — 사용 여부 조회

import { Hono } from 'hono';
import type { Env } from '../types';
import {verifyToken} from '../auth';

const router = new Hono<{ Bindings: Env }>();

// ─────────────────────────────────────────
// 상수
// ─────────────────────────────────────────
const SCORE_PRICE_TL = 1000;

// ─────────────────────────────────────────
// 유틸: 인증
// ─────────────────────────────────────────
function parseUserId(token: string | null): string | null {
  if (!token) return null;
  const m = token.match(/^(?:token|fallback)_([^_]+)_/);
  if (m) return m[1];
  if (token.split('.').length === 3) {
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      return String(p.userId || p.id || p.sub || '');
    } catch { return null; }
  }
  return null;
}

function authId(c: any): string | null {
  return parseUserId((c.req.header('Authorization') || '').replace('Bearer ', '').trim());
}


/** Owner-only V5 transcriptions. These are *draft scores*, never TLD assets. */
async function v5ScoreUser(c:any):Promise<number>{
  const token=String(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token)return 0;
  const payload=await verifyToken(token,c.env.JWT_SECRET);
  const uid=Number(payload?.sub||0);
  if(!Number.isSafeInteger(uid)||uid<=0)return 0;
  const user=await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0").bind(uid).first();
  return user?uid:0;
}
async function ensureV5ScoreDrafts(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_track_score_drafts(
    file_id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,source_sha256 TEXT NOT NULL,
    score_json TEXT NOT NULL,algorithm TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}
async function lookupV5Score(db:D1Database,raw:string){
  const reference=String(raw||'').trim();
  if(!reference||reference.length>180||!/^[A-Za-z0-9_-]+$/.test(reference))return null;
  const id=/^[1-9][0-9]*$/.test(reference)&&Number.isSafeInteger(Number(reference))?Number(reference)
    :/^tl3_[1-9][0-9]*$/.test(reference)&&Number.isSafeInteger(Number(reference.slice(4)))?Number(reference.slice(4)):0;
  const select="SELECT v.file_id,v.user_id,v.share_id,v.duration_ms,v.source_sha256,f.title,f.artist FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id WHERE v.status='sealed' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0";
  let row=id>0
    ? await db.prepare(select+" AND v.file_id=?").bind(id).first<any>()
    : await db.prepare(select+" AND v.share_id=?").bind(reference).first<any>();
  if(!row && id>0)row=await db.prepare(select+" AND v.share_id=?").bind(reference).first<any>();
  if(!row){
    row=await db.prepare("SELECT v.file_id,v.user_id,v.share_id,v.duration_ms,v.source_sha256,f.title,f.artist FROM tl_shares s JOIN tl_files f ON f.stream_url=s.stream_url JOIN tl3_v5_releases v ON v.file_id=f.id AND v.status='sealed' WHERE CAST(s.id AS TEXT)=? AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 LIMIT 1")
      .bind(reference).first<any>().catch(()=>null);
  }
  return row;
}
// Idempotent, owner-authorized queue. No raw MP3, keys, TL debit or TLD issuance.
async function ensureV5ScoreJobs(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_score_jobs(
    file_id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,source_sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}
router.post('/scores/v5/:reference/generate',async c=>{
  const uid=await v5ScoreUser(c);
  if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
  try{
    const row=await lookupV5Score(c.env.DB,c.req.param('reference'));
    if(!row)return c.json({ok:false,code:'V5_TRACK_NOT_FOUND'},404);
    if(Number(row.user_id)!==uid)return c.json({ok:false,code:'CREATOR_REQUIRED'},403);
    const rights=await c.env.DB.prepare(
      "SELECT rights_role,rights_declared FROM tl_creator_metadata WHERE file_id=? AND user_id=?"
    ).bind(Number(row.file_id),uid).first<any>().catch(()=>null);
    if(Number(rights?.rights_declared)!==1||!['owner','authorized_agent','licensee'].includes(String(rights?.rights_role||'')))
      return c.json({ok:false,code:'CREATOR_RIGHTS_REQUIRED'},403);
    const body=await c.req.json<any>().catch(()=>null);
    if(body?.rights_confirmed!==true)return c.json({ok:false,code:'CREATOR_RIGHTS_REQUIRED'},422);
    // Do not accept jobs until a private analysis service is configured.
    // A queue without a worker would strand users in a permanent "pending" state.
    if(!(c.env as any).V5_SCORE_WORKER_URL||!(c.env as any).V5_SCORE_WORKER_TOKEN)
      return c.json({ok:false,code:'VOCAL_ANALYSIS_NOT_READY',message:'보컬 분석 서버가 아직 연결되지 않았습니다.'},503);
    await ensureV5ScoreJobs(c.env.DB);
    await c.env.DB.prepare(`INSERT INTO v5_score_jobs(file_id,owner_id,source_sha256,status)
      VALUES(?,?,?,'queued') ON CONFLICT(file_id) DO UPDATE SET
      owner_id=excluded.owner_id,source_sha256=excluded.source_sha256,
      status=CASE WHEN v5_score_jobs.source_sha256=excluded.source_sha256 AND
        v5_score_jobs.status IN ('queued','running','completed') THEN v5_score_jobs.status ELSE 'queued' END,
      error_code=NULL,updated_at=CURRENT_TIMESTAMP`)
      .bind(Number(row.file_id),uid,String(row.source_sha256)).run();
    return c.json({ok:true,job_status:'queued_or_existing',file_id:Number(row.file_id),
      tld_issued:false,tl_charged:0},202,{'Cache-Control':'private, no-store'});
  }catch(e){console.error('[V5_SCORE_JOB_INTAKE]',e);return c.json({ok:false,code:'V5_SCORE_JOB_INTAKE_FAILED'},503);}
});
// Existing TRACK ID always resolves to its actual sealed V5 file, not V3.
router.get('/scores/v5/:reference',async c=>{
  try{
    const row=await lookupV5Score(c.env.DB,c.req.param('reference'));
    if(!row)return c.json({ok:false,code:'V5_TRACK_NOT_FOUND',message:'이 곡의 TL3 V5 등록을 확인할 수 없습니다.'},404);
    const uid=await v5ScoreUser(c);
    const owner=uid>0&&uid===Number(row.user_id);
    const declaration=owner?await c.env.DB.prepare(
      "SELECT rights_role,rights_declared FROM tl_creator_metadata WHERE file_id=? AND user_id=?"
    ).bind(Number(row.file_id),uid).first<any>().catch(()=>null):null;
    const canGenerate=owner&&Number(declaration?.rights_declared)===1&&['owner','authorized_agent','licensee'].includes(String(declaration?.rights_role||''));
    let score=null;
    if(owner){
      await ensureV5ScoreDrafts(c.env.DB);
      const stored=await c.env.DB.prepare("SELECT source_sha256,score_json,status FROM v5_track_score_drafts WHERE file_id=? AND owner_id=?")
        .bind(Number(row.file_id),uid).first<any>();
      if(stored&&String(stored.source_sha256)===String(row.source_sha256)&&stored.status==='draft'){
        try{
          const value=JSON.parse(String(stored.score_json));
          if(value&&Array.isArray(value.melody)&&value.melody.length)score=value;
        }catch(_){score=null;}
      }
    }
    return c.json({ok:true,profile:'TL3-V5',file_id:Number(row.file_id),share_id:String(row.share_id),
      title:String(row.title||''),artist:String(row.artist||''),duration_ms:Number(row.duration_ms),
      score_status:score?'draft':'not_generated',has_score:!!score,score,
      can_generate:canGenerate&&!!(c.env as any).V5_SCORE_WORKER_URL&&!!(c.env as any).V5_SCORE_WORKER_TOKEN,source_sha256:owner?String(row.source_sha256):null,tld_issued:false,analysis_ready:!!(c.env as any).V5_SCORE_WORKER_URL&&!!(c.env as any).V5_SCORE_WORKER_TOKEN,tl_charged:0,
      analysis_code:"VOCAL_ANALYSIS_NOT_READY",
      analysis_message:"보컬 분리 채보 서비스 연결을 준비 중입니다. 현재 자동 채보를 시작할 수 없습니다.",
      message:score?'자동 채보 초안입니다. 검수 전이며 정식 TLD는 발행되지 않았습니다.':'이 곡의 V5 TLD 악보는 아직 생성·발행되지 않았습니다.'
    },200,{'Cache-Control':'private, no-store'});
  }catch(e){console.error('[V5_SCORE_STATUS]',e);return c.json({ok:false,code:'V5_SCORE_STATUS_UNAVAILABLE',message:'V5 악보 상태를 확인하지 못했습니다.'},503);}
});
// Store ONLY structured score notes (never MP3 bytes). Owner-authenticated and
// bound to the exact source SHA, without minting TLD or changing TL balances.
router.post('/scores/v5/:reference/draft',async c=>{
  const uid=await v5ScoreUser(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
  try{
    const row=await lookupV5Score(c.env.DB,c.req.param('reference'));
    if(!row)return c.json({ok:false,code:'V5_TRACK_NOT_FOUND'},404);
    if(Number(row.user_id)!==uid)return c.json({ok:false,code:'CREATOR_REQUIRED'},403);
    const rights=await c.env.DB.prepare("SELECT rights_role,rights_declared FROM tl_creator_metadata WHERE file_id=? AND user_id=?")
      .bind(Number(row.file_id),uid).first<any>();
    if(Number(rights?.rights_declared)!==1||!['owner','authorized_agent','licensee'].includes(String(rights?.rights_role||'')))
      return c.json({ok:false,code:'CREATOR_RIGHTS_REQUIRED'},403);
    // Accept independently verified vocal transcription drafts; this endpoint does
    // not perform transcription, grant rights, issue TLD or charge TL.
    const body=await c.req.json<any>().catch(()=>null);
    if(!body||body.rights_confirmed!==true||String(body.source_sha256||'').toLowerCase()!==String(row.source_sha256||'').toLowerCase())
      return c.json({ok:false,code:'SCORE_SOURCE_MISMATCH',message:'권리 확인 또는 V5 원본 지문이 일치하지 않습니다.'},422);
    const score=body.score_data;
    if(!score||!Array.isArray(score.melody)||score.melody.length<1||score.melody.length>20000)
      return c.json({ok:false,code:'SCORE_NOTES_INVALID'},422);
    if(!['vocal','lead_vocal'].includes(String(score.part||'')))
      return c.json({ok:false,code:'VOCAL_PART_REQUIRED',message:'보컬 전용으로 분리·검증된 악보만 저장할 수 있습니다.'},422);
    const duration=Number(row.duration_ms)/1000;
    let lastEnd=0;
    for(const note of score.melody){
      const start=Number(note?.s),length=Number(note?.d),midi=Number(note?.m);
      if(note?.s==null||String(note.s).trim()===''||note?.d==null||String(note.d).trim()===''||note?.m==null||String(note.m).trim()===''||
        !Number.isFinite(start)||!Number.isFinite(length)||!Number.isInteger(midi)||
        start<0||length<=0||length>60||midi<21||midi>108||
        start+length>duration+1||start<lastEnd-0.03||
        (note.lyric!==undefined&&(typeof note.lyric!=='string'||note.lyric.length>120)))
        return c.json({ok:false,code:'SCORE_NOTES_INVALID',message:'보컬 음표의 길이·순서·음높이 또는 가사 데이터가 올바르지 않습니다.'},422);
      lastEnd=start+length;
    }
    if(score.chords!==undefined&&(!Array.isArray(score.chords)||score.chords.length>5000))
      return c.json({ok:false,code:'SCORE_CHORDS_INVALID'},422);
    for(const chord of score.chords||[]){
      if(chord?.s==null||String(chord.s).trim()===''||!Number.isFinite(Number(chord.s))||Number(chord.s)<0||Number(chord.s)>duration+1||
        !/^[A-G][#b]?(?:[a-zA-Z0-9+#°øΔ()/-]{0,24})$/.test(String(chord.sym||chord.symbol||'')))
        return c.json({ok:false,code:'SCORE_CHORDS_INVALID'},422);
    }
    if(score.bpm!==undefined&&(!Number.isFinite(Number(score.bpm))||Number(score.bpm)<20||Number(score.bpm)>300))
      return c.json({ok:false,code:'SCORE_TEMPO_INVALID'},422);
    if(score.time_signature!==undefined&&!/^(?:[1-9]|1[0-2])\/(?:2|4|8|16)$/.test(String(score.time_signature)))
      return c.json({ok:false,code:'SCORE_METER_INVALID'},422);
    // An imported draft is not evidence that a separation model actually ran.
    // Preserve provenance so reviewers can distinguish manual from model output.
    const provenance=body.provenance;
    if(!provenance||!['manual','vocal_separation'].includes(String(provenance.method||''))||
      typeof provenance.engine!=='string'||!provenance.engine.trim()||provenance.engine.length>120)
      return c.json({ok:false,code:'SCORE_PROVENANCE_REQUIRED',message:'채보 출처와 분석 엔진을 명시해야 합니다.'},422);
    const normalizedScore={...score,provenance:{method:provenance.method,engine:provenance.engine.trim()}};
    const serialized=JSON.stringify(normalizedScore);
    if(serialized.length>900000)return c.json({ok:false,code:'SCORE_TOO_LARGE'},413);
    await ensureV5ScoreDrafts(c.env.DB);
    await c.env.DB.prepare(`INSERT INTO v5_track_score_drafts(file_id,owner_id,source_sha256,score_json,algorithm,status)
      VALUES(?,?,?,?,?,'draft') ON CONFLICT(file_id) DO UPDATE SET
      owner_id=excluded.owner_id,source_sha256=excluded.source_sha256,
      score_json=excluded.score_json,algorithm=excluded.algorithm,status='draft',updated_at=CURRENT_TIMESTAMP`)
      .bind(Number(row.file_id),uid,String(row.source_sha256),serialized,'verified-vocal-import-v1').run();
    return c.json({ok:true,score_status:'draft',notes:score.melody.length,tld_issued:false,tl_charged:0},201);

  }catch(e){console.error('[V5_SCORE_DRAFT]',e);return c.json({ok:false,code:'V5_SCORE_DRAFT_FAILED'},503);}
});

// ─────────────────────────────────────────
// DB 마이그레이션
// ─────────────────────────────────────────
async function migrateScoreDB(db: any) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS score_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      share_id TEXT NOT NULL,
      tl_paid INTEGER NOT NULL DEFAULT 1000,
      used_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, share_id)
    )
  `).run().catch(() => {});
}

// ═════════════════════════════════════════
// POST /api/v1/tl3/score/:shareId/attach
// 악보 첨부 (창작자만, tl3_releases.header_json.score에 삽입)
// ═════════════════════════════════════════
router.post('/tl3/score/:shareId/attach', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const shareId = c.req.param('shareId');
  const body = await c.req.json<any>().catch(() => ({}));

  if (!body || !body.score_data) {
    return c.json({ error: 'score_data 필요' }, 400);
  }

  try {
    await migrateScoreDB(c.env.DB);

    // 1. tl3_releases 조회
    const row = await c.env.DB.prepare(
      'SELECT header_json, user_id FROM tl3_releases WHERE share_id=?'
    ).bind(shareId).first<any>();

    if (!row) return c.json({ error: 'TL3 release not found' }, 404);

    // 2. 권한 확인
    if (String(row.user_id) !== String(userId)) {
      return c.json({ error: '본인 곡만 악보 첨부 가능' }, 403);
    }

    // 3. header_json에 score 추가
    let header: any = {};
    try { header = JSON.parse(row.header_json || '{}'); } catch (_) {}

    header.score = {
      version: 1,
      generated_at: new Date().toISOString(),
      algorithm: body.algorithm || 'timelink-score-v0.1',
      ...body.score_data,
    };

    // 4. 저장
    await c.env.DB.prepare(
      'UPDATE tl3_releases SET header_json=?, updated_at=datetime("now") WHERE share_id=?'
    ).bind(JSON.stringify(header), shareId).run();

    // 5. POC 기록 (악보 공유)
    await c.env.DB.prepare(
      'INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained) VALUES (?, ?, 0, 0, ?)'
    ).bind(userId, 'upload_score', 3).run().catch(() => {});

    return c.json({
      ok: true,
      share_id: shareId,
      score_version: 1,
      melody_count: (body.score_data.melody || []).length,
      chord_count: (body.score_data.chords || []).length,
    });
  } catch (e: any) {
    return c.json({ error: e.message || 'attach 실패' }, 500);
  }
});

// ═════════════════════════════════════════
// GET /api/v1/tl3/score/:shareId
// 악보 조회 (공개, ScoreData 반환)
// ═════════════════════════════════════════
router.get('/tl3/score/:shareId', async (c) => {
  const shareId = c.req.param('shareId');

  try {
    const row = await c.env.DB.prepare(
      'SELECT header_json, title, artist, duration_ms FROM tl3_releases WHERE share_id=?'
    ).bind(shareId).first<any>();

    if (!row) return c.json({ error: 'TL3 release not found' }, 404);

    let header: any = {};
    try { header = JSON.parse(row.header_json || '{}'); } catch (_) {}

    if (!header.score) {
      return c.json({
        error: 'NO_SCORE',
        message: '이 곡은 악보가 공유되지 않았습니다',
      }, 404);
    }

    return c.json({
      ok: true,
      share_id: shareId,
      title: row.title,
      artist: row.artist,
      duration_ms: row.duration_ms,
      score: header.score,
    });
  } catch (e: any) {
    return c.json({ error: e.message || 'score 조회 실패' }, 500);
  }
});

// ═════════════════════════════════════════
// GET /api/v1/scores/:shareId/status
// 악보 사용 여부 조회 (로그인 사용자)
// ═════════════════════════════════════════
router.get('/scores/:shareId/status', async (c) => {
  const userId = authId(c);
  const shareId = c.req.param('shareId');

  try {
    await migrateScoreDB(c.env.DB);

    // 악보 존재 여부
    const row = await c.env.DB.prepare(
      'SELECT header_json FROM tl3_releases WHERE share_id=?'
    ).bind(shareId).first<any>();

    let hasScore = false;
    if (row) {
      try {
        const h = JSON.parse(row.header_json || '{}');
        hasScore = !!h.score;
      } catch (_) {}
    }

    // 사용 여부
    let used = false;
    if (userId) {
      const u = await c.env.DB.prepare(
        'SELECT id FROM score_uses WHERE user_id=? AND share_id=?'
      ).bind(userId, shareId).first<any>();
      used = !!u;
    }

    return c.json({
      ok: true,
      share_id: shareId,
      has_score: hasScore,
      used_by_me: used,
      price_tl: SCORE_PRICE_TL,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ═════════════════════════════════════════
// POST /api/v1/scores/:shareId/use
// 악보 사용 (1,000 TL 차감, 창작자 기여, POC)
// ═════════════════════════════════════════
router.post('/scores/:shareId/use', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const shareId = c.req.param('shareId');

  try {
    await migrateScoreDB(c.env.DB);

    // 1. tl3_releases 조회
    const release = await c.env.DB.prepare(
      'SELECT user_id, header_json FROM tl3_releases WHERE share_id=?'
    ).bind(shareId).first<any>();

    if (!release) return c.json({ error: 'TL3 release not found' }, 404);

    let header: any = {};
    try { header = JSON.parse(release.header_json || '{}'); } catch (_) {}

    if (!header.score) {
      return c.json({ error: 'NO_SCORE', message: '이 곡은 악보가 없습니다' }, 404);
    }

    // 2. 이미 사용한 악보인지
    const existing = await c.env.DB.prepare(
      'SELECT id FROM score_uses WHERE user_id=? AND share_id=?'
    ).bind(userId, shareId).first<any>();

    if (existing) {
      return c.json({
        ok: true,
        already: true,
        share_id: shareId,
        message: '이미 사용한 악보입니다',
      });
    }

    // 3. 사용자 지갑 조회
    const user = await c.env.DB.prepare(
      'SELECT tl_p, tl_a, tl_b, tl, plan FROM users WHERE id=?'
    ).bind(userId).first<any>();

    if (!user) return c.json({ error: '유저 없음' }, 404);

    const tlP = Number(user.tl_p ?? user.tl ?? 0);
    const tlA = Number(user.tl_a ?? 0);
    const tlB = Number(user.tl_b ?? 0);

    // 4. TL 차감 (TL_A → TL_B → TL_P)
    let rem = SCORE_PRICE_TL;
    let useA = 0, useB = 0, useP = 0;

    if (tlA > 0) { useA = Math.min(tlA, rem); rem -= useA; }
    if (tlB > 0) { useB = Math.min(tlB, rem); rem -= useB; }
    if (tlP > 0) { useP = Math.min(tlP, rem); rem -= useP; }

    if (rem > 0) {
      return c.json({
        error: 'TL 부족',
        required: SCORE_PRICE_TL,
        balance: tlA + tlB + tlP,
        insufficient: true,
      }, 402);
    }

    // 5. 사용자 TL 차감
    await c.env.DB.prepare(`
      UPDATE users SET
        tl_p = MAX(0, tl_p - ?),
        tl_a = MAX(0, tl_a - ?),
        tl_b = MAX(0, tl_b - ?),
        tl   = MAX(0, tl   - ?),
        total_tl_spent = COALESCE(total_tl_spent, 0) + ?
      WHERE id=?
    `).bind(useP, useA, useB, useP, SCORE_PRICE_TL, userId).run();

    // 6. 창작자에게 기여 (TL_P 기반만, 플랜 A/B 비율)
    const creatorPlan = await c.env.DB.prepare(
      'SELECT plan FROM users WHERE id=?'
    ).bind(release.user_id).first<any>();
    const plan = creatorPlan?.plan || 'A';
    const rate = plan === 'B' ? 0.45 : 0.62;
    const creatorShareP = Math.floor(useP * rate);

    // TL_A도 50%/35% 비율로 창작자에게 (TL_A로 지급)
    const rateA = plan === 'B' ? 0.35 : 0.50;
    const creatorShareA = Math.floor(useA * rateA);

    if (creatorShareP > 0 || creatorShareA > 0) {
      await c.env.DB.prepare(`
        UPDATE users SET
          tl_p = tl_p + ?,
          tl_a = tl_a + ?,
          tl   = tl   + ?,
          total_tl_earned = COALESCE(total_tl_earned, 0) + ?
        WHERE id=?
      `).bind(
        creatorShareP, creatorShareA, creatorShareP, creatorShareP,
        release.user_id
      ).run();
    }

    // 7. 사용 기록
    await c.env.DB.prepare(
      'INSERT INTO score_uses (user_id, share_id, tl_paid) VALUES (?, ?, ?)'
    ).bind(userId, shareId, SCORE_PRICE_TL).run();

    // 8. POC 기록 (사용자)
    await c.env.DB.prepare(
      'INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained) VALUES (?, ?, 0, ?, ?)'
    ).bind(userId, 'score_use', useP, 0.05).run().catch(() => {});

    return c.json({
      ok: true,
      share_id: shareId,
      tl_paid: SCORE_PRICE_TL,
      breakdown: { tl_p: useP, tl_a: useA, tl_b: useB },
      creator_share: { tl_p: creatorShareP, tl_a: creatorShareA },
      wallet: {
        tl_p: tlP - useP,
        tl_a: tlA - useA,
        tl_b: tlB - useB,
      },
    });
  } catch (e: any) {
    return c.json({ error: e.message || 'use 실패' }, 500);
  }
});

// ═════════════════════════════════════════
// POST /api/v1/scores/:shareId/log-view
// 악보 보기 로그 (POC 기여, 로그인 사용자만)
// ═════════════════════════════════════════
router.post('/scores/:shareId/log-view', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ ok: false, error: '인증 필요' }, 401);

  const shareId = c.req.param('shareId');

  try {
    await migrateScoreDB(c.env.DB);

    // 존재 확인
    const row = await c.env.DB.prepare(
      'SELECT header_json FROM tl3_releases WHERE share_id=?'
    ).bind(shareId).first<any>();

    if (!row) return c.json({ ok: false, error: 'TL3 not found' }, 404);

    // POC 기록
    await c.env.DB.prepare(
      'INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained) VALUES (?, ?, 0, 0, ?)'
    ).bind(userId, 'score_view', 0.01).run().catch(() => {});

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═════════════════════════════════════════
// GET /api/v1/scores/:shareId/file.tld
// TLD 파일 다운로드 (임시: 준비 중)
// ═════════════════════════════════════════
// ═════════════════════════════════════════
// GET /api/v1/scores/:shareId/file.tld
// TLD 파일 다운로드 — TLD 서버(score.timelink.digital) 프록시
// ═════════════════════════════════════════
router.get('/scores/:shareId/file.tld', async (c) => {
  const shareId = c.req.param('shareId');
  const page = c.req.query('page') || '1';
  const token = c.req.query('token') || c.req.header('Authorization')?.replace('Bearer ', '');

  const userId = parseUserId(token || '') || c.req.query('user_id') || 'anonymous';

  const pageNum = parseInt(page, 10);
  if (isNaN(pageNum) || pageNum < 1) {
    return c.json({ ok: false, error: 'page는 1 이상의 정수' }, 400);
  }

  const tldServer = c.env.TLD_SERVER_URL || 'https://score.timelink.digital';
  const tldUrl = `${tldServer}/tld/${encodeURIComponent(shareId)}/page/${pageNum}?user_id=${encodeURIComponent(userId)}`;

  try {
    const res = await fetch(tldUrl, {
      headers: {
        'Accept': 'application/pdf',
        'X-TL-Proxy': 'workers',
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return c.json({
        ok: false,
        error: `TLD 서버 오류: HTTP ${res.status}`,
        detail: errText.slice(0, 500),
        share_id: shareId,
        page: pageNum,
      }, 502);
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${shareId}_p${pageNum}.pdf"`,
        'X-TL-Page': String(pageNum),
        'X-TL-Share-ID': shareId,
        'X-TL-User-ID': userId,
        'X-TL-Watermark': res.headers.get('X-TL-Watermark') || '',
        'X-TL-Print-ID': res.headers.get('X-TL-Print-ID') || '',
        'Cache-Control': 'private, no-store, must-revalidate',
      },
    });
  } catch (e: any) {
    return c.json({
      ok: false,
      error: 'TLD 서버 연결 실패',
      detail: e.message,
      share_id: shareId,
    }, 502);
  }
});

export default router;
