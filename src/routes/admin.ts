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

export default router;