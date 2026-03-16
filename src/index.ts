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
import paymentRouter from './payment';
import ecoRouter from './economics';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.options('*', (c) => c.text('', 204));

app.get('/api/v1/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({
      status: 'ok', version: '2.0.0',
      environment: c.env.ENVIRONMENT,
      database: 'ok',
      endpoints: {
        auth: '/api/v1/auth', users: '/api/v1/users', files: '/api/v1/files',
        playback: '/api/v1/playback', shareplace: '/api/v1/shareplace',
        disputes: '/api/v1/disputes', charts: '/api/v1/charts',
      }
    });
  } catch {
    return c.json({ status: 'error', database: 'error' }, 500);
  }
});

app.route('/api/v1/auth', authRouter);
app.route('/api/v1/users', usersRouter);
app.route('/api/v1/files', filesRouter);
app.route('/api/v1/playback', playbackRouter);
app.route('/api/v1/shareplace', shareplaceRouter);
app.route('/api/v1/disputes', disputesRouter);
app.route('/api/v1/charts', chartsRouter);
app.route('/api/payment', paymentRouter);
app.route('/api/eco', ecoRouter);

// GET /api/tracks
app.get('/api/tracks', async (c) => {
  try {
    const genre = c.req.query('genre');
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    let query = `
      SELECT f.id, f.title, f.artist, f.genre, f.icon,
        f.pulse, f.price_per_sec, f.stream_url, f.cover_image,
        f.spotify_album, f.auth_status, f.file_type,
        f.play_count, f.created_at, u.username as creator
      FROM tl_files f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE (f.shared = 1 OR f.shared_to_shareplace = 1)
        AND f.stream_url IS NOT NULL AND f.stream_url != ''`;
    const params: (string | number)[] = [];
    if (genre && genre !== 'all') { query += ' AND f.genre = ?'; params.push(genre); }
    query += ' ORDER BY f.pulse DESC, f.created_at DESC LIMIT ?';
    params.push(limit);
    const result = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ tracks: result.results || [], total: result.results?.length || 0 });
  } catch (e: any) {
    return c.json({ tracks: [], total: 0, error: e.message }, 500);
  }
});

// POST /api/files/sync
app.post('/api/files/sync', async (c) => {
  try {
    const body = await c.req.json<any>();
    if (!body.title) return c.json({ error: 'title required' }, 422);
    let userId: number = 1;
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
    const existing = await c.env.DB.prepare(
      'SELECT id FROM tl_files WHERE title = ? AND user_id = ?'
    ).bind(body.title, userId).first<{ id: number }>();
    if (existing) {
      await c.env.DB.prepare(`
        UPDATE tl_files SET artist=?, genre=?, stream_url=?, cover_image=?,
          price_per_sec=?, spotify_album=?, shared_to_shareplace=?, pulse=?,
          auth_status=?, icon=?, updated_at=datetime('now') WHERE id=?
      `).bind(
        body.artist||'', body.genre||'etc', body.stream_url||'', body.cover_image||'',
        body.price_per_sec||1, body.spotify_album||'',
        body.shared_to_shareplace ? 1 : 0, body.pulse||0,
        body.auth_status||'unverified', body.icon||'🎵', existing.id
      ).run();
      return c.json({ ok: true, action: 'updated', d1_id: existing.id });
    } else {
      const res = await c.env.DB.prepare(`
        INSERT INTO tl_files (user_id,title,artist,genre,stream_url,cover_image,
          price_per_sec,spotify_album,shared_to_shareplace,pulse,auth_status,icon,file_tl,max_file_tl,shared)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?) RETURNING id
      `).bind(
        userId, body.title, body.artist||'', body.genre||'etc',
        body.stream_url||'', body.cover_image||'', body.price_per_sec||1,
        body.spotify_album||'', body.shared_to_shareplace ? 1 : 0, body.pulse||0,
        body.auth_status||'unverified', body.icon||'🎵',
        body.shared_to_shareplace ? 1 : 0
      ).first<{ id: number }>();
      return c.json({ ok: true, action: 'created', d1_id: res?.id });
    }
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// POST /api/tracks/:id/play
app.post('/api/tracks/:id/play', async (c) => {
  try {
    const fileId = c.req.param('id');
    const body = await c.req.json<any>().catch(() => ({}));
    await c.env.DB.prepare(`
      UPDATE tl_files SET pulse=pulse+1, play_count=play_count+1, updated_at=datetime('now') WHERE id=?
    `).bind(fileId).run();
    await c.env.DB.prepare(
      'INSERT INTO play_events (file_id,tl_deducted,play_duration_seconds) VALUES (?,?,?)'
    ).bind(fileId, body.tl_deducted||0, body.duration_seconds||0).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message });
  }
});

// ── 파일 업로드 (R2) ─────────────────────────────────────
// FIX: file.stream() → file.arrayBuffer()
// Cloudflare Workers FormData의 File.stream()은 불안정 — arrayBuffer() 사용
app.post('/api/upload', async (c) => {
  if (!c.env.R2) {
    return c.json({ ok: false, error: 'R2 바인딩 없음 — wrangler.toml [[r2_buckets]] 확인' }, 500);
  }
  try {
    const formData = await c.req.parseBody();
    const file = formData['file'] as File;
    const trackId = formData['trackId'] as string;

    if (!file || !trackId) {
      return c.json({ ok: false, error: 'file, trackId 필수' }, 400);
    }
    if (file.size > 200 * 1024 * 1024) {
      return c.json({ ok: false, error: '200MB 초과 불가' }, 400);
    }

    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const key = `tracks/${trackId}.${ext}`;
    const contentType = file.type || 'application/octet-stream';

    // stream() 대신 arrayBuffer() 사용
    const buffer = await file.arrayBuffer();

    await c.env.R2.put(key, buffer, {
      httpMetadata: { contentType },
      customMetadata: {
        originalName: file.name,
        trackId,
        uploadedAt: Date.now().toString(),
      },
    });

    const publicUrl = `https://pub-c8d04f598d434d2f9568c08938d892a7.r2.dev/${key}`;
    return c.json({ ok: true, url: publicUrl, key, size: file.size });

  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ── Spotify 검색 ──────────────────────────────────────────
let _spToken: string | null = null;
let _spExp = 0;
async function getSpotifyToken(env: Env): Promise<string> {
  if (_spToken && Date.now() < _spExp) return _spToken;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa((env as any).SPOTIFY_CLIENT_ID + ':' + (env as any).SPOTIFY_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const d: any = await r.json();
  _spToken = d.access_token;
  _spExp = Date.now() + (d.expires_in - 60) * 1000;
  return _spToken!;
}

app.get('/api/spotify/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q 필요' }, 400);
  const env = c.env as any;
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return c.json({ tracks: [] });
  try {
    const token = await getSpotifyToken(c.env);
    const r = await fetch(
      'https://api.spotify.com/v1/search?q=' + encodeURIComponent(q) + '&type=track&limit=6&market=KR',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const d: any = await r.json();
    const tracks = (d.tracks?.items || []).map((t: any) => ({
      id: t.id, title: t.name,
      artist: t.artists.map((a: any) => a.name).join(', '),
      album: t.album?.name || '',
      duration: Math.round(t.duration_ms / 1000),
      cover_url: t.album?.images?.[0]?.url || '',
      preview_url: t.preview_url || '',
      spotify_url: t.external_urls?.spotify || '',
      release_date: t.album?.release_date || ''
    }));
    return c.json({ tracks });
  } catch (e: any) {
    return c.json({ tracks: [], error: e.message });
  }
});

// ── SharePlace API ──────────────────────────────────────

function parseJWT(token: string): { userId: number; username: string } {
  if (token.split('.').length === 3) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('Token expired');
      return {
        userId: Number(payload.userId || payload.id || payload.sub),
        username: payload.username || payload.email || 'User'
      };
    } catch(e) { throw new Error('Invalid JWT'); }
  }
  const m = token.match(/(?:fallback|token)_(\d+)/);
  if (m) return { userId: Number(m[1]), username: 'User' };
  if (/^(demo|local|guest)_/.test(token)) return { userId: 0, username: 'User' };
  throw new Error('Unknown token format: ' + token.slice(0, 20));
}

app.get('/api/shares', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT s.*,
        COALESCE(u.username, s.username, 'User') as username,
        COALESCE(u.email, '') as user_email
      FROM tl_shares s
      LEFT JOIN users u ON CAST(s.user_id AS TEXT) = CAST(u.id AS TEXT)
      ORDER BY s.created_at DESC LIMIT 200
    `).all();
    return c.json({ shares: results || [] });
  } catch (e: any) {
    return c.json({ shares: [], _note: e.message });
  }
});

app.post('/api/shares', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  let userId: number, username: string;
  try {
    const p = parseJWT(auth);
    userId = p.userId; username = p.username;
  } catch (e) { return c.json({ error: 'Invalid token: ' + (e as Error).message }, 401); }

  const bodyRaw = await c.req.json<any>();

  if (!userId || userId === 0) {
    userId = Number(bodyRaw.user_id || bodyRaw.userId || 0);
    username = bodyRaw.username || username || 'User';
  }
  if (!userId) return c.json({ error: 'user_id 확인 불가' }, 401);

  let userRow = await c.env.DB.prepare('SELECT * FROM users WHERE id=? OR email=?')
    .bind(userId, bodyRaw.email || '').first<any>().catch(() => null);

  // fallback 유저 자동 생성 — tl_balance 먼저, 실패시 tl 컬럼으로 재시도
  if (!userRow && bodyRaw.email) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO users (username, email, password_hash, tl_balance)
       VALUES (?, ?, 'fallback', 10000)`
    ).bind(bodyRaw.username || 'User', bodyRaw.email).run()
      .catch(() =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO users (username, email, password_hash, tl)
           VALUES (?, ?, 'fallback', 10000)`
        ).bind(bodyRaw.username || 'User', bodyRaw.email).run().catch(() => {})
      );
    userRow = await c.env.DB.prepare('SELECT * FROM users WHERE email=?')
      .bind(bodyRaw.email).first<any>().catch(() => null);
  }
  if (!userRow) return c.json({ error: '유저 없음 — 로그인 후 이용하세요' }, 404);

  const tl = userRow.tl ?? userRow.tl_balance ?? 0;
  if (tl < 5000) return c.json({ error: 'TL 부족', required: 5000, current: tl }, 402);

  const body = bodyRaw;
  if (!body.title) return c.json({ error: 'title 필요' }, 400);

  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tl_shares (
      id TEXT PRIMARY KEY, user_id TEXT, username TEXT,
      title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '',
      duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0,
      category TEXT DEFAULT 'Music', file_type TEXT DEFAULT '',
      description TEXT DEFAULT '', plan TEXT DEFAULT 'A',
      spotify_id TEXT, spotify_url TEXT, cover_url TEXT, preview_url TEXT,
      stream_url TEXT DEFAULT '',
      pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    )
  `).run().catch(() => {});

  const tlCol = userRow.tl !== undefined ? 'tl' : 'tl_balance';
  const realId = userRow.id;
  await c.env.DB.prepare(`UPDATE users SET ${tlCol}=${tlCol}-5000 WHERE id=?`).bind(realId).run();

  const id = 'sh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  await c.env.DB.prepare(`
    INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,
      category,file_type,description,plan,spotify_id,spotify_url,cover_url,preview_url,stream_url,pulse,created_at)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,0,?)
  `).bind(
    id, String(realId), username,
    body.title, body.artist || '', body.album || '',
    body.duration || 0,
    body.category || 'Music', body.file_type || '',
    body.description || '', body.plan || 'A',
    body.spotify_id || null, body.spotify_url || null,
    body.cover_url || null, body.preview_url || null,
    body.stream_url || null,
    Date.now()
  ).run();

  const updated = await c.env.DB.prepare(`SELECT ${tlCol} as tl FROM users WHERE id=?`).bind(realId).first<{ tl: number }>();
  return c.json({ ok: true, id, tl_remaining: updated?.tl || 0 });
});

app.delete('/api/shares/:id', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);
  let userId: number;
  try { userId = parseJWT(auth).userId; } catch (e) { return c.json({ error: 'Invalid token' }, 401); }
  await c.env.DB.prepare('DELETE FROM tl_shares WHERE id=? AND user_id=?')
    .bind(c.req.param('id'), String(userId)).run().catch(() => {});
  return c.json({ ok: true });
});

app.post('/api/shares/:id/pulse', async (c) => {
  try {
    await c.env.DB.prepare('UPDATE tl_shares SET pulse=pulse+1 WHERE id=?').bind(c.req.param('id')).run();
    const row = await c.env.DB.prepare('SELECT pulse FROM tl_shares WHERE id=?')
      .bind(c.req.param('id')).first<{ pulse: number }>();
    return c.json({ ok: true, pulse: row?.pulse || 0 });
  } catch (e) { return c.json({ ok: true, pulse: 0 }); }
});

// charge/consume v1 제거됨 — tl_user_files 기반 v2 사용 (아래에 등록)

app.notFound((c) => c.json({ detail: 'Not found' }, 404));


// ADMIN: 유저 목록
app.get('/api/users', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance, tlc_balance as tlc, created_at FROM users ORDER BY id ASC').all();
    return c.json({ users: result.results || [] });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ADMIN: SQL 실행
app.post('/api/admin/sql', async (c) => {
  try {
    const { sql } = await c.req.json();
    if (!sql) return c.json({ error: 'sql required' }, 400);
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT')) {
      const result = await c.env.DB.prepare(sql).all();
      return c.json({ results: result.results, count: result.results?.length || 0 });
    } else {
      const result = await c.env.DB.prepare(sql).run();
      return c.json({ success: true, meta: result.meta });
    }
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ADMIN: 유저 목록
app.get('/api/users', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance, tlc_balance as tlc, created_at FROM users ORDER BY id ASC').all();
    return c.json({ users: result.results || [] });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ADMIN: SQL 실행
app.post('/api/admin/sql', async (c) => {
  try {
    const { sql } = await c.req.json();
    if (!sql) return c.json({ error: 'sql required' }, 400);
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT')) {
      const result = await c.env.DB.prepare(sql).all();
      return c.json({ results: result.results, count: result.results?.length || 0 });
    } else {
      const result = await c.env.DB.prepare(sql).run();
      return c.json({ success: true, meta: result.meta });
    }
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 회원가입
app.post('/api/auth/register', async (c) => {
  try {
    const { email, password, username } = await c.req.json();
    if (!email || !password || !username) return c.json({ error: '필수 항목 누락' }, 400);

    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (exists) return c.json({ error: '이미 가입된 이메일입니다' }, 409);

    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    const result = await c.env.DB.prepare(
      'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at) VALUES (?,?,?,10000,10000,0,?)'
    ).bind(email, username, password, now).run();

    const user = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance, tlc_balance as tlc FROM users WHERE email=?').bind(email).first();
    const token = 'token_' + user.id + '_' + Date.now();
    return c.json({ ok: true, token, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 로그인
app.post('/api/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) return c.json({ error: '이메일/비밀번호 필요' }, 400);

    const user = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance, tlc_balance as tlc FROM users WHERE email=? AND password_hash=?').bind(email, password).first();
    if (!user) return c.json({ error: '이메일 또는 비밀번호가 틀렸습니다' }, 401);

    const token = 'token_' + user.id + '_' + Date.now();
    return c.json({ ok: true, token, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 이메일 중복 확인
app.post('/api/auth/check-email', async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: '이메일 필요' }, 400);
    const row = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    return c.json({ exists: !!row });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// 회원가입 (signup)
app.post('/api/auth/signup', async (c) => {
  try {
    const { email, password, username } = await c.req.json();
    if (!email || !username) return c.json({ error: '필수 항목 누락' }, 400);

    // 이메일 중복 체크 — 이미 가입된 이메일이면 에러 반환
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (exists) {
      return c.json({ error: '이미 가입된 이메일입니다. 로그인을 이용해 주세요.' }, 409);
    }

    // 사용자명 중복 체크
    const nameExists = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first();
    if (nameExists) {
      return c.json({ error: '이미 사용 중인 닉네임입니다.' }, 409);
    }

    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    await c.env.DB.prepare(
      'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at) VALUES (?,?,?,10000,10000,0,?)'
    ).bind(email, username, password||'', now).run();

    const user = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance, tlc_balance as tlc FROM users WHERE email=?').bind(email).first();
    const token = 'token_' + user.id + '_' + Date.now();
    return c.json({ ok: true, token, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 오디오 프록시 — Workers ReadableStream (메모리 무관)
app.options('/api/audio/:filename', (c) => new Response(null, { headers: {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
}}));

app.get('/api/audio/:filename', async (c) => {
  try {
    const filename = c.req.param('filename');
    const key = 'tracks/' + filename;
    const rangeHeader = c.req.header('Range');

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!m) return new Response('Invalid Range', { status: 416 });

      const meta = await c.env.R2.head(key);
      if (!meta) return c.json({ error: 'Not found' }, 404);

      const total = meta.size;
      const start = parseInt(m[1]);
      const end = m[2] !== '' ? Math.min(parseInt(m[2]), total - 1) : total - 1;
      const length = end - start + 1;

      // R2 body = ReadableStream, Workers 메모리에 적재되지 않음
      const obj = await c.env.R2.get(key, { range: { offset: start, length } });
      if (!obj) return c.json({ error: 'Not found' }, 404);

      return new Response(obj.body, {
        status: 206,
        headers: { ...cors,
          'Content-Type': meta.httpMetadata?.contentType || 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(length),
        },
      });
    }

    // Range 없는 요청 — 전체 스트리밍 (body는 ReadableStream)
    const obj = await c.env.R2.get(key);
    if (!obj) return c.json({ error: 'Not found' }, 404);

    return new Response(obj.body, {
      status: 200,
      headers: { ...cors,
        'Content-Type': obj.httpMetadata?.contentType || 'audio/mpeg',
        'Content-Length': String(obj.size),
      },
    });

  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});


// 카페 채널 개설
app.post('/api/cafe/channel', async (c) => {
  try {
    const { channel_id, name, owner_id, biz_no, owner_name, addr, addr_detail, description, playlist, schedules } = await c.req.json();
    if (!channel_id || !name || !owner_id) return c.json({ error: '필수 항목 누락' }, 400);

    // 채널 ID 중복 확인
    const exists = await c.env.DB.prepare('SELECT id FROM cafe_channels WHERE channel_id=?').bind(channel_id).first();
    if (exists) return c.json({ error: '이미 사용 중인 채널 ID입니다' }, 409);

    // 유저 TL 잔액 확인
    const user = await c.env.DB.prepare('SELECT id, tl FROM users WHERE id=?').bind(owner_id).first();
    if (!user) return c.json({ error: '유저를 찾을 수 없습니다' }, 404);
    if ((user.tl as number) < 50000) return c.json({ error: 'TL 잔액 부족 (필요: 50,000 TL)' }, 402);

    // TL 차감
    await c.env.DB.prepare('UPDATE users SET tl=tl-50000 WHERE id=?').bind(owner_id).run();

    // 채널 생성
    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    const expires = new Date(Date.now()+30*24*60*60*1000).toISOString().replace('T',' ').substring(0,19);
    await c.env.DB.prepare(
      'INSERT INTO cafe_channels (channel_id, name, owner_id, biz_no, owner_name, addr, addr_detail, description, playlist, schedules, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(channel_id, name, owner_id, biz_no||'', owner_name||'', addr||'', addr_detail||'', description||'', JSON.stringify(playlist||[]), JSON.stringify(schedules||[]), now, expires).run();

    // 업데이트된 유저 TL 반환
    const updated = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance, tlc FROM users WHERE id=?').bind(owner_id).first();
    return c.json({ ok: true, channel_id, expires_at: expires, user: updated });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 카페 채널 목록
app.get('/api/cafe/channels', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT * FROM cafe_channels WHERE is_active=1 ORDER BY created_at DESC').all();
    return c.json({ channels: result.results || [] });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 내 카페 채널 조회
app.get('/api/cafe/channel/:owner_id', async (c) => {
  try {
    const owner_id = c.req.param('owner_id');
    const result = await c.env.DB.prepare('SELECT * FROM cafe_channels WHERE owner_id=? AND is_active=1 ORDER BY created_at DESC').bind(owner_id).all();
    return c.json({ channels: result.results || [] });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 워터마크 로그
app.post('/api/wm/log', async (c) => {
  try {
    const { share_id, user_id, device_fp, wm_freq, played_at, ua } = await c.req.json();
    await c.env.DB.prepare('INSERT INTO wm_logs (share_id,user_id,device_fp,wm_freq,played_at,ua) VALUES (?,?,?,?,?,?)')
      .bind(share_id||'',user_id||0,device_fp||'',wm_freq||0,played_at||'',ua||'').run();
    return c.json({ ok: true });
  } catch(e: any) { return c.json({ error: e.message }, 500); }
});

app.get('/api/wm/logs/:share_id', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT * FROM wm_logs WHERE share_id=? ORDER BY created_at DESC LIMIT 100').bind(c.req.param('share_id')).all();
    return c.json({ logs: result.results || [] });
  } catch(e: any) { return c.json({ error: e.message }, 500); }
});

// 인카 채널 개설
app.post('/api/incar/channel', async (c) => {
  try {
    const b = await c.req.json();
    const exp = new Date(Date.now()+30*24*60*60*1000).toISOString();
    await c.env.DB.prepare(
      'INSERT INTO incar_channels (channel_id,name,owner_id,owner_name,car_plate,car_type,drive_region,description,theme,playlist,schedules,poc_index_at_creation,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(b.channel_id,b.name,b.owner_id,b.owner_name,b.car_plate||'',b.car_type||'',b.drive_region||'',b.description||'',b.theme||'city',b.playlist||'[]',b.schedules||'[]',b.poc_index_at_creation||1.0,exp).run();
    return c.json({ok:true});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// 인카 채널 목록
app.get('/api/incar/channels', async (c) => {
  try {
    const r = await c.env.DB.prepare('SELECT * FROM incar_channels WHERE is_active=1 ORDER BY created_at DESC').all();
    return c.json({channels: r.results||[]});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// 워터마크 로그
app.post('/api/wm/log', async (c) => {
  try {
    const { share_id, user_id, device_fp, wm_freq, played_at, ua } = await c.req.json();
    await c.env.DB.prepare('INSERT INTO wm_logs (share_id,user_id,device_fp,wm_freq,played_at,ua) VALUES (?,?,?,?,?,?)')
      .bind(share_id||'',user_id||0,device_fp||'',wm_freq||0,played_at||'',ua||'').run();
    return c.json({ ok: true });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// 유저-파일 TL 충전 (1:1)
app.post('/api/shares/:id/charge', async (c) => {
  try {
    const share_id = c.req.param('id');
    const { amount, user_id, email } = await c.req.json();
    if(!amount || amount <= 0) return c.json({error:'Invalid amount'}, 400);
    // 유저 TL 차감
    await c.env.DB.prepare('UPDATE users SET tl=tl-? WHERE id=? AND tl>=?')
      .bind(amount, user_id, amount).run();
    // 파일별 TL 적립
    await c.env.DB.prepare(`INSERT INTO tl_user_files (user_id,share_id,tl_balance,total_charged)
      VALUES (?,?,?,?) ON CONFLICT(user_id,share_id) DO UPDATE SET
      tl_balance=tl_balance+excluded.tl_balance,
      total_charged=total_charged+excluded.total_charged,
      updated_at=datetime('now')`)
      .bind(user_id, share_id, amount, amount).run();
    // 파일 전체 pulse 증가
    await c.env.DB.prepare('UPDATE tl_shares SET pulse=pulse+1 WHERE id=?').bind(share_id).run();
    const row = await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?').bind(user_id, share_id).first();
    return c.json({ok:true, user_tl: row?.tl_balance || 0});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// 유저-파일 TL 소비 (재생 시)
app.post('/api/shares/:id/consume', async (c) => {
  try {
    const share_id = c.req.param('id');
    const { seconds, user_id } = await c.req.json();
    if(!user_id) return c.json({error:'user_id required'},400);
    const consume = seconds || 5;
    await c.env.DB.prepare(`UPDATE tl_user_files SET
      tl_balance=MAX(0,tl_balance-?),
      total_consumed=total_consumed+?,
      last_played=datetime('now'),
      updated_at=datetime('now')
      WHERE user_id=? AND share_id=?`)
      .bind(consume, consume, user_id, share_id).run();
    // 크리에이터에게 수익 배분 (플랜에 따라)
    const share = await c.env.DB.prepare('SELECT user_id,plan FROM tl_shares WHERE id=?').bind(share_id).first();
    if(share){
      // 신 배분율: 플랜A 62%, 플랜B 45% (TL_P 기준)
      const rate = share.plan==='B' ? 0.45 : 0.62;
      const earn = Math.floor(consume * rate);
      if(earn>0) await c.env.DB.prepare('UPDATE users SET tl=tl+? WHERE id=?').bind(earn, share.user_id).run();
    }
    const row = await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?').bind(user_id, share_id).first();
    return c.json({ok:true, user_tl: row?.tl_balance || 0});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// 내 파일별 TL 잔량 조회
app.get('/api/user/file-tl', async (c) => {
  try {
    const user_id = c.req.query('user_id');
    if(!user_id) return c.json({error:'user_id required'},400);
    const result = await c.env.DB.prepare('SELECT share_id, tl_balance, total_charged, total_consumed FROM tl_user_files WHERE user_id=? AND tl_balance>0').bind(user_id).all();
    return c.json({files: result.results || []});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// 유저-파일 TL 충전 (1:1)

// 유저-파일 TL 소비 (재생 시)

// 내 파일별 TL 잔량 조회
app.get('/api/user/file-tl', async (c) => {
  try {
    const user_id = c.req.query('user_id');
    if(!user_id) return c.json({error:'user_id required'},400);
    const result = await c.env.DB.prepare('SELECT share_id, tl_balance, total_charged, total_consumed FROM tl_user_files WHERE user_id=? AND tl_balance>0').bind(user_id).all();
    return c.json({files: result.results || []});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// ── 활동 보고: TL소비 + POC 누적 → 기여지수 갱신 ──────────
// ── 구버전 호환: /api/eco/activity 로 리다이렉트 ──
app.post('/api/user/activity_legacy', async (c) => {
  try {
    const { user_id, mode, seconds, tl_spent, poc_gained, poc_total,
            share_id, tl_mode } = await c.req.json();

    // 1. TL 소비량 DB 반영
    if(tl_spent > 0){
      if(tl_mode === 'file' && share_id){
        // 곡별 충전 TL 차감 (tl_user_files)
        await c.env.DB.prepare(
          'UPDATE tl_user_files SET tl_balance=MAX(0,tl_balance-?), total_consumed=total_consumed+? WHERE user_id=? AND share_id=?'
        ).bind(tl_spent, tl_spent, user_id, share_id).run();

        // 크리에이터 수익 분배 (plan A=70%, B=50%)
        const shareRow = await c.env.DB.prepare(
          'SELECT user_id as creator_id, plan FROM tl_shares WHERE id=?'
        ).bind(share_id).first();
        if(shareRow){
          // 신 배분율: 플랜A 62%, 플랜B 45%
          const ratio = shareRow.plan === 'B' ? 0.45 : 0.62;
          const creatorEarn = Math.floor(tl_spent * ratio);
          if(creatorEarn > 0){
            await c.env.DB.prepare(
              'UPDATE users SET tl=tl+?, total_tl_earned=total_tl_earned+? WHERE id=?'
            ).bind(creatorEarn, creatorEarn, shareRow.creator_id).run();
            // pulse 증가
            await c.env.DB.prepare(
              'UPDATE tl_shares SET pulse=pulse+1 WHERE id=?'
            ).bind(share_id).run();
          }
        }

        // 유저 total_tl_spent 기록
        await c.env.DB.prepare(
          'UPDATE users SET total_tl_spent=total_tl_spent+? WHERE id=?'
        ).bind(tl_spent, user_id).run();

        // 잔여 file_tl 반환용
        const fileTlRow = await c.env.DB.prepare(
          'SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?'
        ).bind(user_id, share_id).first();
        var fileTlRemain = Number(fileTlRow?.tl_balance || 0);

      } else {
        // 총량 차감 (users.tl)
        await c.env.DB.prepare(
          'UPDATE users SET tl=MAX(0,tl-?), total_tl_spent=total_tl_spent+? WHERE id=?'
        ).bind(tl_spent, tl_spent, user_id).run();
      }
    }

    // 2. POC 누적 기록 (라디오 청취 = 기여 활동)
    // tl_mode: 'file'(채널방송-곡별차감) | 'total'(중앙방송-총량차감) → 둘 다 기여 점수 적립
    if(seconds > 0 || poc_gained > 0){
      await c.env.DB.prepare(`
        INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).bind(user_id, mode||'cafe', seconds||0, tl_spent||0, poc_gained||0).run();
    }

    // 3. 기여지수 재계산 (신 알고리즘: 4요소 가중합, 상한 5.0)
    const monthStart = new Date().toISOString().slice(0,7)+'-01';
    const mStats = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN mode='consume' THEN tl_spent ELSE 0 END),0) as monthly_tl_p,
              COALESCE(SUM(seconds),0) as total_sec
       FROM poc_logs WHERE user_id=? AND created_at>=?`
    ).bind(user_id, monthStart).first() as any;
    const mPlays = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM poc_logs WHERE user_id=? AND mode='listen' AND created_at>=?"
    ).bind(user_id, monthStart).first() as any;
    const mUploads = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM tl_shares WHERE user_id=? AND created_at>=?"
    ).bind(user_id, monthStart+' 00:00:00').first().catch(()=>({cnt:0})) as any;

    const mTlP   = Number(mStats?.monthly_tl_p||0);
    const mHours = Number(mStats?.total_sec||0)/3600;
    const mPlaysN= Number(mPlays?.cnt||0);
    const mUplN  = Number(mUploads?.cnt||0);

    const cScore = Math.min(2.0, mPlaysN/500);
    const sScore = Math.min(1.5, mTlP/5000);
    const lScore = Math.min(1.0, mHours/30);
    const uScore = Math.min(0.5, mUplN/5);
    const pocIndex = Math.min(5.0, Math.max(0.1,
      (cScore*0.4+sScore*0.3+lScore*0.2+uScore*0.1)*10
    ));

    await c.env.DB.prepare(
      'UPDATE users SET poc_index=? WHERE id=?'
    ).bind(pocIndex, user_id).run();

    // 4. TLC 채굴량 계산
    const userRow = await c.env.DB.prepare(
      'SELECT total_tl_spent, total_tl_exchanged FROM users WHERE id=?'
    ).bind(user_id).first();
    const spent = Number(userRow?.total_tl_spent || 0);
    const exchanged = Number(userRow?.total_tl_exchanged || 0);
    // TLC 채굴 가능량: TL_P 기반만, 0.08 × POC × 배율 (월 30% 하드캡)
    const mineMultiplier = 1.0; // 플랜B는 /api/eco/mine-tlc에서 처리
    const mineableTlc = Math.min(
      mTlP * 0.30,
      (mTlP / 30) * 0.08 * pocIndex * mineMultiplier
    );

    return c.json({
      ok: true,
      poc_index: pocIndex,
      total_poc: totalPoc,
      total_tl_spent: spent,
      mineable_tlc: mineableTlc,
      file_tl: typeof fileTlRemain !== 'undefined' ? fileTlRemain : undefined
    });
  } catch(e: any){ return c.json({error: e.message}, 500); }
});

// ── TLC 채굴 확정 ────────────────────────────────────────────
app.post('/api/user/mine-tlc', async (c) => {
  try {
    const { user_id, tlc_amount } = await c.req.json();
    if(!tlc_amount || tlc_amount <= 0) return c.json({error:'채굴량 없음'}, 400);

    // 이미 채굴된 TLC 중복 방지: 오늘 채굴 내역 확인
    const today = new Date().toISOString().slice(0,10);
    const already = await c.env.DB.prepare(
      "SELECT SUM(tlc_mined) as mined FROM tlc_mining_logs WHERE user_id=? AND DATE(created_at)=?"
    ).bind(user_id, today).first();
    const todayMined = Number(already?.mined || 0);

    // 최대 채굴 가능량 재계산
    const userRow = await c.env.DB.prepare(
      'SELECT total_tl_spent, total_tl_exchanged, poc_index, tlc FROM users WHERE id=?'
    ).bind(user_id).first();
    const spent = Number(userRow?.total_tl_spent || 0);
    const exchanged = Number(userRow?.total_tl_exchanged || 0);
    const pocIndex = Number(userRow?.poc_index || 1.0);
    const maxMineable = Math.max(0, (spent - exchanged) * 0.5 * pocIndex);
    const actualMine = Math.min(tlc_amount, maxMineable - todayMined);

    if(actualMine <= 0) return c.json({error:'오늘 채굴 한도 초과', mined: 0});

    // TLC 지급 + 로그
    await c.env.DB.prepare(
      'UPDATE users SET tlc=tlc+? WHERE id=?'
    ).bind(actualMine, user_id).run();
    await c.env.DB.prepare(
      'INSERT INTO tlc_mining_logs (user_id, tlc_mined, poc_index, created_at) VALUES (?,?,?,datetime("now"))'
    ).bind(user_id, actualMine, pocIndex).run();

    return c.json({ ok: true, mined: actualMine, tlc_total: Number(userRow?.tlc||0) + actualMine });
  } catch(e: any){ return c.json({error: e.message}, 500); }
});

// ── 차트 API ─────────────────────────────────────────────────────────────

// 음악/영상/문서 pulse 차트
app.get('/api/chart', async (c) => {
  try {
    const type = c.req.query('type') || 'music';   // music | video | doc | image | tl
    const genre = c.req.query('genre') || 'all';   // all | Kpop | Pop | Hiphop | RnB | Rock | Classic | Jazz | EDM | etc
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);

    let rows;

    if (type === 'tl') {
      // TL 충전 많은 순 (tl_user_files 집계)
      const res = await c.env.DB.prepare(`
        SELECT s.id, s.title, s.artist, s.album, s.category, s.file_type,
               s.duration, s.cover_url, s.pulse, s.file_tl,
               COALESCE(u.username, s.username, 'User') as username,
               COALESCE(SUM(uf.total_charged), 0) as total_tl_charged
        FROM tl_shares s
        LEFT JOIN users u ON CAST(s.user_id AS TEXT) = CAST(u.id AS TEXT)
        LEFT JOIN tl_user_files uf ON s.id = uf.share_id
        GROUP BY s.id
        ORDER BY total_tl_charged DESC, s.pulse DESC
        LIMIT ?
      `).bind(limit).all();
      rows = res.results;

    } else {
      // 타입별 필터 — UPPER()로 대소문자 무시
      let typeFilter = '';
      if (type === 'music') typeFilter = `AND (s.file_type LIKE 'audio/%' OR UPPER(s.category) IN ('MUSIC','K-POP','KPOP','POP','팝','HIPHOP','힙합','R&B','록','ROCK','클래식','CLASSIC','재즈','JAZZ','EDM','인디','INDIE'))`;
      else if (type === 'video') typeFilter = `AND (s.file_type LIKE 'video/%' OR UPPER(s.category) IN ('VIDEO','영상','뮤직비디오','MV','드라마','영화','예능'))`;
      else if (type === 'doc') typeFilter = `AND (s.file_type LIKE 'application/%' OR s.file_type LIKE 'text/%' OR UPPER(s.category) IN ('DOCUMENT','문서','전자책','EBOOK','강의','LECTURE'))`;
      else if (type === 'image') typeFilter = `AND (s.file_type LIKE 'image/%' OR UPPER(s.category) IN ('IMAGE','이미지','사진','ART','아트'))`;

      // 장르 필터 — UPPER 비교
      let genreFilter = '';
      if (genre !== 'all') genreFilter = `AND UPPER(s.category) = UPPER('${genre.replace(/'/g,"''")}')`;

      const res = await c.env.DB.prepare(`
        SELECT s.id, s.title, s.artist, s.album, s.category, s.file_type,
               s.duration, s.cover_url, s.pulse, s.file_tl,
               COALESCE(u.username, s.username, 'User') as username,
               COALESCE(SUM(uf.total_charged), 0) as total_tl_charged
        FROM tl_shares s
        LEFT JOIN users u ON CAST(s.user_id AS TEXT) = CAST(u.id AS TEXT)
        LEFT JOIN tl_user_files uf ON s.id = uf.share_id
        WHERE 1=1 ${typeFilter} ${genreFilter}
        GROUP BY s.id
        ORDER BY s.pulse DESC, total_tl_charged DESC
        LIMIT ?
      `).bind(limit).all();
      rows = res.results;
    }

    return c.json({ ok: true, chart: rows || [] });
  } catch(e: any) { return c.json({ error: e.message }, 500); }
});

export default app;













