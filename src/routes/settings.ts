import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const PUBLIC_KEYS = ['footer_settings', 'site_settings', 'notice_active'];

router.get('/:key', async (c) => {
  const key = c.req.param('key');
  if (!PUBLIC_KEYS.includes(key)) {
    return c.json({ ok: false, error: 'not allowed' }, 403);
  }
  try {
    const row = await c.env.DB.prepare('SELECT value FROM tl_settings WHERE key=?').bind(key).first<any>();
    return c.json({ ok: true, key, value: row?.value || null });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'db error' }, 500);
  }
});

export default router;
