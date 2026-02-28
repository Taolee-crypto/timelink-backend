import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();

router.use('*', authMiddleware);

// GET /me
router.get('/me', (c) => {
  const u = c.get('user');
  return c.json({
    id: u.id, email: u.email, username: u.username,
    poc_index: u.poc_index, false_dispute_strikes: u.false_dispute_strikes,
    account_forfeited: !!u.account_forfeited, created_at: u.created_at,
  });
});

// GET /me/wallet
router.get('/me/wallet', (c) => {
  const u = c.get('user');
  const exchangeable_tl = u.total_tl_spent * 0.5;
  const tlc_mineable = u.poc_index > 0 ? u.total_tl_spent * 0.5 * u.poc_index : 0;
  return c.json({
    tl_balance: u.tl_balance,
    tl_locked: u.tl_locked,
    tlc_balance: u.tlc_balance,
    total_tl_spent: u.total_tl_spent,
    total_tl_earned: u.total_tl_earned,
    total_tl_exchanged: u.total_tl_exchanged,
    exchangeable_tl,
    tlc_mineable,
    poc_index: u.poc_index,
    tl_suspended: !!u.tl_suspended,
    false_dispute_strikes: u.false_dispute_strikes,
    account_forfeited: !!u.account_forfeited,
  });
});

// GET /me/transactions
router.get('/me/transactions', async (c) => {
  const u = c.get('user');
  const limit = Number(c.req.query('limit') || 20);
  const offset = Number(c.req.query('offset') || 0);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(u.id, limit, offset).all();
  return c.json(rows.results);
});

// GET /me/poc-history
router.get('/me/poc-history', async (c) => {
  const u = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM poc_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(u.id).all();
  return c.json(rows.results);
});

export default router;
