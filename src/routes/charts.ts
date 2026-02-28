import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const baseQuery = `SELECT f.*, u.username FROM tl_files f
  JOIN users u ON f.user_id = u.id
  WHERE f.auth_status = 'verified' AND f.shared = 1 AND f.revenue_held = 0`;

// GET /hot
router.get('/hot', async (c) => {
  const limit = Number(c.req.query('limit') || 20);
  const rows = await c.env.DB.prepare(`${baseQuery} ORDER BY f.pulse DESC LIMIT ?`).bind(limit).all();
  const results = (rows.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

// GET /new
router.get('/new', async (c) => {
  const limit = Number(c.req.query('limit') || 20);
  const rows = await c.env.DB.prepare(
    `${baseQuery} AND f.created_at >= datetime('now', '-7 days') ORDER BY f.created_at DESC LIMIT ?`
  ).bind(limit).all();
  const results = (rows.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

// GET /rise
router.get('/rise', async (c) => {
  const limit = Number(c.req.query('limit') || 20);
  const rows = await c.env.DB.prepare(
    `${baseQuery} AND f.updated_at >= datetime('now', '-1 day') ORDER BY f.play_count DESC LIMIT ?`
  ).bind(limit).all();
  const results = (rows.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

// GET /by-type
router.get('/by-type', async (c) => {
  const fileType = c.req.query('file_type') || 'audio';
  const limit = Number(c.req.query('limit') || 20);
  const rows = await c.env.DB.prepare(
    `${baseQuery} AND f.file_type = ? ORDER BY f.pulse DESC LIMIT ?`
  ).bind(fileType, limit).all();
  const results = (rows.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

// GET /global
router.get('/global', async (c) => {
  const limit = Number(c.req.query('limit') || 20);
  const rows = await c.env.DB.prepare(`${baseQuery} ORDER BY f.pulse DESC LIMIT ?`).bind(limit).all();
  const results = (rows.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

export default router;
