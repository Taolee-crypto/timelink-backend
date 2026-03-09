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

// CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

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

// ── 기존 Routes ───────────────────────────────────────────
app.route('/api/v1/auth', authRouter);
app.route('/api/v1/users', usersRouter);
app.route('/api/v1/files', filesRouter);
app.route('/api/v1/playback', playbackRouter);
app.route('/api/v1/shareplace', shareplaceRouter);
app.route('/api/v1/disputes', disputesRouter);
app.route('/api/v1/charts', chartsRouter);

// ── Public endpoints ──────────────────────────────────────

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
app.post('/api/upload', async (c) => {
  if (!c.env.R2) return c.json({ error: 'R2 미설정' }, 500);
  try {
    const formData = await c.req.parseBody();
    const file = formData['file'] as File;
    const trackId = formData['trackId'] as string;
    if (!file || !trackId) return c.json({ error: 'file, trackId 필수' }, 400);
    if (file.size > 500 * 1024 * 1024) return c.json({ error: '500MB 초과' }, 400);

    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const key = `tracks/${trackId}.${ext}`;

    await c.env.R2.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { trackId, uploadedAt: Date.now().toString() }
    });

    const publicUrl = `https://pub-c8d04f598d434d2f9568c08938d892a7.r2.dev/${key}`;
    return c.json({ ok: true, url: publicUrl, key });
  } catch(e: any) {
    return c.json({ error: e.message }, 500);
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
      id: t.id,
      title: t.name,
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

// ── SharePlace API (/api/shares) ──────────────────────────

// JWT / fallback 토큰 파싱 헬퍼
// 지원 형식:
//   JWT:      xxxxx.yyyyy.zzzzz
//   fallback: fallback_{userId}_{timestamp}
//   local:    local_{timestamp}  → body의 user_id 사용
//   token:    token_{userId}_{timestamp}
function parseJWT(token: string): { userId: number; username: string } {
  // 1) JWT 형식
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
  // 2) fallback_{userId}_{ts} 또는 token_{userId}_{ts}
  const m = token.match(/(?:fallback|token)_(\d+)/);
  if (m) return { userId: Number(m[1]), username: 'User' };
  // 3) local_{ts} — userId를 body에서 받아야 함
  if (token.startsWith('local_')) return { userId: 0, username: 'User' };
  throw new Error('Unknown token format: ' + token.slice(0, 20));
}

// GET /api/shares — 인증 불필요
app.get('/api/shares', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM tl_shares ORDER BY created_at DESC LIMIT 100'
    ).all();
    return c.json({ shares: results || [] });
  } catch (e: any) {
    return c.json({ shares: [], _note: e.message });
  }
});

// POST /api/shares — 인증 필요, 5000 TL 차감
app.post('/api/shares', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  let userId: number, username: string;
  try {
    const p = parseJWT(auth);
    userId = p.userId; username = p.username;
  } catch (e) { return c.json({ error: 'Invalid token: ' + (e as Error).message }, 401); }

  // body에서 user_id/username 보충 (fallback/local 토큰 대응)
  const bodyRaw = await c.req.json<any>();
  if (!userId || userId === 0) {
    userId = Number(bodyRaw.user_id || bodyRaw.userId || 0);
    username = bodyRaw.username || username || 'User';
  }
  if (!userId) return c.json({ error: 'user_id 확인 불가' }, 401);

  // TL 잔액 확인 (tl 또는 tl_balance 컬럼 모두 시도)
  // fallback 토큰은 id가 timestamp이므로 email로도 검색
  const userRow = await c.env.DB.prepare('SELECT * FROM users WHERE id=? OR email=?')
    .bind(userId, bodyRaw.email || '').first<any>().catch(() => null);
  if (!userRow) return c.json({ error: '유저 없음' }, 404);

  const tl = userRow.tl ?? userRow.tl_balance ?? 0;
  if (tl < 5000) return c.json({ error: 'TL 부족', required: 5000, current: tl }, 402);

  const body = bodyRaw;
  if (!body.title) return c.json({ error: 'title 필요' }, 400);

  // tl_shares 테이블 자동 생성
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

  // TL 차감 — userRow.id 사용 (fallback token의 userId는 타임스탬프로 DB id와 다를 수 있음)
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

// DELETE /api/shares/:id
app.delete('/api/shares/:id', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);
  let userId: number;
  try { userId = parseJWT(auth).userId; } catch (e) { return c.json({ error: 'Invalid token' }, 401); }
  await c.env.DB.prepare('DELETE FROM tl_shares WHERE id=? AND user_id=?')
    .bind(c.req.param('id'), String(userId)).run().catch(() => {});
  return c.json({ ok: true });
});

// POST /api/shares/:id/pulse
app.post('/api/shares/:id/pulse', async (c) => {
  try {
    await c.env.DB.prepare('UPDATE tl_shares SET pulse=pulse+1 WHERE id=?').bind(c.req.param('id')).run();
    const row = await c.env.DB.prepare('SELECT pulse FROM tl_shares WHERE id=?')
      .bind(c.req.param('id')).first<{ pulse: number }>();
    return c.json({ ok: true, pulse: row?.pulse || 0 });
  } catch (e) { return c.json({ ok: true, pulse: 0 }); }
});

// POST /api/shares/:id/consume — 재생 중 초당 TL 차감
app.post('/api/shares/:id/consume', async (c) => {
  try {
    const body = await c.req.json<any>();
    const seconds = Number(body.seconds || 1);
    const cost = seconds; // 1초 = 1TL

    // file_tl 차감
    await c.env.DB.prepare(
      'UPDATE tl_shares SET file_tl=MAX(0, file_tl-?), pulse=pulse+? WHERE id=?'
    ).bind(cost, seconds, c.req.param('id')).run();

    const row = await c.env.DB.prepare('SELECT file_tl, pulse FROM tl_shares WHERE id=?')
      .bind(c.req.param('id')).first<any>();
    return c.json({ ok: true, file_tl: row?.file_tl || 0, pulse: row?.pulse || 0 });
  } catch(e: any) { return c.json({ ok: false, error: e.message }, 500); }
});

// POST /api/shares/:id/charge — 리스너 TL 충전
app.post('/api/shares/:id/charge', async (c) => {
  try {
    const body = await c.req.json<any>();
    const amount = Number(body.amount || 0);
    const email  = body.email || '';
    if (amount <= 0) return c.json({ error: 'amount 필요' }, 400);

    // 충전자 TL 차감 (email 기반)
    if (email) {
      const u = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first<any>().catch(()=>null);
      if (u) {
        const col = u.tl !== undefined ? 'tl' : 'tl_balance';
        if ((u[col]||0) < amount) return c.json({ error: 'TL 부족', current: u[col]||0 }, 402);
        await c.env.DB.prepare(`UPDATE users SET ${col}=${col}-? WHERE email=?`).bind(amount, email).run();
      }
    }

    // tl_shares file_tl 증가 + pulse +1
    await c.env.DB.prepare(
      'UPDATE tl_shares SET file_tl=file_tl+?, pulse=pulse+1 WHERE id=?'
    ).bind(amount, c.req.param('id')).run();

    const row = await c.env.DB.prepare('SELECT file_tl, pulse FROM tl_shares WHERE id=?')
      .bind(c.req.param('id')).first<any>();
    return c.json({ ok: true, file_tl: row?.file_tl||0, pulse: row?.pulse||0 });
  } catch(e: any) { return c.json({ ok: false, error: e.message }, 500); }
});

// ─────────────────────────────────────────────────────────
app.notFound((c) => c.json({ detail: 'Not found' }, 404));

export default app;
