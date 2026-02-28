import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();

router.use('*', authMiddleware);

// POST / - 이의제기 접수
router.post('/', async (c) => {
  const u = c.get('user');
  const body = await c.req.json<{ file_id: number; category: string; reason: string }>();
  if (!body.file_id || !body.category || !body.reason) {
    return c.json({ detail: 'file_id, category, reason required' }, 422);
  }

  // 파일 확인
  const file = await c.env.DB.prepare('SELECT * FROM tl_files WHERE id = ?')
    .bind(body.file_id).first<any>();
  if (!file) return c.json({ detail: 'File not found' }, 404);
  if (file.user_id === u.id) return c.json({ detail: 'Cannot dispute own file' }, 400);

  // 이의제기 생성
  const result = await c.env.DB.prepare(
    `INSERT INTO disputes (file_id, disputer_user_id, category, reason, status)
     VALUES (?, ?, ?, ?, 'pending') RETURNING id`
  ).bind(body.file_id, u.id, body.category, body.reason).first<{ id: number }>();

  // 파일 수익 동결 + 파일 소유자 TL 잠금
  await c.env.DB.prepare('UPDATE tl_files SET revenue_held = 1 WHERE id = ?').bind(body.file_id).run();
  await c.env.DB.prepare('UPDATE users SET tl_locked = tl_balance, tl_balance = 0 WHERE id = ?')
    .bind(file.user_id).run();

  return c.json({ id: result?.id, status: 'pending', message: '이의제기 접수됨. TL 및 수익 일시 동결.' }, 201);
});

// GET /my
router.get('/my', async (c) => {
  const u = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM disputes WHERE disputer_user_id = ? ORDER BY created_at DESC`
  ).bind(u.id).all();
  return c.json(rows.results);
});

// GET /:id
router.get('/:id', async (c) => {
  const d = await c.env.DB.prepare('SELECT * FROM disputes WHERE id = ?')
    .bind(c.req.param('id')).first();
  if (!d) return c.json({ detail: 'Not found' }, 404);
  return c.json(d);
});

// POST /:id/resolve (admin)
router.post('/:id/resolve', async (c) => {
  const body = await c.req.json<{ upheld: boolean; note?: string }>();
  const dispute = await c.env.DB.prepare('SELECT * FROM disputes WHERE id = ?')
    .bind(c.req.param('id')).first<any>();
  if (!dispute) return c.json({ detail: 'Not found' }, 404);

  const file = await c.env.DB.prepare('SELECT * FROM tl_files WHERE id = ?')
    .bind(dispute.file_id).first<any>();
  const creator = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(file?.user_id).first<User>();

  if (body.upheld) {
    // 이의제기 인정: 콘텐츠 제거, 분쟁자 TL 해제, 창작자 POC -1.0
    await c.env.DB.prepare(`UPDATE tl_files SET auth_status = 'rejected', shared = 0 WHERE id = ?`)
      .bind(dispute.file_id).run();
    await c.env.DB.prepare(`UPDATE disputes SET status = 'resolved_upheld', result_note = ? WHERE id = ?`)
      .bind(body.note || '', dispute.id).run();
    if (creator) {
      const newPoc = Math.max(-5, creator.poc_index - 1.0);
      await c.env.DB.prepare('UPDATE users SET poc_index = ?, tl_balance = tl_balance + tl_locked, tl_locked = 0 WHERE id = ?')
        .bind(newPoc, creator.id).run();
      await c.env.DB.prepare(`INSERT INTO poc_events (user_id, delta, poc_after, reason) VALUES (?, -1.0, ?, '이의제기 인정')`)
        .bind(creator.id, newPoc).run();
    }
  } else {
    // 이의제기 기각: 분쟁자 스트라이크 +1, POC -2.0, 창작자 TL 해제
    const disputer = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(dispute.disputer_user_id).first<User>();
    if (disputer) {
      const newStrikes = disputer.false_dispute_strikes + 1;
      const newPoc = Math.max(-5, disputer.poc_index - 2.0);
      if (newStrikes >= 3) {
        // 3아웃 - 계정 몰수
        await c.env.DB.prepare(
          `UPDATE users SET false_dispute_strikes = ?, poc_index = ?, account_forfeited = 1, tl_balance = 0, tl_locked = 0, tlc_balance = 0 WHERE id = ?`
        ).bind(newStrikes, newPoc, disputer.id).run();
      } else {
        await c.env.DB.prepare('UPDATE users SET false_dispute_strikes = ?, poc_index = ? WHERE id = ?')
          .bind(newStrikes, newPoc, disputer.id).run();
      }
      await c.env.DB.prepare(`INSERT INTO poc_events (user_id, delta, poc_after, reason) VALUES (?, -2.0, ?, '허위 이의제기')`)
        .bind(disputer.id, newPoc).run();
    }
    // 창작자 TL 해제
    if (creator) {
      await c.env.DB.prepare('UPDATE users SET tl_balance = tl_balance + tl_locked, tl_locked = 0 WHERE id = ?')
        .bind(creator.id).run();
    }
    await c.env.DB.prepare('UPDATE tl_files SET revenue_held = 0 WHERE id = ?').bind(dispute.file_id).run();
    await c.env.DB.prepare(`UPDATE disputes SET status = 'resolved_rejected', result_note = ? WHERE id = ?`)
      .bind(body.note || '', dispute.id).run();
  }

  return c.json({ status: body.upheld ? 'resolved_upheld' : 'resolved_rejected' });
});

export default router;
