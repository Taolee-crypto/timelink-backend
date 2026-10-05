import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

// ── 관리자 확인 ──
async function requireAdmin(c: any): Promise<number | null> {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return null;
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return null;
  const userId = Number(payload.sub || 0);
  if (!userId) return null;
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id=?').bind(userId).first<any>();
  if (!user || String(user.role || '').toLowerCase() !== 'admin') return null;
  return userId;
}

// ── POST /api/admin/sql ──
// 관리자 전용 SQL 실행. DROP/ALTER/TRUNCATE는 차단.
router.post('/sql', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));
  const sql = String(body.sql || body.query || '').trim();
  if (!sql) return c.json({ error: 'sql 필요' }, 400);

  // 위험한 구문 차단 (DROP, ALTER, TRUNCATE, PRAGMA 등)
  const forbidden = /\b(DROP|ALTER|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;
  if (forbidden.test(sql)) {
    return c.json({ ok: false, error: '허용되지 않은 SQL 구문입니다.' }, 403);
  }

  // 여러 statement 차단 (세미콜론이 문자열 안에 있지 않은 경우)
  const stripped = sql.replace(/'(?:[^']|'')*'/g, '').replace(/"(?:[^"]|"")*"/g, '');
  if (stripped.includes(';') && stripped.trim().replace(/;+\s*$/, '').includes(';')) {
    return c.json({ ok: false, error: '여러 개의 SQL 문은 실행할 수 없습니다.' }, 400);
  }

  const isSelect = /^\s*(SELECT|WITH)\b/i.test(sql);

  try {
    if (isSelect) {
      const result = await c.env.DB.prepare(sql).all();
      return c.json({ ok: true, results: result.results || [], rows: result.results || [] });
    }
    const result = await c.env.DB.prepare(sql).run();
    return c.json({ ok: true, changes: Number(result.meta?.changes || 0), meta: result.meta || null });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'SQL 실행 실패' }, 500);
  }
});

// ── POST /api/admin/settings/:key ── 설정 저장
router.post('/settings/:key', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  
  const key = c.req.param('key');
  const body = await c.req.json<any>().catch(() => ({}));
  const value = String(body.value || '');
  
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tl_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`
  ).run().catch(()=>{});
  
  await c.env.DB.prepare(
    `INSERT INTO tl_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value).run();
  
  return c.json({ ok: true });
});

// ── GET /api/admin/settings/:key ── 설정 조회
router.get('/settings/:key', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  
  const key = c.req.param('key');
  const row = await c.env.DB.prepare(
    'SELECT value FROM tl_settings WHERE key=?'
  ).bind(key).first<any>();
  
  return c.json({ value: row?.value || null });
});

// ══════════════════════════════════════════
// DJ 관리 (Admin)
// ══════════════════════════════════════════

// ── DJ 테이블 보장 ──
async function ensureDJTables(db: any) {
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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});
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
}

// ── GET /api/admin/dj/list — 전체 DJ 목록 ──
router.get('/dj/list', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT d.*, u.email, u.username,
              (SELECT COUNT(*) FROM dj_cafe_links WHERE dj_id=d.id AND status='active') as active_contracts,
              (SELECT COUNT(*) FROM dj_cafe_links WHERE dj_id=d.id AND status='pending') as pending_apps
       FROM dj_profiles d
       LEFT JOIN users u ON d.user_id = u.id
       ORDER BY d.total_listeners DESC, d.rating DESC`
    ).all();
    return c.json({ ok: true, djs: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'DJ 목록 실패' }, 500);
  }
});

// ── GET /api/admin/dj/stats — DJ 통계 ──
router.get('/dj/stats', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const total = await c.env.DB.prepare('SELECT COUNT(*) cnt FROM dj_profiles').first<any>();
    const active = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_profiles WHERE status='active'").first<any>();
    const banned = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_profiles WHERE status='banned'").first<any>();
    const pending = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_cafe_links WHERE status='pending'").first<any>();
    const activeLinks = await c.env.DB.prepare("SELECT COUNT(*) cnt FROM dj_cafe_links WHERE status='active'").first<any>();
    return c.json({
      ok: true,
      stats: {
        total_djs: Number(total?.cnt || 0),
        active_djs: Number(active?.cnt || 0),
        banned_djs: Number(banned?.cnt || 0),
        pending_applications: Number(pending?.cnt || 0),
        active_links: Number(activeLinks?.cnt || 0)
      }
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '통계 실패' }, 500);
  }
});

// ── GET /api/admin/dj-links — 전체 매칭 목록 ──
router.get('/dj-links', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    await ensureDJTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT l.*, d.dj_name, cc.name as cafe_name
       FROM dj_cafe_links l
       LEFT JOIN dj_profiles d ON l.dj_id = d.id
       LEFT JOIN cafe_channels cc ON l.cafe_channel_id = cc.channel_id
       ORDER BY l.created_at DESC LIMIT 200`
    ).all();
    return c.json({ ok: true, links: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '매칭 목록 실패' }, 500);
  }
});

// ── POST /api/admin/dj/:id/ban — DJ 정지 ──
router.post('/dj/:id/ban', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_profiles SET status='banned', updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '정지 실패' }, 500);
  }
});

// ── POST /api/admin/dj/:id/unban — DJ 해제 ──
router.post('/dj/:id/unban', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_profiles SET status='active', updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '해제 실패' }, 500);
  }
});

// ── POST /api/admin/dj-links/:id/force-end — 매칭 강제 종료 ──
router.post('/dj-links/:id/force-end', async (c) => {
  const userId = await requireAdmin(c);
  if (!userId) return c.json({ error: '관리자 권한 필요' }, 401);
  try {
    const id = Number(c.req.param('id'));
    await c.env.DB.prepare("UPDATE dj_cafe_links SET status='ended', ended_at=?, updated_at=? WHERE id=?")
      .bind(Date.now(), Date.now(), id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '종료 실패' }, 500);
  }
});

export default router;