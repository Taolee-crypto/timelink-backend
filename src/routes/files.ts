import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User, TLFile } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();

router.use('*', authMiddleware);

// POST /upload
router.post('/upload', async (c) => {
  const u = c.get('user');
  const body = await c.req.json<{
    title: string; artist?: string; genre?: string; country?: string;
    file_type?: string; file_url?: string; file_tl?: number;
  }>();

  if (!body.title) return c.json({ detail: 'title required' }, 422);
  const fileTL = body.file_tl || 1000;

  if (u.tl_balance < fileTL) return c.json({ detail: 'Insufficient TL balance' }, 400);

  // Deduct from user, create file
  const result = await c.env.DB.prepare(
    `INSERT INTO tl_files (user_id, title, artist, genre, country, file_type, file_url, file_tl, max_file_tl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(u.id, body.title, body.artist||'', body.genre||'', body.country||'',
    body.file_type||'audio', body.file_url||'', fileTL, fileTL).first<{ id: number }>();

  if (!result) return c.json({ detail: 'Upload failed' }, 500);

  await c.env.DB.prepare(
    `UPDATE users SET tl_balance = tl_balance - ?, total_tl_spent = total_tl_spent + ? WHERE id = ?`
  ).bind(fileTL, fileTL, u.id).run();

  await c.env.DB.prepare(
    `INSERT INTO transactions (user_id, file_id, tx_type, amount, balance_after, note)
     VALUES (?, ?, 'charge', ?, ?, '파일 TL 충전')`
  ).bind(u.id, result.id, -fileTL, u.tl_balance - fileTL).run();

  return c.json({ id: result.id, message: 'File uploaded', file_tl: fileTL }, 201);
});

// GET /my
router.get('/my', async (c) => {
  const u = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM tl_files WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(u.id).all<TLFile>();
  return c.json(rows.results);
});

// GET /:id
router.get('/:id', async (c) => {
  const file = await c.env.DB.prepare('SELECT * FROM tl_files WHERE id = ?')
    .bind(c.req.param('id')).first<TLFile>();
  if (!file) return c.json({ detail: 'Not found' }, 404);
  return c.json(file);
});

// PATCH /:id/share
router.patch('/:id/share', async (c) => {
  const u = c.get('user');
  const file = await c.env.DB.prepare('SELECT * FROM tl_files WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), u.id).first<TLFile>();
  if (!file) return c.json({ detail: 'Not found' }, 404);
  if (file.auth_status !== 'verified') return c.json({ detail: 'File must be verified to share' }, 400);

  const body = await c.req.json<{ shared: boolean }>();
  await c.env.DB.prepare('UPDATE tl_files SET shared = ? WHERE id = ?')
    .bind(body.shared ? 1 : 0, file.id).run();
  return c.json({ shared: body.shared });
});

// POST /:id/approve (admin)
router.post('/:id/approve', async (c) => {
  const body = await c.req.json<{ approved: boolean; note?: string }>();
  const newStatus = body.approved ? 'verified' : 'rejected';

  const file = await c.env.DB.prepare('SELECT * FROM tl_files WHERE id = ?')
    .bind(c.req.param('id')).first<TLFile>();
  if (!file) return c.json({ detail: 'Not found' }, 404);

  await c.env.DB.prepare('UPDATE tl_files SET auth_status = ? WHERE id = ?')
    .bind(newStatus, file.id).run();

  if (body.approved) {
    // POC +0.3
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(file.user_id).first<User>();
    if (user) {
      const newPoc = Math.min(10, user.poc_index + 0.3);
      await c.env.DB.prepare('UPDATE users SET poc_index = ? WHERE id = ?').bind(newPoc, user.id).run();
      await c.env.DB.prepare(`INSERT INTO poc_events (user_id, delta, poc_after, reason) VALUES (?, 0.3, ?, '인증 승인')`)
        .bind(user.id, newPoc).run();
    }
  }

  return c.json({ auth_status: newStatus });
});

export default router;
