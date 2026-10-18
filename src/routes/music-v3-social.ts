import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
const makeId = () => crypto.randomUUID();

router.use('*', async (c, next) => {
  const ready = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('v3_tracks','v3_track_releases','v3_track_assets','v3_shareplace_entries','v3_track_likes','v3_track_comments','v3_track_comment_reports','v3_track_follows')"
  ).first<any>();
  if (Number(ready?.n || 0) !== 8) {
    return c.json({ ok: false, code: 'V3_SOCIAL_NOT_INITIALIZED', error: 'V3 music social migration has not been applied' }, 503);
  }
  await next();
});

async function trackAccess(db: D1Database, trackId: string, userId = 0) {
  return db.prepare(`
    SELECT t.id,t.owner_user_id,t.status,t.visibility,
      CASE WHEN t.status='active' AND t.visibility='public' AND EXISTS (
        SELECT 1 FROM v3_shareplace_entries s
        JOIN v3_track_releases r ON r.track_id=s.track_id
          AND r.release_type='TL3' AND r.status='published'
        JOIN v3_track_assets a ON a.id=r.asset_id AND a.track_id=t.id
          AND a.asset_type='tl3_release_file' AND a.availability_status='available'
        WHERE s.track_id=t.id AND s.owner_user_id=t.owner_user_id AND s.visibility='public'
      ) THEN 1 ELSE 0 END AS is_public
    FROM v3_tracks t WHERE t.id=?
  `).bind(trackId).first<any>().then((track:any) => {
    if (!track) return null;
    if (Number(track.owner_user_id) === Number(userId) && userId > 0) return track;
    return Number(track.is_public) === 1 ? track : null;
  });
}

// Public counters; no source MP3 URL or storage URI is returned.
router.get('/tracks/:id/social', async (c) => {
  const track = await trackAccess(c.env.DB, c.req.param('id'));
  if (!track) return c.json({ ok: false, error: 'Public Track not found' }, 404);
  const [likes, comments] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_likes WHERE track_id=?').bind(track.id).first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM v3_track_comments WHERE track_id=? AND moderation_status='visible'").bind(track.id).first<any>()
  ]);
  return c.json({ ok: true, likes: Number(likes?.n || 0), comments: Number(comments?.n || 0) });
});

router.get('/tracks/:id/comments', async (c) => {
  const track = await trackAccess(c.env.DB, c.req.param('id'));
  if (!track) return c.json({ ok: false, error: 'Public Track not found' }, 404);
  const rows = await c.env.DB.prepare(`
    SELECT cm.id,cm.user_id,u.username,cm.content,cm.created_at
    FROM v3_track_comments cm JOIN users u ON u.id=cm.user_id
    WHERE cm.track_id=? AND cm.moderation_status='visible'
    ORDER BY cm.created_at DESC LIMIT 100
  `).bind(track.id).all<any>();
  return c.json({ ok: true, comments: rows.results || [] });
});

router.post('/tracks/:id/like', authMiddleware, async (c) => {
  const user = c.get('user'), track = await trackAccess(c.env.DB, c.req.param('id'), user.id);
  if (!track) return c.json({ ok: false, error: 'Track not found or not public' }, 404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO v3_track_likes(id,track_id,user_id) VALUES(?,?,?)')
    .bind(makeId(), track.id, user.id).run();
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_likes WHERE track_id=?').bind(track.id).first<any>();
  return c.json({ ok: true, liked: true, likes: Number(row?.n || 0) });
});

router.delete('/tracks/:id/like', authMiddleware, async (c) => {
  const user = c.get('user'), track = await trackAccess(c.env.DB, c.req.param('id'), user.id);
  if (!track) return c.json({ ok: false, error: 'Track not found or not public' }, 404);
  await c.env.DB.prepare('DELETE FROM v3_track_likes WHERE track_id=? AND user_id=?').bind(track.id, user.id).run();
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_likes WHERE track_id=?').bind(track.id).first<any>();
  return c.json({ ok: true, liked: false, likes: Number(row?.n || 0) });
});

router.post('/tracks/:id/comments', authMiddleware, async (c) => {
  const user = c.get('user'), track = await trackAccess(c.env.DB, c.req.param('id'), user.id);
  if (!track) return c.json({ ok: false, error: 'Track not found or not public' }, 404);
  let body:any; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const content = String(body.content || '').trim();
  if (content.length < 1 || content.length > 1000) return c.json({ ok: false, error: 'Comment must be 1..1000 characters' }, 422);
  const commentId = makeId();
  await c.env.DB.prepare('INSERT INTO v3_track_comments(id,track_id,user_id,content) VALUES(?,?,?,?)')
    .bind(commentId, track.id, user.id, content).run();
  const row = await c.env.DB.prepare(`
    SELECT cm.id,cm.user_id,u.username,cm.content,cm.created_at
    FROM v3_track_comments cm JOIN users u ON u.id=cm.user_id WHERE cm.id=?
  `).bind(commentId).first<any>();
  return c.json({ ok: true, comment: row }, 201);
});

router.post('/comments/:commentId/report', authMiddleware, async (c) => {
  const user = c.get('user');
  const comment = await c.env.DB.prepare('SELECT id,track_id FROM v3_track_comments WHERE id=? AND moderation_status=\'visible\'')
    .bind(c.req.param('commentId')).first<any>();
  if (!comment) return c.json({ ok: false, error: 'Visible comment not found' }, 404);
  const track = await trackAccess(c.env.DB, String(comment.track_id), user.id);
  if (!track) return c.json({ ok: false, error: 'Track not found or not public' }, 404);
  let body:any; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const reason = String(body.reason || '').trim();
  if (reason.length < 1 || reason.length > 1000) return c.json({ ok: false, error: 'Report reason must be 1..1000 characters' }, 422);
  const result = await c.env.DB.prepare('INSERT OR IGNORE INTO v3_track_comment_reports(id,comment_id,reporter_user_id,reason) VALUES(?,?,?,?)')
    .bind(makeId(), comment.id, user.id, reason).run();
  return c.json({ ok: true, reported: Number(result.meta?.changes || 0) > 0 });
});

router.post('/creators/:id/follow', authMiddleware, async (c) => {
  const user = c.get('user'), targetId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return c.json({ ok: false, error: 'Invalid creator ID' }, 422);
  if (targetId === user.id) return c.json({ ok: false, error: 'Cannot follow yourself' }, 422);
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(targetId).first<any>();
  if (!target) return c.json({ ok: false, error: 'Creator not found' }, 404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO v3_track_follows(id,follower_user_id,followed_user_id) VALUES(?,?,?)')
    .bind(makeId(), user.id, targetId).run();
  return c.json({ ok: true, following: true });
});

router.delete('/creators/:id/follow', authMiddleware, async (c) => {
  const user = c.get('user'), targetId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return c.json({ ok: false, error: 'Invalid creator ID' }, 422);
  await c.env.DB.prepare('DELETE FROM v3_track_follows WHERE follower_user_id=? AND followed_user_id=?').bind(user.id, targetId).run();
  return c.json({ ok: true, following: false });
});

router.get('/creators/:id/follow-status', authMiddleware, async (c) => {
  const user = c.get('user'), targetId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return c.json({ ok: false, error: 'Invalid creator ID' }, 422);
  const row = await c.env.DB.prepare('SELECT 1 AS following FROM v3_track_follows WHERE follower_user_id=? AND followed_user_id=?')
    .bind(user.id, targetId).first<any>();
  return c.json({ ok: true, following: !!row });
});

export default router;
