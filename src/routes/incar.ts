import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

async function authUser(c: Context<{ Bindings: Env }>): Promise<{ id: number; user: any } | null> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\\s+/i, '').trim();
  if (!token) return null;
  const payload = await verifyToken(token, c.env.JWT_SECRET).catch(() => null);
  const id = Number(payload?.sub || 0);
  if (!id) return null;
  const user = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance FROM users WHERE id=?').bind(id).first<any>();
  return user ? { id, user } : null;
}

async function ensureIncarTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS incar_channels (
    channel_id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    owner_name TEXT DEFAULT '',
    car_plate TEXT DEFAULT '',
    car_type TEXT DEFAULT '',
    drive_region TEXT DEFAULT '',
    description TEXT DEFAULT '',
    theme TEXT DEFAULT 'city',
    playlist TEXT DEFAULT '[]',
    schedules TEXT DEFAULT '[]',
    poc_index_at_creation REAL DEFAULT 1,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_incar_channels_owner ON incar_channels(owner_id)').run().catch(() => {});
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_incar_channels_status ON incar_channels(status, created_at)').run().catch(() => {});
}

router.get('/channels', async (c) => {
  try {
    await ensureIncarTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT channel_id, name, owner_name, car_type, drive_region, description, theme, playlist, schedules, created_at
       FROM incar_channels WHERE status='active' ORDER BY created_at DESC LIMIT 100`
    ).all();
    return c.json({ ok: true, channels: results || [] });
  } catch (error: any) {
    return c.json({ ok: false, error: error?.message || '인카 채널 목록을 불러오지 못했습니다.' }, 500);
  }
});

router.get('/my-channel', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401);
  try {
    await ensureIncarTables(c.env.DB);
    const channel = await c.env.DB.prepare(
      `SELECT channel_id, name, owner_name, car_plate, car_type, drive_region, description, theme, playlist, schedules, created_at
       FROM incar_channels WHERE owner_id=? AND status='active' ORDER BY created_at DESC LIMIT 1`
    ).bind(auth.id).first<any>();
    return c.json({ ok: true, registered: !!channel, channel: channel || null });
  } catch (error: any) {
    return c.json({ ok: false, error: error?.message || '내 인카 채널 조회 실패' }, 500);
  }
});

router.post('/channel', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));
  const channelId = String(body.channel_id || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const carPlate = String(body.car_plate || '').trim().toUpperCase();
  const carType = String(body.car_type || '').trim();
  const driveRegion = String(body.drive_region || '').trim();
  const description = String(body.description || '').trim();
  const theme = String(body.theme || 'city').trim();
  const playlist = JSON.stringify(Array.isArray(body.playlist) ? body.playlist : []);
  const schedules = JSON.stringify(Array.isArray(body.schedules) ? body.schedules : []);
  const pocIndex = Math.max(1, Math.min(10, Number(body.poc_index_at_creation) || 1));

  if (!/^[a-z0-9_]{3,20}$/.test(channelId)) return c.json({ ok: false, error: '채널 ID는 영문 소문자·숫자·언더스코어 3~20자여야 합니다.' }, 400);
  if (!name || !carPlate || !carType) return c.json({ ok: false, error: '채널명, 차량번호, 차종은 필수입니다.' }, 400);

  await ensureIncarTables(c.env.DB);
  const existing = await c.env.DB.prepare('SELECT channel_id FROM incar_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (existing) return c.json({ ok: false, error: '이미 사용 중인 채널 ID입니다.' }, 409);

  let fee = 20000;
  try {
    const row = await c.env.DB.prepare("SELECT value FROM tl_settings WHERE key='incar_channel_fee'").first<any>();
    if (row?.value != null) fee = Math.max(0, Number(row.value) || 20000);
  } catch (_) {}

  const balance = Number(auth.user.tl_balance ?? auth.user.tl ?? 0);
  if (balance < fee) return c.json({ ok: false, error: `TL 잔액이 부족합니다. (필요: ${fee.toLocaleString()} TL)` }, 402);

  const now = Date.now();
  const debit = await c.env.DB.prepare(
    'UPDATE users SET tl=MAX(0, COALESCE(tl,0)-?), tl_balance=MAX(0, COALESCE(tl_balance,tl,0)-?) WHERE id=? AND COALESCE(tl_balance,tl,0)>=?'
  ).bind(fee, fee, auth.id, fee).run();
  if (!Number(debit.meta?.changes || 0)) return c.json({ ok: false, error: 'TL 잔액이 부족합니다.' }, 402);

  try {
    await c.env.DB.prepare(
      `INSERT INTO incar_channels
       (channel_id, owner_id, name, owner_name, car_plate, car_type, drive_region, description, theme, playlist, schedules, poc_index_at_creation, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(channelId, auth.id, name, String(auth.user.username || auth.user.email || ''), carPlate, carType, driveRegion, description, theme, playlist, schedules, pocIndex, 'active', now, now).run();
  } catch (error: any) {
    await c.env.DB.prepare('UPDATE users SET tl=COALESCE(tl,0)+?, tl_balance=COALESCE(tl_balance,tl,0)+? WHERE id=?').bind(fee, fee, auth.id).run().catch(() => {});
    const message = String(error?.message || '');
    if (/unique|constraint/i.test(message)) return c.json({ ok: false, error: '이미 사용 중인 채널 ID입니다.' }, 409);
    return c.json({ ok: false, error: '인카 채널 저장에 실패했습니다. 차감된 TL은 복구 처리했습니다.' }, 500);
  }

  return c.json({ ok: true, channel_id: channelId, fee, tl_balance: balance - fee });
});

export default router;
