import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

// GET / - SharePlace 목록
router.get('/', async (c) => {
  const genre = c.req.query('genre');
  const fileType = c.req.query('file_type');
  const sort = c.req.query('sort') || 'pulse';
  const limit = Number(c.req.query('limit') || 20);
  const offset = Number(c.req.query('offset') || 0);

  let query = `SELECT f.*, u.username FROM tl_files f
    JOIN users u ON f.user_id = u.id
    WHERE f.auth_status = 'verified' AND f.shared = 1 AND f.revenue_held = 0`;
  const params: (string | number)[] = [];

  if (genre) { query += ' AND f.genre = ?'; params.push(genre); }
  if (fileType) { query += ' AND f.file_type = ?'; params.push(fileType); }

  const orderCol = sort === 'new' ? 'f.created_at' : sort === 'tl' ? 'f.file_tl' : 'f.pulse';
  query += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json(rows.results);
});

// GET /contributor-ranking
router.get('/contributor-ranking', async (c) => {
  const period = c.req.query('period') || 'weekly';
  const limit = Number(c.req.query('limit') || 20);

  let dateFilter = '';
  if (period === 'weekly') dateFilter = `AND f.updated_at >= datetime('now', '-7 days')`;
  else if (period === 'monthly') dateFilter = `AND f.updated_at >= datetime('now', '-30 days')`;

  const query = `
    SELECT
      f.user_id,
      u.username,
      u.poc_index,
      u.false_dispute_strikes,
      u.account_forfeited,
      SUM(f.revenue) as total_revenue,
      SUM(f.pulse) as total_pulse,
      SUM(f.play_count) as total_plays,
      COUNT(f.id) as verified_tracks
    FROM tl_files f
    JOIN users u ON f.user_id = u.id
    WHERE f.auth_status = 'verified' AND f.shared = 1 ${dateFilter}
    GROUP BY f.user_id
    ORDER BY total_pulse DESC
    LIMIT ?
  `;

  const rows = await c.env.DB.prepare(query).bind(limit).all();
  const results = (rows.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

export default router;
