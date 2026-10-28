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

// V5 TRACK score state: read only the actual sealed V5 asset, never the V3
// tl3_releases header. A missing score is a normal state, not a 404/failed TL3.
// No legacy wallet charge, no audio decryption, no unapproved asset issuance.
router.get('/scores/v5/:reference', async (c) => {
  const reference=String(c.req.param('reference')||'');
  if (!reference || reference.length>180 || !/^[A-Za-z0-9_-]+$/.test(reference))
    return c.json({ok:false,code:'INVALID_SCORE_REFERENCE'},400);
  try {
    const db=c.env.DB;
    const id=/^[1-9][0-9]*$/.test(reference) && Number.isSafeInteger(Number(reference))
      ? Number(reference) : /^tl3_[1-9][0-9]*$/.test(reference) && Number.isSafeInteger(Number(reference.slice(4)))
        ? Number(reference.slice(4)) : 0;
    const select="SELECT v.file_id,v.share_id,v.duration_ms,f.title,f.artist FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id WHERE v.status='sealed' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0";
    // TRACK numeric references denote file_id (Creator emits tl3_<file_id>);
    // arbitrary shared IDs must match the real V5 share_id.
    let row=id>0
      ? await db.prepare(select+" AND v.file_id=?").bind(id).first<any>()
      : await db.prepare(select+" AND v.share_id=?").bind(reference).first<any>();
    if(!row && id>0)row=await db.prepare(select+" AND v.share_id=?").bind(reference).first<any>();
    if(!row){
      row=await db.prepare("SELECT v.file_id,v.share_id,v.duration_ms,f.title,f.artist FROM tl_shares s JOIN tl_files f ON f.stream_url=s.stream_url JOIN tl3_v5_releases v ON v.file_id=f.id AND v.status='sealed' WHERE CAST(s.id AS TEXT)=? AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 LIMIT 1")
        .bind(reference).first<any>().catch(()=>null);
    }
    if(!row)return c.json({ok:false,code:'V5_TRACK_NOT_FOUND',message:'이 곡의 TL3 V5 등록을 확인할 수 없습니다.'},404);
    return c.json({
      ok:true,profile:'TL3-V5',file_id:Number(row.file_id),share_id:String(row.share_id),
      title:String(row.title||''),artist:String(row.artist||''),
      score_status:'not_generated',has_score:false,score:null,
      tld_issued:false,analysis_ready:false,tl_charged:0,
      message:'이 곡의 V5 TLD 악보는 아직 생성·발행되지 않았습니다.'
    },200,{'Cache-Control':'no-store'});
  }catch(e:any){
    console.error('[V5_SCORE_STATUS]',e);
    return c.json({ok:false,code:'V5_SCORE_STATUS_UNAVAILABLE',message:'V5 악보 상태를 확인하지 못했습니다.'},503);
  }
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
