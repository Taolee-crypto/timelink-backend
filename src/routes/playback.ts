import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User, TLFile } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();

router.use('*', authMiddleware);

const REVENUE_SHARE = 0.7;
const CAR_MODE_MULTIPLIER = 2.0;

// POST /:id/play
router.post('/:id/play', async (c) => {
  const u = c.get('user');
  const body = await c.req.json<{ duration_seconds?: number; car_mode?: boolean }>();
  const duration = body.duration_seconds || 1;
  const carMode = body.car_mode || false;

  const file = await c.env.DB.prepare('SELECT * FROM tl_files WHERE id = ?')
    .bind(c.req.param('id')).first<TLFile>();
  if (!file) return c.json({ detail: 'File not found' }, 404);
  if (file.auth_status !== 'verified' || !file.shared) return c.json({ detail: 'File not available' }, 400);
  if (file.revenue_held) return c.json({ detail: 'File under dispute' }, 400);
  if (file.file_tl <= 0) return c.json({ detail: 'File has no TL balance' }, 400);

  const tlDeduct = Math.min(duration, file.file_tl);
  const multiplier = carMode ? CAR_MODE_MULTIPLIER : 1.0;
  const revenue = tlDeduct * REVENUE_SHARE * multiplier;
  const fileTLAfter = file.file_tl - tlDeduct;
  const newPulse = file.pulse + tlDeduct * multiplier;

  // Update file
  await c.env.DB.prepare(
    `UPDATE tl_files SET file_tl = ?, pulse = ?, play_count = play_count + 1 WHERE id = ?`
  ).bind(fileTLAfter, newPulse, file.id).run();

  // Credit creator
  const creator = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(file.user_id).first<User>();
  if (creator) {
    await c.env.DB.prepare(
      `UPDATE users SET tl_balance = tl_balance + ?, total_tl_earned = total_tl_earned + ? WHERE id = ?`
    ).bind(revenue, revenue, creator.id).run();
    await c.env.DB.prepare(
      `INSERT INTO transactions (user_id, file_id, tx_type, amount, balance_after, counterpart_user_id, note)
       VALUES (?, ?, 'earn', ?, ?, ?, '재생 수익')`
    ).bind(creator.id, file.id, revenue, creator.tl_balance + revenue, u.id).run();
  }

  // Log play event
  await c.env.DB.prepare(
    `INSERT INTO play_events (file_id, player_user_id, tl_deducted, revenue_credited, file_tl_after, play_duration_seconds, car_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(file.id, u.id, tlDeduct, revenue, fileTLAfter, duration, carMode ? 1 : 0).run();

  return c.json({ tl_deducted: tlDeduct, revenue_credited: revenue, file_tl_after: fileTLAfter });
});

// GET /:id/status
router.get('/:id/status', async (c) => {
  const file = await c.env.DB.prepare('SELECT id, file_tl, auth_status, shared, revenue_held FROM tl_files WHERE id = ?')
    .bind(c.req.param('id')).first();
  if (!file) return c.json({ detail: 'Not found' }, 404);
  return c.json(file);
});

export default router;
