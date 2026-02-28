import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import filesRouter from './routes/files';
import playbackRouter from './routes/playback';
import shareplaceRouter from './routes/shareplace';
import disputesRouter from './routes/disputes';
import chartsRouter from './routes/charts';

const app = new Hono<{ Bindings: Env }>();

// CORS - 모든 오리진 허용 (개발 단계)
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// OPTIONS preflight 명시적 처리
app.options('*', (c) => c.text('', 204));

// Health check
app.get('/api/v1/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({
      status: 'ok', version: '2.0.0',
      environment: c.env.ENVIRONMENT,
      database: 'ok',
      endpoints: {
        auth: '/api/v1/auth',
        users: '/api/v1/users',
        files: '/api/v1/files',
        playback: '/api/v1/playback',
        shareplace: '/api/v1/shareplace',
        disputes: '/api/v1/disputes',
        charts: '/api/v1/charts',
      }
    });
  } catch {
    return c.json({ status: 'error', database: 'error' }, 500);
  }
});

// Routes
app.route('/api/v1/auth', authRouter);
app.route('/api/v1/users', usersRouter);
app.route('/api/v1/files', filesRouter);
app.route('/api/v1/playback', playbackRouter);
app.route('/api/v1/shareplace', shareplaceRouter);
app.route('/api/v1/disputes', disputesRouter);
app.route('/api/v1/charts', chartsRouter);


// =================== PATCH INSTRUCTIONS ===================
// src/index.ts 파일에서 아래 줄을 찾으세요:
//   app.notFound((c) => c.json({ detail: 'Not found' }, 404));
//
// 그 앞에 아래 코드를 붙여넣으세요:

// =================== PUBLIC ENDPOINTS (no auth) ===================

// GET /api/tracks - SharePlace public track list
app.get('/api/tracks', async (c) => {
  try {
    const genre = c.req.query('genre');
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    
    let query = `
      SELECT 
        f.id, f.title, f.artist, f.genre, f.icon,
        f.pulse, f.price_per_sec, f.stream_url, f.cover_image,
        f.spotify_album, f.auth_status, f.file_type,
        f.play_count, f.created_at,
        u.username as creator
      FROM tl_files f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE (f.shared = 1 OR f.shared_to_shareplace = 1)
        AND f.stream_url IS NOT NULL AND f.stream_url != ''
      `;
    const params: (string|number)[] = [];
    if (genre && genre !== 'all') { 
      query += ' AND f.genre = ?';
      params.push(genre);
    }
    query += ' ORDER BY f.pulse DESC, f.created_at DESC LIMIT ?';
    params.push(limit);
    
    const result = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ tracks: result.results || [], total: result.results?.length || 0 });
  } catch (e: any) {
    return c.json({ tracks: [], total: 0, error: e.message }, 500);
  }
});

// POST /api/files/sync - library.html에서 D1에 파일 동기화
app.post('/api/files/sync', async (c) => {
  try {
    const body = await c.req.json<{
      id: string; title: string; artist?: string; genre?: string;
      stream_url?: string; cover_image?: string; price_per_sec?: number;
      spotify_album?: string; shared_to_shareplace?: boolean;
      pulse?: number; auth_status?: string; icon?: string;
      user_email?: string; username?: string;
    }>();
    
    if (!body.title) return c.json({ error: 'title required' }, 422);
    
    // 사용자 찾거나 생성 (이메일 기반)
    let userId: number = 1; // fallback
    if (body.user_email) {
      let user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
        .bind(body.user_email).first<{ id: number }>();
      if (!user && body.username) {
        const ins = await c.env.DB.prepare(
          `INSERT OR IGNORE INTO users (email, username, password_hash, tl_balance)
           VALUES (?, ?, 'local_sync', 1000) RETURNING id`
        ).bind(body.user_email, body.username).first<{ id: number }>();
        user = ins || null;
        if (!user) {
          user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
            .bind(body.user_email).first<{ id: number }>();
        }
      }
      if (user) userId = user.id;
    }
    
    // 기존 레코드 확인 (id가 uuid string이면 title+artist로 매칭)
    const existing = await c.env.DB.prepare(
      'SELECT id FROM tl_files WHERE title = ? AND user_id = ?'
    ).bind(body.title, userId).first<{ id: number }>();
    
    if (existing) {
      // UPDATE
      await c.env.DB.prepare(`
        UPDATE tl_files SET
          artist = ?, genre = ?, stream_url = ?, cover_image = ?,
          price_per_sec = ?, spotify_album = ?,
          shared_to_shareplace = ?, pulse = ?,
          auth_status = ?, icon = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        body.artist||'', body.genre||'etc',
        body.stream_url||'', body.cover_image||'',
        body.price_per_sec||1, body.spotify_album||'',
        body.shared_to_shareplace ? 1 : 0,
        body.pulse||0, body.auth_status||'unverified',
        body.icon||'🎵', existing.id
      ).run();
      return c.json({ ok: true, action: 'updated', d1_id: existing.id });
    } else {
      // INSERT
      const res = await c.env.DB.prepare(`
        INSERT INTO tl_files (
          user_id, title, artist, genre, stream_url, cover_image,
          price_per_sec, spotify_album, shared_to_shareplace,
          pulse, auth_status, icon, file_tl, max_file_tl, shared
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        RETURNING id
      `).bind(
        userId, body.title, body.artist||'', body.genre||'etc',
        body.stream_url||'', body.cover_image||'',
        body.price_per_sec||1, body.spotify_album||'',
        body.shared_to_shareplace ? 1 : 0,
        body.pulse||0, body.auth_status||'unverified',
        body.icon||'🎵',
        body.shared_to_shareplace ? 1 : 0
      ).first<{ id: number }>();
      return c.json({ ok: true, action: 'created', d1_id: res?.id });
    }
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// GET /api/tracks/:id/play - 재생 이벤트 기록
app.post('/api/tracks/:id/play', async (c) => {
  try {
    const fileId = c.req.param('id');
    const body = await c.req.json<{ tl_deducted?: number; duration_seconds?: number }>().catch(() => ({}));
    
    await c.env.DB.prepare(`
      UPDATE tl_files SET 
        pulse = pulse + 1,
        play_count = play_count + 1,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(fileId).run();
    
    await c.env.DB.prepare(`
      INSERT INTO play_events (file_id, tl_deducted, play_duration_seconds)
      VALUES (?, ?, ?)
    `).bind(fileId, body.tl_deducted||0, body.duration_seconds||0).run();
    
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message });
  }
});

app.notFound((c) => c.json({ detail: 'Not found' }, 404));

export default app;

