import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

// ── 인증 헬퍼 ──
async function authUser(c: any): Promise<{id: number, user: any} | null> {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return null;
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return null;
  const userId = Number(payload.sub || 0);
  if (!userId) return null;
  const user = await c.env.DB.prepare('SELECT id, email, username FROM users WHERE id=?').bind(userId).first<any>();
  if (!user) return null;
  return { id: userId, user };
}

// ── 테이블 보장 ──
async function ensureDJCafeTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    dj_name TEXT NOT NULL,
    bio TEXT DEFAULT '',
    genres TEXT DEFAULT '[]',
    mood TEXT DEFAULT '[]',
    avatar_url TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    instagram TEXT DEFAULT '',
    youtube TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    total_broadcasts INTEGER DEFAULT 0,
    total_listeners INTEGER DEFAULT 0,
    rating REAL DEFAULT 0,
    broadcast_set TEXT DEFAULT '[]',
    is_live INTEGER DEFAULT 0,
    live_started_at INTEGER,
    live_current_track_idx INTEGER DEFAULT 0,
    live_current_track_id TEXT DEFAULT '',
    live_current_started_at INTEGER,
    live_listener_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});

  // 마이그레이션 (기존 테이블)
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN is_live INTEGER DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN live_started_at INTEGER").run().catch(()=>{});
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN live_current_track_idx INTEGER DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN live_current_track_id TEXT DEFAULT ''").run().catch(()=>{});
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN live_current_started_at INTEGER").run().catch(()=>{});
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN live_listener_count INTEGER DEFAULT 0").run().catch(()=>{});

  // 기존 테이블에 broadcast_set 컬럼 추가 (마이그레이션)
  await db.prepare("ALTER TABLE dj_profiles ADD COLUMN broadcast_set TEXT DEFAULT '[]'").run().catch(()=>{});
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_cafe_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    schedule TEXT DEFAULT '[]',
    message TEXT DEFAULT '',
    cafe_message TEXT DEFAULT '',
    dj_rate REAL DEFAULT 0.3,
    cafe_rate REAL DEFAULT 0.5,
    revenue_share_dj REAL DEFAULT 0.5,
    revenue_share_cafe REAL DEFAULT 0.3,
    revenue_share_platform REAL DEFAULT 0.2,
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT,
    share_id TEXT,
    listeners INTEGER DEFAULT 0,
    seconds INTEGER DEFAULT 0,
    tl_charged REAL DEFAULT 0,
    revenue_dj REAL DEFAULT 0,
    revenue_cafe REAL DEFAULT 0,
    revenue_platform REAL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`).run().catch(()=>{});

  // ── DJ 보너스 로그 ──
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_bonus_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    session_id INTEGER,
    bonus_type TEXT NOT NULL,
    bonus_amount REAL NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`).run().catch(()=>{});

  // ── DJ 방송 세션 ──
  await db.prepare(`CREATE TABLE IF NOT EXISTS dj_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dj_id INTEGER NOT NULL,
    cafe_channel_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_heartbeat INTEGER,
    max_listeners INTEGER DEFAULT 0,
    avg_listeners INTEGER DEFAULT 0,
    total_seconds INTEGER DEFAULT 0,
    total_tl_charged REAL DEFAULT 0,
    bonus_claimed TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`).run().catch(()=>{});
}

// ── 기본 보너스 설정 ──
const DEFAULT_DJ_BONUSES = {
  first_broadcast: 500,
  hour_1: 300,
  hour_3: 1000,
  listener_10: 100,
  listener_50: 500,
  listener_100: 1500,
  daily_3: 500,
  weekly_10: 2000,
  monthly_30: 5000
};

async function getDJBonuses(db: any): Promise<any> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run().catch(()=>{});
    const row = await db.prepare("SELECT value FROM tl_settings WHERE key='dj_bonuses'").first<any>();
    if (row && row.value) {
      return { ...DEFAULT_DJ_BONUSES, ...JSON.parse(row.value) };
    }
  } catch(_) {}
  return DEFAULT_DJ_BONUSES;
}

// ── GET /api/dj/profile — 내 DJ 프로필 ──
router.get('/profile', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);
  const row = await c.env.DB.prepare('SELECT * FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  return c.json({ ok: true, profile: row || null });
});

// ── POST /api/dj/profile — DJ 프로필 생성/수정 ──
router.post('/profile', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const djName = String(body.dj_name || '').trim();
  if (!djName) return c.json({ ok: false, error: 'DJ 활동명은 필수입니다.' }, 400);
  const bio = String(body.bio || '');
  const genres = JSON.stringify(body.genres || []);
  const mood = JSON.stringify(body.mood || []);
  const avatarUrl = String(body.avatar_url || '');
  const coverUrl = String(body.cover_url || '');
  const instagram = String(body.instagram || '');
  const youtube = String(body.youtube || '');

  await ensureDJCafeTables(c.env.DB);
  const now = Date.now();
  const existing = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (existing) {
    await c.env.DB.prepare(
      'UPDATE dj_profiles SET dj_name=?, bio=?, genres=?, mood=?, avatar_url=?, cover_url=?, instagram=?, youtube=?, updated_at=? WHERE user_id=?'
    ).bind(djName, bio, genres, mood, avatarUrl, coverUrl, instagram, youtube, now, auth.id).run();
    return c.json({ ok: true, message: '프로필 수정 완료', dj_id: existing.id });
  } else {
    await c.env.DB.prepare(
      'INSERT INTO dj_profiles (user_id, dj_name, bio, genres, mood, avatar_url, cover_url, instagram, youtube, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(auth.id, djName, bio, genres, mood, avatarUrl, coverUrl, instagram, youtube, 'active', now, now).run();
    const row = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
    return c.json({ ok: true, message: 'DJ 등록 완료', dj_id: row.id });
  }
});

// ── GET /api/dj/list — DJ 목록 (카페가 조회) ──
router.get('/list', async (c) => {
  await ensureDJCafeTables(c.env.DB);
  const limit = Math.min(Number(c.req.query('limit') || 50), 100);
  const offset = Number(c.req.query('offset') || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.user_id, d.dj_name, d.bio, d.genres, d.mood, d.avatar_url,
            d.total_broadcasts, d.total_listeners, d.rating,
            u.username, u.email
     FROM dj_profiles d
     LEFT JOIN users u ON d.user_id = u.id
     WHERE d.status='active'
     ORDER BY d.rating DESC, d.total_listeners DESC
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  return c.json({ ok: true, djs: results || [] });
});

// ── GET /api/dj/:id — DJ 상세 ──
router.get('/:id{[0-9]+}', async (c) => {
  await ensureDJCafeTables(c.env.DB);
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'ID 필요' }, 400);
  const row = await c.env.DB.prepare(
    `SELECT d.*, u.username, u.email FROM dj_profiles d
     LEFT JOIN users u ON d.user_id = u.id
     WHERE d.id=?`
  ).bind(id).first<any>();
  if (!row) return c.json({ ok: false, error: 'DJ를 찾을 수 없습니다.' }, 404);
  return c.json({ ok: true, dj: row });
});

// ══════════════════════════════════════════
// C-2: DJ ↔ 카페 지원/매칭
// ══════════════════════════════════════════

// ── POST /api/dj-cafe/apply — DJ가 카페에 지원 ──
router.post('/apply', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const cafeChannelId = String(body.cafe_channel_id || '').trim();
  const message = String(body.message || '').trim();
  const schedule = JSON.stringify(body.schedule || []);
  const djRate = Number(body.dj_rate || 0.3);
  const cafeRate = Number(body.cafe_rate || 0.5);

  if (!cafeChannelId) return c.json({ ok: false, error: '카페 채널 ID 필요' }, 400);

  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: false, error: '먼저 DJ 프로필을 등록하세요.' }, 400);

  const cafe = await c.env.DB.prepare('SELECT channel_id, name FROM cafe_channels WHERE channel_id=? AND status=?').bind(cafeChannelId, 'active').first<any>();
  if (!cafe) return c.json({ ok: false, error: '카페 채널을 찾을 수 없습니다.' }, 404);

  const existing = await c.env.DB.prepare(
    'SELECT id, status FROM dj_cafe_links WHERE dj_id=? AND cafe_channel_id=? AND status IN (?, ?)'
  ).bind(dj.id, cafeChannelId, 'pending', 'active').first<any>();
  if (existing) return c.json({ ok: false, error: existing.status === 'active' ? '이미 활동 중인 카페입니다.' : '이미 지원한 카페입니다.' }, 409);

  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO dj_cafe_links (dj_id, cafe_channel_id, status, schedule, message, dj_rate, cafe_rate, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(dj.id, cafeChannelId, 'pending', schedule, message, djRate, cafeRate, now, now).run();

  return c.json({ ok: true, message: '지원 완료! 카페 주인의 수락을 기다려주세요.' });
});

// ── GET /api/dj-cafe/my-applications — 내(DJ)가 지원한 목록 ──
router.get('/my-applications', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: true, applications: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT l.*, cc.name AS cafe_name, cc.addr AS cafe_addr, cc.images AS cafe_images
     FROM dj_cafe_links l
     LEFT JOIN cafe_channels cc ON l.cafe_channel_id = cc.channel_id
     WHERE l.dj_id=?
     ORDER BY l.created_at DESC LIMIT 50`
  ).bind(dj.id).all();
  return c.json({ ok: true, applications: results || [] });
});

// ── GET /api/dj-cafe/my-contracts — 내(DJ) 방송 계약 (active) ──
router.get('/my-contracts', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: true, contracts: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT l.*, cc.name AS cafe_name, cc.addr AS cafe_addr
     FROM dj_cafe_links l
     LEFT JOIN cafe_channels cc ON l.cafe_channel_id = cc.channel_id
     WHERE l.dj_id=? AND l.status='active'
     ORDER BY l.started_at DESC LIMIT 50`
  ).bind(dj.id).all();
  return c.json({ ok: true, contracts: results || [] });
});

// ── GET /api/dj-cafe/cafe/:channelId/applications — 카페에 온 지원 목록 ──
router.get('/cafe/:channelId/applications', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const channelId = c.req.param('channelId');
  await ensureDJCafeTables(c.env.DB);
  const cafe = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (!cafe) return c.json({ ok: false, error: '카페를 찾을 수 없습니다.' }, 404);
  if (Number(cafe.owner_id) !== auth.id) return c.json({ ok: false, error: '권한이 없습니다.' }, 403);

  const { results } = await c.env.DB.prepare(
    `SELECT l.*, d.dj_name, d.bio, d.genres, d.mood, d.avatar_url,
            d.total_broadcasts, d.total_listeners, d.rating,
            u.username, u.email
     FROM dj_cafe_links l
     LEFT JOIN dj_profiles d ON l.dj_id = d.id
     LEFT JOIN users u ON d.user_id = u.id
     WHERE l.cafe_channel_id=?
     ORDER BY l.created_at DESC LIMIT 100`
  ).bind(channelId).all();
  return c.json({ ok: true, applications: results || [] });
});

// ── POST /api/dj-cafe/applications/:id/accept — 카페가 수락 ──
router.post('/applications/:id/accept', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<any>().catch(() => ({}));
  const cafeMessage = String(body.cafe_message || '').trim();
  const revShareDj = Number(body.revenue_share_dj ?? 0.5);
  const revShareCafe = Number(body.revenue_share_cafe ?? 0.3);
  const revSharePlatform = Number(body.revenue_share_platform ?? 0.2);

  await ensureDJCafeTables(c.env.DB);
  const link = await c.env.DB.prepare('SELECT * FROM dj_cafe_links WHERE id=?').bind(id).first<any>();
  if (!link) return c.json({ ok: false, error: '지원을 찾을 수 없습니다.' }, 404);
  if (link.status !== 'pending') return c.json({ ok: false, error: '이미 처리된 지원입니다.' }, 400);

  const cafe = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(link.cafe_channel_id).first<any>();
  if (!cafe || Number(cafe.owner_id) !== auth.id) return c.json({ ok: false, error: '권한이 없습니다.' }, 403);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_cafe_links SET status=?, cafe_message=?, revenue_share_dj=?, revenue_share_cafe=?, revenue_share_platform=?, started_at=?, updated_at=? WHERE id=?'
  ).bind('active', cafeMessage, revShareDj, revShareCafe, revSharePlatform, now, now, id).run();

  return c.json({ ok: true, message: 'DJ를 수락했습니다!' });
});

// ── POST /api/dj-cafe/applications/:id/reject — 카페가 거절 ──
router.post('/applications/:id/reject', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<any>().catch(() => ({}));
  const cafeMessage = String(body.cafe_message || '').trim();

  await ensureDJCafeTables(c.env.DB);
  const link = await c.env.DB.prepare('SELECT * FROM dj_cafe_links WHERE id=?').bind(id).first<any>();
  if (!link) return c.json({ ok: false, error: '지원을 찾을 수 없습니다.' }, 404);
  if (link.status !== 'pending') return c.json({ ok: false, error: '이미 처리된 지원입니다.' }, 400);

  const cafe = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(link.cafe_channel_id).first<any>();
  if (!cafe || Number(cafe.owner_id) !== auth.id) return c.json({ ok: false, error: '권한이 없습니다.' }, 403);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_cafe_links SET status=?, cafe_message=?, updated_at=? WHERE id=?'
  ).bind('rejected', cafeMessage, now, id).run();

  return c.json({ ok: true, message: '지원을 거절했습니다.' });
});

// ── POST /api/dj-cafe/contracts/:id/end — 계약 종료 (DJ or 카페) ──
router.post('/contracts/:id/end', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const id = Number(c.req.param('id'));
  await ensureDJCafeTables(c.env.DB);
  const link = await c.env.DB.prepare('SELECT * FROM dj_cafe_links WHERE id=?').bind(id).first<any>();
  if (!link) return c.json({ ok: false, error: '계약을 찾을 수 없습니다.' }, 404);

  const dj = await c.env.DB.prepare('SELECT user_id FROM dj_profiles WHERE id=?').bind(link.dj_id).first<any>();
  const cafe = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(link.cafe_channel_id).first<any>();
  const isDj = dj && Number(dj.user_id) === auth.id;
  const isCafe = cafe && Number(cafe.owner_id) === auth.id;
  if (!isDj && !isCafe) return c.json({ ok: false, error: '권한이 없습니다.' }, 403);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_cafe_links SET status=?, ended_at=?, updated_at=? WHERE id=?'
  ).bind('ended', now, now, id).run();

  return c.json({ ok: true, message: '계약을 종료했습니다.' });
});

// ══════════════════════════════════════════
// C-4: 방송 세션 + 보너스
// ══════════════════════════════════════════

// ── POST /api/dj-cafe/session/start — 방송 시작 ──
router.post('/session/start', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const cafeChannelId = String(body.cafe_channel_id || '').trim();

  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: false, error: 'DJ 프로필이 없습니다.' }, 400);

  // 이미 진행 중인 세션 종료
  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_sessions SET ended_at=?, last_heartbeat=? WHERE dj_id=? AND ended_at IS NULL'
  ).bind(now, now, dj.id).run().catch(()=>{});

  // 새 세션 시작
  const result = await c.env.DB.prepare(
    'INSERT INTO dj_sessions (dj_id, cafe_channel_id, started_at, last_heartbeat, created_at) VALUES (?,?,?,?,?)'
  ).bind(dj.id, cafeChannelId, now, now, now).run();

  const sessionId = result.meta?.last_row_id || 0;

  // ── 첫 방송 보너스 체크 ──
  const bonuses = await getDJBonuses(c.env.DB);
  const prevSessions = await c.env.DB.prepare(
    'SELECT COUNT(*) cnt FROM dj_sessions WHERE dj_id=? AND id != ?'
  ).bind(dj.id, sessionId).first<any>();

  let grantedBonus = null;
  if (Number(prevSessions?.cnt || 0) === 0 && bonuses.first_broadcast > 0) {
    grantedBonus = await grantBonus(c.env, dj.id, sessionId, 'first_broadcast', bonuses.first_broadcast, { reason: '첫 방송' });
  }

  return c.json({ ok: true, session_id: sessionId, granted_bonus: grantedBonus });
});

// ── POST /api/dj-cafe/session/heartbeat — 30초마다 ──
router.post('/session/heartbeat', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const sessionId = Number(body.session_id || 0);
  const listeners = Number(body.listeners || 0);
  const seconds = Number(body.seconds || 30);

  if (!sessionId) return c.json({ ok: false, error: 'session_id 필요' }, 400);

  await ensureDJCafeTables(c.env.DB);
  const session = await c.env.DB.prepare(
    'SELECT * FROM dj_sessions WHERE id=? AND ended_at IS NULL'
  ).bind(sessionId).first<any>();
  if (!session) return c.json({ ok: false, error: '활성 세션이 없습니다.' }, 404);

  const now = Date.now();
  const newTotalSeconds = Number(session.total_seconds || 0) + seconds;
  const newMaxListeners = Math.max(Number(session.max_listeners || 0), listeners);

  // 평균 청취자 (간단 버전: max의 70%)
  const avgListeners = Math.round((Number(session.avg_listeners || 0) + listeners) / 2);

  await c.env.DB.prepare(
    'UPDATE dj_sessions SET last_heartbeat=?, total_seconds=?, max_listeners=?, avg_listeners=? WHERE id=?'
  ).bind(now, newTotalSeconds, newMaxListeners, avgListeners, sessionId).run();

  // ── 보너스 조건 체크 ──
  const bonuses = await getDJBonuses(c.env.DB);
  let claimed = [];
  try { claimed = JSON.parse(session.bonus_claimed || '[]'); } catch(e) {}

  const grantedBonuses = [];

  // 1) 1시간 방송
  if (!claimed.includes('hour_1') && newTotalSeconds >= 3600 && bonuses.hour_1 > 0) {
    const b = await grantBonus(c.env, session.dj_id, sessionId, 'hour_1', bonuses.hour_1, { seconds: newTotalSeconds });
    if (b) { grantedBonuses.push(b); claimed.push('hour_1'); }
  }

  // 2) 3시간 방송
  if (!claimed.includes('hour_3') && newTotalSeconds >= 10800 && bonuses.hour_3 > 0) {
    const b = await grantBonus(c.env, session.dj_id, sessionId, 'hour_3', bonuses.hour_3, { seconds: newTotalSeconds });
    if (b) { grantedBonuses.push(b); claimed.push('hour_3'); }
  }

  // 3) 청취자 10명
  if (!claimed.includes('listener_10') && newMaxListeners >= 10 && bonuses.listener_10 > 0) {
    const b = await grantBonus(c.env, session.dj_id, sessionId, 'listener_10', bonuses.listener_10, { listeners: newMaxListeners });
    if (b) { grantedBonuses.push(b); claimed.push('listener_10'); }
  }

  // 4) 청취자 50명
  if (!claimed.includes('listener_50') && newMaxListeners >= 50 && bonuses.listener_50 > 0) {
    const b = await grantBonus(c.env, session.dj_id, sessionId, 'listener_50', bonuses.listener_50, { listeners: newMaxListeners });
    if (b) { grantedBonuses.push(b); claimed.push('listener_50'); }
  }

  // 5) 청취자 100명
  if (!claimed.includes('listener_100') && newMaxListeners >= 100 && bonuses.listener_100 > 0) {
    const b = await grantBonus(c.env, session.dj_id, sessionId, 'listener_100', bonuses.listener_100, { listeners: newMaxListeners });
    if (b) { grantedBonuses.push(b); claimed.push('listener_100'); }
  }

  // claimed 업데이트
  if (grantedBonuses.length > 0) {
    await c.env.DB.prepare('UPDATE dj_sessions SET bonus_claimed=? WHERE id=?')
      .bind(JSON.stringify(claimed), sessionId).run();
  }

  return c.json({ ok: true, granted_bonuses: grantedBonuses });
});

// ── POST /api/dj-cafe/session/end — 방송 종료 ──
router.post('/session/end', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const sessionId = Number(body.session_id || 0);

  await ensureDJCafeTables(c.env.DB);
  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_sessions SET ended_at=?, last_heartbeat=? WHERE id=?'
  ).bind(now, now, sessionId).run();

  return c.json({ ok: true });
});

// ── GET /api/dj-cafe/my-bonuses — 내 보너스 내역 ──
router.get('/my-bonuses', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: true, bonuses: [], total: 0 });

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM dj_bonus_logs WHERE dj_id=? ORDER BY created_at DESC LIMIT 100'
  ).bind(dj.id).all();

  const totalRow = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(bonus_amount),0) total FROM dj_bonus_logs WHERE dj_id=?'
  ).bind(dj.id).first<any>();

  return c.json({ ok: true, bonuses: results || [], total: Number(totalRow?.total || 0) });
});

// ── 보너스 지급 헬퍼 ──
async function grantBonus(env: any, djId: number, sessionId: number, bonusType: string, amount: number, metadata: any): Promise<any> {
  try {
    const now = Date.now();

    // 중복 체크 (같은 세션 + 같은 타입)
    const existing = await env.DB.prepare(
      'SELECT id FROM dj_bonus_logs WHERE dj_id=? AND session_id=? AND bonus_type=?'
    ).bind(djId, sessionId, bonusType).first<any>();
    if (existing) return null;

    // 보너스 로그 기록
    await env.DB.prepare(
      'INSERT INTO dj_bonus_logs (dj_id, session_id, bonus_type, bonus_amount, metadata, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(djId, sessionId, bonusType, amount, JSON.stringify(metadata || {}), now).run();

    // DJ 유저에게 TL_B 지급
    const dj = await env.DB.prepare('SELECT user_id FROM dj_profiles WHERE id=?').bind(djId).first<any>();
    if (dj && dj.user_id) {
      await env.DB.prepare(
        'UPDATE users SET tl_b = COALESCE(tl_b,0) + ?, tl = COALESCE(tl,0) + ? WHERE id=?'
      ).bind(amount, amount, dj.user_id).run();
    }

    return { type: bonusType, amount, metadata };
  } catch(e: any) {
    console.error('[grantBonus]', e?.message);
    return null;
  }
}

// ── GET /api/dj-cafe/bonus-config — 보너스 설정 조회 (공개) ──
router.get('/bonus-config', async (c) => {
  await ensureDJCafeTables(c.env.DB);
  const bonuses = await getDJBonuses(c.env.DB);
  return c.json({ ok: true, bonuses });
});

// ══════════════════════════════════════════
// C-5: DJ 내 파일 (TL3)
// ══════════════════════════════════════════

// ── GET /api/dj-cafe/my-files — 내가 업로드한 TL3 파일 ──
router.get('/my-files', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, title, artist, album, category,
              COALESCE(duration, 0) as duration,
              COALESCE(file_tl, 0) as file_tl,
              COALESCE(pulse, 0) as pulse,
              COALESCE(cover_url, '') as cover_url,
              COALESCE(content_kind, '') as content_kind,
              COALESCE(release_mode, '') as release_mode,
              COALESCE(stream_url, '') as stream_url,
              0 as play_count,
              0 as total_revenue,
              created_at
       FROM tl_shares
       WHERE user_id = ?
         AND (
           lower(COALESCE(content_kind,'')) IN ('tl3', 'mp3')
           OR lower(COALESCE(release_mode,'')) LIKE 'tl3%'
           OR lower(COALESCE(release_mode,'')) LIKE 'free_mp3%'
         )
       ORDER BY created_at DESC
       LIMIT 200`
    ).bind(auth.id).all();

    return c.json({ ok: true, files: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '파일 조회 실패' }, 500);
  }
});

// ══════════════════════════════════════════
// C-6: 방송 세트
// ══════════════════════════════════════════

// ── POST /api/dj-cafe/broadcast-set — 방송 세트 저장 ──
router.post('/broadcast-set', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const mood = JSON.stringify(body.mood || []);
  const tracks = JSON.stringify(body.tracks || []);

  // 빈 세트도 허용 (삭제 용도)
  if (!name && (!body.tracks || body.tracks.length === 0)) {
    await c.env.DB.prepare('UPDATE dj_profiles SET broadcast_set=?, updated_at=? WHERE user_id=?')
      .bind('null', Date.now(), auth.id).run();
    return c.json({ ok: true, message: '세트 삭제됨' });
  }
  if (!name) return c.json({ ok: false, error: '세트 이름 필수' }, 400);
  if (!Array.isArray(body.tracks) || body.tracks.length === 0) {
    return c.json({ ok: false, error: '곡을 최소 1개 이상 선택하세요' }, 400);
  }

  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: false, error: 'DJ 프로필 먼저 등록' }, 400);

  const setData = JSON.stringify({
    name, description,
    mood: JSON.parse(mood),
    tracks: JSON.parse(tracks),
    updated_at: Date.now()
  });

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_profiles SET broadcast_set=?, updated_at=? WHERE user_id=?'
  ).bind(setData, now, auth.id).run();

  return c.json({ ok: true, message: '방송 세트 저장 완료' });
});

// ── GET /api/dj-cafe/broadcast-set — 내 방송 세트 조회 ──
router.get('/broadcast-set', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);
  const row = await c.env.DB.prepare('SELECT broadcast_set FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!row) return c.json({ ok: true, set: null });
  let set = null;
  try { set = JSON.parse(row.broadcast_set || 'null'); } catch(e) {}
  
  // ⭐ tracks 문자열 배열 → track_details 객체 배열로 enrich
  if (set && Array.isArray(set.tracks) && set.tracks.length > 0) {
    try {
      const placeholders = set.tracks.map(() => '?').join(',');
      const { results } = await c.env.DB.prepare(
        'SELECT id, title, artist, duration, cover_url, stream_url, file_tl, content_kind FROM tl_shares WHERE id IN (' + placeholders + ')'
      ).bind(...set.tracks).all();
      const map = {};
      for (const t of (results || [])) map[t.id] = t;
      set.track_details = set.tracks.map(id => map[id] || { id: id, title: id, missing: true });
    } catch(e) {
      set.track_details = set.tracks.map(id => ({ id: id, title: id, error: true }));
    }
  }
  
  return c.json({ ok: true, set });
});

// ── GET /api/dj-cafe/public-set/:djId — 공개 방송 세트 (카페가 조회) ──
router.get('/public-set/:djId{[0-9]+}', async (c) => {
  const djId = Number(c.req.param('djId'));
  await ensureDJCafeTables(c.env.DB);
  const row = await c.env.DB.prepare('SELECT broadcast_set FROM dj_profiles WHERE id=?').bind(djId).first<any>();
  if (!row) return c.json({ ok: false, error: 'DJ 없음' }, 404);
  let set = null;
  try { set = JSON.parse(row.broadcast_set || 'null'); } catch(e) {}
  return c.json({ ok: true, set });
});

// ══════════════════════════════════════════
// C-7: 라이브 방송
// ══════════════════════════════════════════

// ── POST /api/dj-cafe/broadcast/start — 방송 시작 ──
router.post('/broadcast/start', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);

  const dj = await c.env.DB.prepare('SELECT id, broadcast_set FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj) return c.json({ ok: false, error: 'DJ 프로필 먼저 등록' }, 400);

  let set = null;
  try { set = JSON.parse(dj.broadcast_set || 'null'); } catch(e) {}
  if (!set || !set.tracks || set.tracks.length === 0) {
    return c.json({ ok: false, error: '방송 세트를 먼저 저장하세요' }, 400);
  }

  const now = Date.now();
  const firstTrack = set.tracks[0];

  await c.env.DB.prepare(
    'UPDATE dj_profiles SET is_live=1, live_started_at=?, live_current_track_idx=0, live_current_track_id=?, live_current_started_at=?, updated_at=? WHERE user_id=?'
  ).bind(now, firstTrack, now, now, auth.id).run();

  // 세션 생성
  const result = await c.env.DB.prepare(
    'INSERT INTO dj_sessions (dj_id, started_at, last_heartbeat, created_at) VALUES (?,?,?,?)'
  ).bind(dj.id, now, now, now).run();

  return c.json({ ok: true, session_id: result.meta?.last_row_id || 0, started_at: now });
});

// ── POST /api/dj-cafe/broadcast/next — 다음 곡 ──
router.post('/broadcast/next', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);

  const dj = await c.env.DB.prepare('SELECT id, is_live, live_current_track_idx, broadcast_set FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (!dj || !dj.is_live) return c.json({ ok: false, error: '방송 중이 아닙니다' }, 400);

  let set = null;
  try { set = JSON.parse(dj.broadcast_set || 'null'); } catch(e) {}
  if (!set || !set.tracks) return c.json({ ok: false, error: '세트 없음' }, 400);

  const nextIdx = (Number(dj.live_current_track_idx || 0) + 1) % set.tracks.length;
  const nextTrack = set.tracks[nextIdx];
  const now = Date.now();

  await c.env.DB.prepare(
    'UPDATE dj_profiles SET live_current_track_idx=?, live_current_track_id=?, live_current_started_at=?, updated_at=? WHERE user_id=?'
  ).bind(nextIdx, nextTrack, now, now, auth.id).run();

  return c.json({ ok: true, track_idx: nextIdx, track_id: nextTrack });
});

// ── POST /api/dj-cafe/broadcast/stop — 방송 종료 ──
router.post('/broadcast/stop', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE dj_profiles SET is_live=0, live_listener_count=0, updated_at=? WHERE user_id=?'
  ).bind(now, auth.id).run();

  // 활성 세션 종료
  const dj = await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE user_id=?').bind(auth.id).first<any>();
  if (dj) {
    await c.env.DB.prepare(
      'UPDATE dj_sessions SET ended_at=?, last_heartbeat=? WHERE dj_id=? AND ended_at IS NULL'
    ).bind(now, now, dj.id).run().catch(()=>{});
  }

  return c.json({ ok: true });
});

// ── GET /api/dj-cafe/broadcast/status — 내 방송 상태 ──
router.get('/broadcast/status', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare(
    'SELECT id, is_live, live_started_at, live_current_track_idx, live_current_track_id, live_listener_count FROM dj_profiles WHERE user_id=?'
  ).bind(auth.id).first<any>();
  return c.json({ ok: true, live: dj || null });
});

// ── GET /api/dj-cafe/live-djs — 라이브 중인 DJ 목록 (공개) ──
router.get('/live-djs', async (c) => {
  await ensureDJCafeTables(c.env.DB);
  const { results } = await c.env.DB.prepare(
    `SELECT id, dj_name, avatar_url, bio, genres, mood,
            total_listeners, rating, live_started_at,
            live_current_track_id, live_listener_count
     FROM dj_profiles
     WHERE is_live=1 AND status='active'
     ORDER BY live_listener_count DESC, total_listeners DESC
     LIMIT 100`
  ).all();

  // 현재 재생 중인 곡 정보 추가
  const djs = (results || []).map(function(d: any) {
    return {
      id: d.id,
      dj_name: d.dj_name,
      avatar_url: d.avatar_url,
      bio: d.bio,
      genres: d.genres,
      mood: d.mood,
      total_listeners: d.total_listeners,
      rating: d.rating,
      live_started_at: d.live_started_at,
      current_track_id: d.live_current_track_id,
      live_listener_count: d.live_listener_count
    };
  });

  return c.json({ ok: true, djs });
});

// ── GET /api/dj-cafe/live/:djId{[0-9]+} — 특정 DJ 라이브 상태 ──
router.get('/live/:djId{[0-9]+}', async (c) => {
  const djId = Number(c.req.param('djId'));
  await ensureDJCafeTables(c.env.DB);
  const dj = await c.env.DB.prepare(
    `SELECT id, dj_name, avatar_url, bio, genres, mood, is_live,
            live_current_track_id, live_current_track_idx, live_started_at,
            live_listener_count, total_listeners, rating, broadcast_set
     FROM dj_profiles WHERE id=?`
  ).bind(djId).first<any>();
  if (!dj) return c.json({ ok: false, error: 'DJ 없음' }, 404);
  return c.json({ ok: true, dj });
});

// ══════════════════════════════════════════
// C-8: 요율 (Rate Multipliers)
// ══════════════════════════════════════════

// ── 기본 요율 ──
const DEFAULT_RATES = {
  normal: 1.0,      // 일반 회원
  cafe: 0.5,        // 카페 (B2B)
  preview: 0,       // 미리듣기 (30초 무료)
  dj_self: 0        // DJ 본인
};

async function getRates(db: any): Promise<any> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run().catch(()=>{});
    const row = await db.prepare("SELECT value FROM tl_settings WHERE key='rate_multipliers'").first<any>();
    if (row && row.value) {
      return { ...DEFAULT_RATES, ...JSON.parse(row.value) };
    }
  } catch(_) {}
  return DEFAULT_RATES;
}

// ── GET /api/dj-cafe/rates — 요율 조회 (공개) ──
router.get('/rates', async (c) => {
  await ensureDJCafeTables(c.env.DB);
  const rates = await getRates(c.env.DB);
  return c.json({ ok: true, rates });
});

// ── POST /api/dj-cafe/rates — 요율 저장 (관리자) ──
router.post('/rates', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);

  // 관리자 확인
  const user = await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(auth.id).first<any>();
  if (!user || String(user.role || '').toLowerCase() !== 'admin') {
    return c.json({ ok: false, error: '관리자 권한 필요' }, 403);
  }

  const body = await c.req.json<any>().catch(() => ({}));
  const rates = {
    normal: Number(body.normal ?? DEFAULT_RATES.normal),
    cafe: Number(body.cafe ?? DEFAULT_RATES.cafe),
    preview: Number(body.preview ?? DEFAULT_RATES.preview),
    dj_self: Number(body.dj_self ?? DEFAULT_RATES.dj_self)
  };

  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run().catch(()=>{});
  await c.env.DB.prepare(
    `INSERT INTO tl_settings (key, value, updated_at) VALUES ('rate_multipliers', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(JSON.stringify(rates)).run();

  return c.json({ ok: true, rates });
});

// ── POST /api/dj-cafe/charge — 차감 계산 + 기록 (프론트에서 호출) ──
router.post('/charge', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const djId = Number(body.dj_id || 0);
  const shareId = String(body.share_id || '');
  const seconds = Math.max(1, Math.min(Number(body.seconds || 1), 60));
  const role = String(body.role || 'normal');  // 'normal' | 'cafe'

  if (!djId || !shareId) return c.json({ ok: false, error: 'dj_id, share_id 필요' }, 400);

  const rates = await getRates(c.env.DB);
  const multiplier = role === 'cafe' ? rates.cafe : rates.normal;

  // 곡의 file_tl 조회
  const share = await c.env.DB.prepare('SELECT file_tl FROM tl_shares WHERE id=?').bind(shareId).first<any>();
  if (!share) return c.json({ ok: false, error: '곡 없음' }, 404);

  const fileTl = Number(share.file_tl || 0);
  const totalCharge = fileTl * multiplier * seconds;

  // 청취자 TL 확인
  const listener = await c.env.DB.prepare(
    'SELECT tl, tl_p, tl_a, tl_b FROM users WHERE id=?'
  ).bind(auth.id).first<any>();
  const totalTL = Number(listener?.tl_p || 0) + Number(listener?.tl_a || 0) + Number(listener?.tl_b || 0);

  if (totalTL < totalCharge) {
    return c.json({
      ok: false,
      error: 'TL 부족',
      required: totalCharge,
      current: totalTL
    }, 402);
  }

  // 3분류 순차 차감 (tl_a → tl_b → tl_p)
  let remain = totalCharge;
  let tlA = Number(listener?.tl_a || 0);
  let tlB = Number(listener?.tl_b || 0);
  let tlP = Number(listener?.tl_p || 0);

  if (tlA > 0) { const d = Math.min(tlA, remain); tlA -= d; remain -= d; }
  if (tlB > 0 && remain > 0) { const d = Math.min(tlB, remain); tlB -= d; remain -= d; }
  if (tlP > 0 && remain > 0) { const d = Math.min(tlP, remain); tlP -= d; remain -= d; }

  // TL 차감
  await c.env.DB.prepare(
    'UPDATE users SET tl_a=?, tl_b=?, tl_p=?, tl=? WHERE id=?'
  ).bind(tlA, tlB, tlP, tlA + tlB + tlP, auth.id).run();

  // DJ/플랫폼 5:5 분배
  const dj = await c.env.DB.prepare('SELECT user_id FROM dj_profiles WHERE id=?').bind(djId).first<any>();
  const djAmount = totalCharge * 0.5;
  const platformAmount = totalCharge * 0.5;

  if (dj && dj.user_id) {
    await c.env.DB.prepare(
      'UPDATE users SET tl_p = COALESCE(tl_p,0) + ?, tl = COALESCE(tl,0) + ? WHERE id=?'
    ).bind(djAmount, djAmount, dj.user_id).run();
  }

  // 로그 기록
  await c.env.DB.prepare(
    `INSERT INTO dj_broadcast_logs (dj_id, share_id, listeners, seconds, tl_charged, revenue_dj, revenue_platform, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(djId, shareId, role === 'cafe' ? 1 : 0, seconds, totalCharge, djAmount, platformAmount, Date.now()).run();

  return c.json({
    ok: true,
    charged: totalCharge,
    multiplier,
    dj_revenue: djAmount,
    platform_revenue: platformAmount,
    new_tl: tlA + tlB + tlP
  });
});

// ══════════════════════════════════════════
// C-9: 현재 곡 정보 (카페가 폴링)
// ══════════════════════════════════════════

// ── GET /api/dj-cafe/live/:djId/now — DJ의 현재 재생 곡 ──
router.get('/live/:djId{[0-9]+}/now', async (c) => {
  const djId = Number(c.req.param('djId'));
  await ensureDJCafeTables(c.env.DB);

  const dj = await c.env.DB.prepare(
    `SELECT id, dj_name, avatar_url, is_live, live_started_at,
            live_current_track_id, live_current_started_at, live_listener_count
     FROM dj_profiles WHERE id=?`
  ).bind(djId).first<any>();

  if (!dj) return c.json({ ok: false, error: 'DJ 없음' }, 404);
  if (!dj.is_live) return c.json({ ok: false, error: '방송 중 아님', is_live: false }, 200);

  // 현재 곡 정보 조회
  let track = null;
  if (dj.live_current_track_id) {
    track = await c.env.DB.prepare(
      `SELECT id, title, artist, album, category, duration,
              cover_url, stream_url, preview_url, file_tl,
              content_kind, release_mode
       FROM tl_shares WHERE id=?`
    ).bind(dj.live_current_track_id).first<any>();
  }

  const now = Date.now();
  const elapsedMs = dj.live_current_started_at
    ? (now - Number(dj.live_current_started_at))
    : 0;

  return c.json({
    ok: true,
    is_live: true,
    dj: {
      id: dj.id,
      dj_name: dj.dj_name,
      avatar_url: dj.avatar_url,
      live_listener_count: dj.live_listener_count || 0,
      live_started_at: dj.live_started_at
    },
    current_track: track ? {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      category: track.category,
      duration: track.duration,
      cover_url: track.cover_url,
      stream_url: track.stream_url || track.preview_url,
      file_tl: track.file_tl,
      content_kind: track.content_kind,
      release_mode: track.release_mode,
      started_at: dj.live_current_started_at,
      elapsed_ms: elapsedMs
    } : null
  });
});

export default router;