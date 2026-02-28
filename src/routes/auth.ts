import { Hono } from 'hono';
import { hashPassword, verifyPassword, makeAccessToken } from '../auth';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env }>();

const TL_INITIAL_BONUS = 1000;

// POST /register
router.post('/register', async (c) => {
  const body = await c.req.json<{ email: string; username: string; password: string }>();
  if (!body.email || !body.username || !body.password) {
    return c.json({ detail: 'email, username, password required' }, 422);
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ? OR username = ?'
  ).bind(body.email, body.username).first();
  if (existing) return c.json({ detail: 'Email or username already exists' }, 400);

  const hash = await hashPassword(body.password);
  const result = await c.env.DB.prepare(
    `INSERT INTO users (email, username, password_hash, tl_balance)
     VALUES (?, ?, ?, ?) RETURNING id`
  ).bind(body.email, body.username, hash, TL_INITIAL_BONUS).first<{ id: number }>();

  if (!result) return c.json({ detail: 'Registration failed' }, 500);

  // 가입 보너스 트랜잭션 기록
  await c.env.DB.prepare(
    `INSERT INTO transactions (user_id, tx_type, amount, balance_after, note)
     VALUES (?, 'initial', ?, ?, '가입 보너스')`
  ).bind(result.id, TL_INITIAL_BONUS, TL_INITIAL_BONUS).run();

  const token = await makeAccessToken(result.id, c.env.JWT_SECRET);
  return c.json({ access_token: token, token_type: 'bearer', user_id: result.id }, 201);
});

// POST /login
router.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(body.email).first<User>();
  if (!user) return c.json({ detail: 'Invalid credentials' }, 401);

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) return c.json({ detail: 'Invalid credentials' }, 401);

  const token = await makeAccessToken(user.id, c.env.JWT_SECRET);
  return c.json({ access_token: token, token_type: 'bearer', user_id: user.id });
});

export default router;
