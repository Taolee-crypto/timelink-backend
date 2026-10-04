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
  const user = { id: result.id, email: body.email, username: body.username, tl: TL_INITIAL_BONUS };
  return c.json({ access_token: token, token: token, token_type: 'bearer', user_id: result.id, user }, 201);
});

// POST /login
router.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(body.email).first<User>();
  if (!user) return c.json({ detail: 'Invalid credentials' }, 401);

  const stored = String(user.password_hash || '');
  const isHashed = stored.includes(':');
  const valid = isHashed 
    ? await verifyPassword(body.password, stored)
    : (stored === body.password);
  if (!valid) return c.json({ detail: 'Invalid credentials' }, 401);

  const token = await makeAccessToken(user.id, c.env.JWT_SECRET);
  const safeUser = { id: user.id, email: user.email, username: user.username, tl: Number((user as any).tl_balance || 0) };
  return c.json({ access_token: token, token: token, token_type: 'bearer', user_id: user.id, user: safeUser });
});

// GET /me - 현재 로그인 토큰의 사용자 확인
router.get('/me', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token) return c.json({ok:false,error:'인증 필요'},401);
  const { verifyToken } = await import('../auth');
  const payload=await verifyToken(token,c.env.JWT_SECRET);
  const userId=Number(payload?.sub||0);
  if(!userId) return c.json({ok:false,error:'인증 사용자 확인 불가'},401);
  const user=await c.env.DB.prepare('SELECT id,email,username,COALESCE(tl_balance,0) as tl,COALESCE(tlc_balance,0) as tlc FROM users WHERE id=?').bind(userId).first<any>();
  if(!user) return c.json({ok:false,error:'유저 없음'},404);
  return c.json({ok:true,user});
});

// ── POST /change-password ── 비밀번호 변경
router.post('/change-password', async (c) => {
  try {
    const auth = (c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
    if (!auth) return c.json({ error: '인증 필요' }, 401);
    const payload = await verifyToken(auth, c.env.JWT_SECRET);
    const userId = Number((payload as any)?.sub || 0);
    if (!userId) return c.json({ error: '유효하지 않은 토큰' }, 401);

    const body = await c.req.json<any>().catch(() => ({}));
    const current = String(body.current_password || '').trim();
    const next = String(body.new_password || '').trim();

    if (!current || !next) return c.json({ error: '현재/새 비밀번호 필수' }, 400);
    if (next.length < 8) return c.json({ error: '새 비밀번호는 8자 이상' }, 400);
    if (current === next) return c.json({ error: '이전과 다른 비밀번호를 입력하세요' }, 400);

    const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE id=?').bind(userId).first<any>();
    if (!user) return c.json({ error: '유저 없음' }, 404);

    const stored = String(user.password_hash || '');
    const isHashed = stored.includes(':');
    let ok = false;
    if (isHashed) {
      ok = await verifyPassword(current, stored);
    } else {
      ok = (stored === current);
    }
    if (!ok) return c.json({ error: '현재 비밀번호가 틀렸습니다' }, 400);

    const newHash = await hashPassword(next);
    await c.env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(newHash, userId).run();

    return c.json({ ok: true, message: '비밀번호가 변경되었습니다' });
  } catch (e: any) {
    return c.json({ error: e?.message || '비밀번호 변경 실패' }, 500);
  }
});


export default router;
