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


router.post('/tl3/consume', async (c) => {
  const u = c.get('user');
  const body = await c.req.json<{ file_id?: number; session_id?: string; seconds?: number }>();
  const fileId = Number(body.file_id || 0);
  const seconds = Math.max(0, Math.min(10, Math.floor(Number(body.seconds || 0))));
  const sessionId = String(body.session_id || '').slice(0, 80);
  if (!fileId || !sessionId || seconds <= 0) return c.json({ ok:true, consumed:0, balance:u.tl_balance });

  const file = await c.env.DB.prepare(`SELECT f.*, r.price_tl, r.status AS tl3_status
    FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id
    WHERE f.id=? AND r.status='released'`).bind(fileId).first<any>();
  if (!file) return c.json({ ok:false, error:'TL3 release not found' },404);
  if (file.revenue_held) return c.json({ ok:false, error:'File under dispute' },400);

  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_play_sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, file_id INTEGER NOT NULL,
    consumed_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).run();

  const session = await c.env.DB.prepare('SELECT * FROM tl3_play_sessions WHERE id=? AND user_id=? AND file_id=?')
    .bind(sessionId,u.id,fileId).first<any>();
  if (!session) await c.env.DB.prepare(
    'INSERT INTO tl3_play_sessions (id,user_id,file_id,consumed_seconds) VALUES (?,?,?,0)'
  ).bind(sessionId,u.id,fileId).run();

  const debit = await c.env.DB.prepare(`UPDATE users
    SET tl_balance=tl_balance-?, total_tl_spent=total_tl_spent+?
    WHERE id=? AND tl_balance>=?`).bind(seconds,seconds,u.id,seconds).run();
  if (!debit.meta?.changes) return c.json({ok:false,error:'시간 포인트가 부족합니다.',required:seconds,balance:u.tl_balance},402);

  const creator = await c.env.DB.prepare('SELECT id,tl_balance FROM users WHERE id=?').bind(file.user_id).first<any>();
  const revenue = seconds * 0.7;
  if (creator) {
    const after = Number(creator.tl_balance || 0) + revenue;
    await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance+?, total_tl_earned=total_tl_earned+? WHERE id=?')
      .bind(revenue,revenue,creator.id).run();
    await c.env.DB.prepare(`INSERT INTO transactions
      (user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note)
      VALUES (?,?,'earn',?,?,?,?)`).bind(creator.id,fileId,revenue,after,u.id,'TL3 재생 시간 정산').run();
  }

  await c.env.DB.prepare(`UPDATE tl3_play_sessions SET consumed_seconds=consumed_seconds+?,updated_at=datetime('now') WHERE id=?`)
    .bind(seconds,sessionId).run();
  await c.env.DB.prepare(`INSERT INTO play_events
    (file_id,player_user_id,tl_deducted,revenue_credited,file_tl_after,play_duration_seconds,car_mode)
    VALUES (?,?,?,?,?,?,0)`).bind(fileId,u.id,seconds,revenue,null,seconds).run();

  const fresh = await c.env.DB.prepare('SELECT tl_balance FROM users WHERE id=?').bind(u.id).first<any>();
  return c.json({ok:true,consumed:seconds,revenue_credited:revenue,balance:Number(fresh?.tl_balance||0)});
});

export default router;
