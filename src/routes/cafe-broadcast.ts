import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

// ── POST /api/cafe-broadcast/play — 카페 방송 재생 로그 ──
router.post('/play', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => ({}));
    const channelId = String(body.cafe_channel_id || '').trim();
    const djId = Number(body.dj_id || 0);
    const trackId = String(body.track_id || '').trim();
    const duration = Math.max(0, Number(body.duration_seconds || 0));
    const source = String(body.source || 'cafe').slice(0, 20);

    if (!channelId || !trackId) return c.json({ ok: false, error: 'channel_id와 track_id 필요' }, 400);

    // 카페 확인
    const cafe = await c.env.DB.prepare(
      'SELECT channel_id, status, expires_at FROM cafe_channels WHERE channel_id=?'
    ).bind(channelId).first<any>();
    if (!cafe) return c.json({ ok: false, error: '카페 없음' }, 404);
    if (cafe.status !== 'active') return c.json({ ok: false, error: '비활성 카페' }, 403);
    if (cafe.expires_at && cafe.expires_at < Date.now()) return c.json({ ok: false, error: '구독 만료' }, 403);

    // tl_shares 에서 file_id 매핑 (있으면)
    const share = await c.env.DB.prepare('SELECT id FROM tl_shares WHERE id=?').bind(trackId).first<any>();

    const now = Date.now();
    const r = await c.env.DB.prepare(
      "INSERT INTO play_events (file_id, player_user_id, tl_deducted, revenue_credited, file_tl_after, play_duration_seconds, car_mode, dj_id, cafe_channel_id, track_id, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      share?.id || 0, null, 0, 0, 0, duration, 0, djId, channelId, trackId, source, new Date(now).toISOString()
    ).run();

    return c.json({ ok: true, event_id: r.meta?.last_row_id || 0 });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'play log 실패' }, 500);
  }
});

export default router;
