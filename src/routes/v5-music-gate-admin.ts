import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

router.get('/reviews', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer /i, '').trim();
  const payload = token ? await verifyToken(token, c.env.JWT_SECRET).catch(() => null) : null;
  const id = Number(payload?.sub || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const user = await c.env.DB.prepare('SELECT role,is_active FROM users WHERE id=?').bind(id).first<{role:string;is_active:number}>();
  if (user?.is_active !== 1 || String(user.role).toLowerCase() !== 'admin')
    return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const status = String(c.req.query('status') || 'review_required');
  if (!['pending_analysis','analyzing','review_required','approved','rejected','cancelled'].includes(status))
    return c.json({ok:false,error:'INVALID_STATUS'},400);
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id,user_id,source_sha256,registration_mode,status,reasons_json,classifier_version,created_at,updated_at,decided_at FROM v5_music_gate_reviews WHERE status=? ORDER BY created_at ASC LIMIT 100'
    ).bind(status).all();
    return c.json({ok:true,reviews:rows.results || []});
  } catch {
    return c.json({ok:false,error:'MUSIC_GATE_SCHEMA_NOT_READY'},503);
  }
});

export default router;
