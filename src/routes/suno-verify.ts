/**
 * TimeLink — Suno 플랜 자동 인증 API
 * Claude Vision으로 스크린샷 분석 (ANTHROPIC_API_KEY 기존 사용 중)
 * 
 * index.ts에 추가:
 *   import sunoVerifyRouter from './routes/suno-verify';
 *   app.route('/api/v1/suno', sunoVerifyRouter);
 */

import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

// 토큰에서 userId 추출 (기존 index.ts 방식 동일)
function parseTokenUserId(token: string): number {
  if (!token) return 0;
  const m = token.match(/(?:token|fallback)_(\d+)/);
  if (m) return Number(m[1]);
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    return Number(p.userId || p.id || p.sub || 0);
  } catch { return 0; }
}

const ALLOWED_PLANS = ['pro plan', 'premier plan'];

// ──────────────────────────────────────────────────────────
// POST /api/v1/suno/verify-plan
// Claude Vision으로 Suno 플랜 스크린샷 자동 분석
// ──────────────────────────────────────────────────────────
router.post('/verify-plan', async (c) => {
  const token  = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ ok: false, reason: '로그인이 필요합니다.' }, 401);

  const form = await c.req.parseBody({ limit: 10 * 1024 * 1024 });
  const file = form['screenshot'] as File | null;

  if (!file) return c.json({ ok: false, reason: '이미지 파일이 없습니다.' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ ok: false, reason: '이미지 파일만 가능합니다.' }, 400);

  // base64 변환
  const buffer  = await file.arrayBuffer();
  const base64  = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mediaType = (file.type as 'image/png' | 'image/jpeg' | 'image/webp');

  const ANTHROPIC_KEY = (c.env as any).ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) {
    return c.json({ ok: false, reason: 'AI 분석 서비스가 설정되지 않았습니다.' }, 500);
  }

  try {
    // Claude Vision 호출
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `Suno AI 계정 화면 스크린샷입니다. JSON만 반환하세요 (다른 텍스트 금지):
{"plan":"Current Plan 값","endDate":"Plan End Date 값 또는 null","credits":"Credits Remaining 숫자 또는 null","isSunoPage":true/false}` }
          ]
        }]
      })
    });

 const data = await res.json() as any;
    const text = data?.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const planLower    = (parsed.plan || '').toLowerCase();
  const isAllowed = ALLOWED_PLANS.some(p => planLower.includes(p)) || planLower.includes('pro') || planLower.includes('premier');
    const isNotExpired = parsed.endDate ? new Date(parsed.endDate) > new Date() : false;

    if (!isAllowed) {
      return c.json({ ok: false, plan: parsed.plan, endDate: parsed.endDate, credits: parsed.credits,
        reason: `${parsed.plan || '알 수 없는'} 플랜은 업로드 권한이 없습니다. Pro 또는 Premier 플랜이 필요합니다.` });
    }
    if (parsed.endDate && !isNotExpired) {
      return c.json({ ok: false, plan: parsed.plan, endDate: parsed.endDate, credits: parsed.credits,
        reason: `플랜이 만료되었습니다 (${parsed.endDate}). Suno 플랜을 갱신해 주세요.` });
    }

    // 인증 성공 → D1 저장
    await c.env.DB.prepare(`
      INSERT INTO suno_verifications (user_id, plan, end_date, credits, verified_at, expires_at)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(user_id) DO UPDATE SET
        plan=excluded.plan, end_date=excluded.end_date, credits=excluded.credits,
        verified_at=excluded.verified_at, expires_at=excluded.expires_at
    `).bind(userId, parsed.plan, parsed.endDate, parsed.credits, parsed.endDate).run();

    // 배지 + TL 보상 (+100)
    await c.env.DB.prepare(`INSERT OR IGNORE INTO user_badges (user_id, badge, granted_at) VALUES (?, 'suno_verified', datetime('now'))`).bind(userId).run().catch(() => {});
    await c.env.DB.prepare(`UPDATE users SET tl=COALESCE(tl,0)+100, tl_p=COALESCE(tl_p,tl,0)+100 WHERE id=?`).bind(userId).run();

    return c.json({ ok: true, plan: parsed.plan, endDate: parsed.endDate, credits: parsed.credits });

  } catch (e: any) {
    return c.json({ ok: false, reason: 'AI 분석 오류: ' + e.message }, 500);
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/v1/suno/status
// 인증 상태 확인
// ──────────────────────────────────────────────────────────
router.get('/status', async (c) => {
  const token  = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ verified: false });

  try {
    const row = await c.env.DB.prepare(
      `SELECT plan, end_date, credits, verified_at, expires_at FROM suno_verifications WHERE user_id=?`
    ).bind(userId).first<{ plan:string; end_date:string; credits:string; verified_at:string; expires_at:string }>();

    if (!row) return c.json({ verified: false });
    const expired = row.expires_at && new Date(row.expires_at) <= new Date();
    return c.json({ verified: !expired, plan: row.plan, endDate: row.end_date, credits: row.credits });
  } catch {
    return c.json({ verified: false });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/v1/suno/register-track
// Spotify 연동 + tl3 원재료 등록
// ──────────────────────────────────────────────────────────
router.post('/register-track', async (c) => {
  const token  = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error: '로그인 필요' }, 401);

  try {
    const body = await c.req.json() as any;
    const tl3Id = 'tl3_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);

    // tl3_sources 테이블에 저장
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tl3_sources (
        id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, artist TEXT,
        prompt TEXT, style TEXT, lyrics TEXT, spotify_url TEXT, isrc TEXT,
        audio_features TEXT, anonymous INTEGER DEFAULT 0, tl_reward INTEGER DEFAULT 0,
        registered_at TEXT DEFAULT (datetime('now'))
      )
    `).run().catch(() => {});

    const reward = 200
      + (body.spotifyUrl ? 200 : 0)
      + ((body.lyrics?.length > 50) ? 50 : 0)
      + ((body.prompt?.length > 30) ? 50 : 0);

    await c.env.DB.prepare(`
      INSERT INTO tl3_sources (id, user_id, title, artist, prompt, style, lyrics, spotify_url, isrc, audio_features, anonymous, tl_reward)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tl3Id, userId, body.title, body.artist || '', body.prompt || '', body.style || '',
      body.lyrics || '', body.spotifyUrl || '', body.isrc || '',
      JSON.stringify(body.spotifyData || {}), body.anonymous ? 1 : 0, reward
    ).run();

    // TL 보상 지급
    await c.env.DB.prepare(`UPDATE users SET tl=COALESCE(tl,0)+?, tl_p=COALESCE(tl_p,tl,0)+? WHERE id=?`).bind(reward, reward, userId).run();

    // 창작자 배지
    await c.env.DB.prepare(`INSERT OR IGNORE INTO user_badges (user_id, badge, granted_at) VALUES (?, 'spotify_creator', datetime('now'))`).bind(userId).run().catch(() => {});

    return c.json({ ok: true, tl3Id, tlReward: reward });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default router;
