import { Context, Next } from 'hono';
import { verifyToken } from './auth';
import type { Env, User } from './types';

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ detail: 'Not authenticated' }, 401);
  }
  const token = authHeader.slice(7);
  const payload = await verifyToken(token, c.env.JWT_SECRET);
  if (!payload) return c.json({ detail: 'Invalid or expired token' }, 401);

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(payload.sub).first<User>();
  if (!user || !user.is_active) return c.json({ detail: 'User not found' }, 401);
  if (user.account_forfeited) return c.json({ detail: 'Account forfeited' }, 403);

  c.set('user', user);
  await next();
}
