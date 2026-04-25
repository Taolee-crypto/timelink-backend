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
import adsRouter from './ads_backend';
import { mintTLC, getJettonBalance } from './jetton';
import sunoVerifyRouter from './routes/suno-verify';


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
app.route('/api/ads', adsRouter);
app.route('/api/v1/suno', sunoVerifyRouter);

// ── 유저 전체 정보 SELECT 헬퍼 (로그인/회원가입 공통) ──
const USER_SELECT = `
  SELECT id, email, username,
    COALESCE(tl, 0) as tl,
    COALESCE(tl_p, tl, 0) as tl_p,
    COALESCE(tl_a, 0) as tl_a,
    COALESCE(tl_b, 0) as tl_b,
    COALESCE(tlc_balance, tlc, 0) as tlc,
    COALESCE(poc_index, 1.0) as poc_index,
    COALESCE(total_tl_spent, 0) as total_tl_spent,
    COALESCE(total_tl_exchanged, 0) as total_tl_exchanged,
    created_at
  FROM users
`;

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

// POST /api/upload (R2 Multipart)
app.post('/api/upload', async (c) => {
  if (!c.env.R2) {
    return c.json({ ok: false, error: 'R2 바인딩 없음 — wrangler.toml [[r2_buckets]] 확인' }, 500);
  }
  try {
    const formData = await c.req.parseBody({ limit: 500 * 1024 * 1024 });
    const file = formData['file'] as File;
    const trackId = formData['trackId'] as string;
    if (!file || !trackId) return c.json({ ok: false, error: 'file, trackId 필수' }, 400);
    const MAX_SIZE = 500 * 1024 * 1024;
    if (file.size > MAX_SIZE) return c.json({ ok: false, error: `파일이 너무 큽니다 (최대 500MB)` }, 400);
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const key = `tracks/${trackId}.${ext}`;
    const contentType = file.type || 'application/octet-stream';
    const CHUNK = 50 * 1024 * 1024;
    if (file.size <= CHUNK) {
      const buffer = await file.arrayBuffer();
      await c.env.R2.put(key, buffer, {
        httpMetadata: { contentType },
        customMetadata: { originalName: file.name, trackId, uploadedAt: Date.now().toString() },
      });
    } else {
      const upload = await c.env.R2.createMultipartUpload(key, {
        httpMetadata: { contentType },
        customMetadata: { originalName: file.name, trackId, uploadedAt: Date.now().toString() },
      });
      try {
        const parts: any[] = [];
        const buffer = await file.arrayBuffer();
        const total = buffer.byteLength;
        let offset = 0, partNum = 1;
        while (offset < total) {
          const end = Math.min(offset + CHUNK, total);
          const chunk = buffer.slice(offset, end);
          const part = await upload.uploadPart(partNum, chunk);
          parts.push(part);
          offset = end; partNum++;
        }
        await upload.complete(parts);
      } catch (uploadErr: any) {
        await upload.abort().catch(() => {});
        throw uploadErr;
      }
    }
    const publicUrl = `https://pub-c8d04f598d434d2f9568c08938d892a7.r2.dev/${key}`;
    return c.json({ ok: true, url: publicUrl, key, size: file.size });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Spotify 검색
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

// Spotify Audio Features (BPM, energy, valence 등)
app.get('/api/spotify/audio-features/:trackId', async (c) => {
  const env = c.env as any;
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return c.json({ error: 'Spotify 키 없음' }, 400);
  try {
    const token = await getSpotifyToken(c.env);
    const trackId = c.req.param('trackId');
    const r = await fetch(
      'https://api.spotify.com/v1/audio-features/' + trackId,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const d: any = await r.json();
    return c.json({
      tempo: Math.round(d.tempo || 0),       // BPM
      energy: d.energy || 0,                  // 0~1 (신남 정도)
      valence: d.valence || 0,               // 0~1 (긍정적 정도)
      danceability: d.danceability || 0,     // 0~1 (댄서블)
      acousticness: d.acousticness || 0,     // 0~1 (어쿠스틱)
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Spotify 검색
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

// ── JWT / 토큰 파싱 ──
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

function parseTokenUserId(token: string): number {
  if (!token) return 0;
  const m = token.match(/(?:token|fallback)_(\d+)/);
  if (m) return Number(m[1]);
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    return Number(p.userId || p.id || p.sub || 0);
  } catch { return 0; }
}

// SharePlace API
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

// 🔥 POST /api/shares - 새 파일 공유 (직접 업로드한 파일 처리)
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
  if (!userRow) return c.json({ error: '유저 없음' }, 404);
  const tl = userRow.tl ?? userRow.tl_balance ?? 0;
  if (tl < 5000) return c.json({ error: 'TL 부족', required: 5000, current: tl }, 402);
  const body = bodyRaw;
  if (!body.title) return c.json({ error: 'title 필요' }, 400);
  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tl_shares (
      id TEXT PRIMARY KEY, user_id TEXT, username TEXT,
      title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '',
      duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0,
      category TEXT DEFAULT 'Music', file_type TEXT DEFAULT '', category_type TEXT DEFAULT '',
      description TEXT DEFAULT '', plan TEXT DEFAULT 'A',
      spotify_id TEXT, spotify_url TEXT, cover_url TEXT, preview_url TEXT,
      stream_url TEXT DEFAULT '', country TEXT DEFAULT 'KR', content_lang TEXT DEFAULT 'ko',
      pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    )
  `).run().catch(() => {});
  const tlColRaw = userRow.tl !== undefined ? 'tl' : 'tl_balance';
  const tlCol = ['tl','tl_balance'].includes(tlColRaw) ? tlColRaw : 'tl';
  const realId = userRow.id;
  await c.env.DB.prepare(`UPDATE users SET ${tlCol}=${tlCol}-5000 WHERE id=?`).bind(realId).run();
  const id = 'sh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  
  // 🔥 중요: file_tl을 body에서 받아서 저장 (기본값 5000)
  const fileTl = body.file_tl || 5000;
  
  await c.env.DB.prepare(`
    INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,category,file_type,category_type,description,plan,spotify_id,spotify_url,cover_url,preview_url,stream_url,country,content_lang,pulse,created_at,price_per_sec,composer,lyricist,lyrics) 
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)
  `).bind(
    id, String(realId), username, body.title, body.artist || '', body.album || '',
    body.duration || 0, fileTl, body.category || 'Music', body.file_type || '', body.category_type || '',
    body.description || '', body.plan || 'A', body.spotify_id || null, body.spotify_url || null,
    body.cover_url || null, body.preview_url || null, body.stream_url || null,
    body.country || 'KR', body.content_lang || 'ko', Date.now(), body.price_per_sec || 1.0,
    body.composer || '', body.lyricist || '', body.lyrics || ''
  ).run();
  
  // 🔥 중요: tl_user_files에 초기 레코드 생성 (직접 업로드한 파일 대응)
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO tl_user_files (user_id, share_id, tl_balance, total_charged, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(realId, id, fileTl, fileTl).run();
  
  const updated = await c.env.DB.prepare(`SELECT ${tlCol} as tl FROM users WHERE id=?`).bind(realId).first<{ tl: number }>();
  return c.json({ ok: true, id, tl_remaining: updated?.tl || 0 });
});

// ── 유저의 특정 곡 TL 잔액 조회 (수정: 없으면 초기값 생성) ──
app.get('/api/shares/:id/my-tl', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ tl_balance: 0 });
  const user_id = Number(m[1]);
  const share_id = c.req.param('id');
  
  let row = await c.env.DB.prepare(
    'SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?'
  ).bind(user_id, share_id).first() as any;
  
  // 🔥 중요: tl_user_files에 레코드가 없으면 생성 (직접 업로드한 파일 대응)
  if (!row) {
    const share = await c.env.DB.prepare('SELECT file_tl FROM tl_shares WHERE id=?').bind(share_id).first() as any;
    const initialTL = share?.file_tl || 5000;
    
    await c.env.DB.prepare(`
      INSERT INTO tl_user_files (user_id, share_id, tl_balance, total_charged, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).bind(user_id, share_id, initialTL, initialTL).run();
    
    row = { tl_balance: initialTL };
  }
  
  return c.json({ tl_balance: Number(row?.tl_balance||0) });
});

// ── 단일 share 조회 ──
app.get('/api/shares/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT * FROM tl_shares WHERE id=?'
  ).bind(id).first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
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

// 회원가입 (register)
app.post('/api/auth/register', async (c) => {
  try {
    const { email, password, username, business_name: businessName, biz_reg_num: bizRegNum, is_advertiser: isAdvertiser } = await c.req.json();
    if (!email || !password || !username) return c.json({ error: '필수 항목 누락' }, 400);
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (exists) return c.json({ error: '이미 가입된 이메일입니다' }, 409);
    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    await c.env.DB.prepare(
      'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at) VALUES (?,?,?,10000,10000,0,?)'
    ).bind(email, username, password, now).run();
    const user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    const token = 'token_' + (user as any).id + '_' + Date.now();
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
    const check = await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND password_hash=?').bind(email, password).first();
    if (!check) return c.json({ error: '이메일 또는 비밀번호가 틀렸습니다' }, 401);
    const user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    const token = 'token_' + (user as any).id + '_' + Date.now();
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
    const { email, password, username, business_name: businessName, biz_reg_num: bizRegNum, is_advertiser: isAdvertiser } = await c.req.json();
    if (!email || !username) return c.json({ error: '필수 항목 누락' }, 400);
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (exists) return c.json({ error: '이미 가입된 이메일입니다. 로그인을 이용해 주세요.' }, 409);
    const nameExists = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first();
    if (nameExists) return c.json({ error: '이미 사용 중인 닉네임입니다.' }, 409);
    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    await c.env.DB.prepare(
      'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at, is_advertiser, biz_reg_num, business_name) VALUES (?,?,?,10000,10000,0,?,?,?,?)'
    ).bind(email, username, password||'', now, isAdvertiser?1:0, bizRegNum||'', businessName||username).run();
    const user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    const token = 'token_' + (user as any).id + '_' + Date.now();
    return c.json({ ok: true, token, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 오디오 프록시
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

// ══════════════════════════════════════════════════════════
//  TL 파일 보호 스트리밍
// ══════════════════════════════════════════════════════════
var API_STREAM_BASE = 'https://api.timelink.digital/api/stream/';

app.get('/api/stream/:shareId/info', async (c) => {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  const shareId = c.req.param('shareId');
  try {
    const share = await c.env.DB.prepare(
      'SELECT id, title, artist, duration, file_tl, stream_url, plan FROM tl_shares WHERE id=?'
    ).bind(shareId).first() as any;
    if (!share) return c.json({ error: '파일 없음' }, 404);
    const user = userId
      ? await c.env.DB.prepare(
          'SELECT tl, COALESCE(tl_p,tl,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=?'
        ).bind(userId).first() as any
      : null;
    const totalTL = user ? (Number(user.tl_p||0) + Number(user.tl_a||0) + Number(user.tl_b||0)) : 0;
    return c.json({
      share: { id: share.id, title: share.title, artist: share.artist, duration: share.duration },
      tl: { total: totalTL, tl_p: user?.tl_p||0, tl_a: user?.tl_a||0, tl_b: user?.tl_b||0 },
      can_play: totalTL > 0 || !userId,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.options('/api/stream/:shareId', async (c) => new Response(null, {
  status: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
  },
}));

app.get('/api/stream/:shareId', async (c) => {
  const authHeader = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const tkQuery = c.req.query('tk') || '';
  const token = authHeader || tkQuery;
  const userId = parseTokenUserId(token);
  const shareId = c.req.param('shareId');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, X-TL-Balance',
    'Accept-Ranges': 'bytes',
  };
  const rangeHdr = c.req.header('Range') || '';
  const rangeStart = rangeHdr ? parseInt((rangeHdr.match(/bytes=(\d+)-/) || [])[1] || '0') : 0;
  try {
    const share = await c.env.DB.prepare(
      'SELECT id, stream_url FROM tl_shares WHERE id=?'
    ).bind(shareId).first() as any;
    if (!share) return new Response(JSON.stringify({ error: '파일 없음' }), { status: 404, headers: cors });
    let totalTL = 999;
    if (rangeStart === 0 && userId) {
      const user = await c.env.DB.prepare('SELECT COALESCE(tl,0) as tl FROM users WHERE id=?').bind(userId).first() as any;
      totalTL = Number(user?.tl || 0);
      if (totalTL <= 0) {
        return new Response(JSON.stringify({ error: 'TL 잔액 부족', code: 'TL_INSUFFICIENT', tl_balance: 0 }), {
          status: 402,
          headers: { ...cors, 'Content-Type': 'application/json', 'X-TL-Balance': '0' },
        });
      }
    }
    const streamUrl = share.stream_url || '';
    let key = '';
    if (streamUrl.includes('r2.dev/')) {
      key = decodeURIComponent(streamUrl.split('r2.dev/')[1].split('?')[0]);
    } else if (streamUrl.startsWith('tracks/') || streamUrl.startsWith('tl/')) {
      key = streamUrl;
    } else if (streamUrl.startsWith('http')) {
      const fn = streamUrl.split('/').pop()?.split('?')[0] || '';
      key = fn.endsWith('.tl') ? 'tl/' + fn : 'tracks/' + fn;
    } else if (streamUrl) {
      key = streamUrl;
    }
    if (!key) return new Response(JSON.stringify({ error: '스트림 없음' }), { status: 404, headers: cors });
    let r2key = key;
    const meta = await c.env.R2.head(key);
    if (!meta) {
      const altKey = key.startsWith('tracks/') ? key.slice(7) : 'tracks/' + key;
      const altMeta = await c.env.R2.head(altKey);
      if (!altMeta) return new Response(JSON.stringify({ error: 'R2 파일 없음', key }), { status: 404, headers: cors });
      r2key = altKey;
    }
    const r2meta = await c.env.R2.head(r2key);
    const contentType = r2meta?.httpMetadata?.contentType || 'audio/mpeg';
    const total2 = r2meta?.size || 0;
    const rangeHeader = c.req.header('Range');
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!m) return new Response('Invalid Range', { status: 416, headers: cors });
      const start = parseInt(m[1]);
      const CHUNK_2MB = 2 * 1024 * 1024;
      const end = m[2] !== '' ? Math.min(parseInt(m[2]), total2 - 1) : Math.min(start + CHUNK_2MB - 1, total2 - 1);
      const length = end - start + 1;
      const obj = await c.env.R2.get(r2key, { range: { offset: start, length } });
      if (!obj) return new Response(JSON.stringify({ error: '읽기 실패' }), { status: 500, headers: cors });
      return new Response(obj.body, {
        status: 206,
        headers: { ...cors, 'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${total2}`,
          'Content-Length': String(length),
          'X-TL-Balance': String(totalTL),
          'Cache-Control': 'no-store',
        },
      });
    }
    const obj = await c.env.R2.get(r2key);
    if (!obj) return new Response(JSON.stringify({ error: '읽기 실패' }), { status: 500, headers: cors });
    return new Response(obj.body, {
      status: 200,
      headers: { ...cors, 'Content-Type': contentType,
        'Content-Length': String(total2),
        'X-TL-Balance': String(totalTL),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
});

// TL 차감 tick
app.post('/api/stream/:shareId/tick', async (c) => {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  const shareId = c.req.param('shareId');
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  try {
    const body = await c.req.json() as any;
    const seconds = Math.min(Number(body.seconds || 5), 30);
    const deductRate = Number(body.deduct_rate || 1.0);
    const cost = Math.ceil(seconds * deductRate);
    const user = await c.env.DB.prepare(
      'SELECT id, COALESCE(tl,0) as tl, COALESCE(tl_p,tl,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=?'
    ).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);
    const totalTL = Number(user.tl_p||0) + Number(user.tl_a||0) + Number(user.tl_b||0);
    if (totalTL <= 0) return c.json({ ok: false, code: 'TL_EMPTY', tl_balance: 0 }, 402);
    let remaining = cost;
    let new_a = Number(user.tl_a||0), new_b = Number(user.tl_b||0), new_p = Number(user.tl_p||0);
    if (remaining > 0 && new_a > 0) { const d = Math.min(remaining, new_a); new_a -= d; remaining -= d; }
    if (remaining > 0 && new_b > 0) { const d = Math.min(remaining, new_b); new_b -= d; remaining -= d; }
    if (remaining > 0 && new_p > 0) { const d = Math.min(remaining, new_p); new_p -= d; remaining -= d; }
    const newTotal = new_a + new_b + new_p;
    const userUpdate = c.env.DB.prepare(
      'UPDATE users SET tl=?, tl_p=?, tl_a=?, tl_b=?, total_tl_spent=COALESCE(total_tl_spent,0)+? WHERE id=?'
    ).bind(newTotal, new_p, new_a, new_b, cost, userId).run();
    const pulseUpdate = c.env.DB.prepare(
      'UPDATE tl_shares SET pulse=COALESCE(pulse,0)+? WHERE id=?'
    ).bind(seconds, shareId).run().catch(() => {});
    await Promise.all([userUpdate, pulseUpdate]);
    return c.json({ ok: true, tl_balance: newTotal, tl_p: new_p, tl_a: new_a, tl_b: new_b, cost });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ══════════════════════════════════════════════════════════
//  .tl 파일 암호화
// ══════════════════════════════════════════════════════════
function getTLExtAndFolder(fileType: string): { ext: string; folder: string } {
  if (fileType.startsWith('audio/'))       return { ext: 'tl3', folder: 'tl3' };
  if (fileType.startsWith('video/'))       return { ext: 'tl4', folder: 'tl4' };
  if (fileType.startsWith('image/'))       return { ext: 'tlg', folder: 'tlg' };
  if (fileType === 'application/pdf')      return { ext: 'tlf', folder: 'tlf' };
  return { ext: 'tl3', folder: 'tl3' };
}

function makeTLKey(shareId: string, secret: string): Uint8Array {
  const seed = shareId + secret + 'TIMELINK_v1';
  const key = new Uint8Array(256);
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    h ^= (Math.imul(i, 0x9e3779b9)) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 0x01000193)) >>> 0;
    key[i] = h & 0xff;
  }
  return key;
}
function xorData(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return out;
}
function buildTLFile(header: Record<string,any>, rawData: Uint8Array, secret: string): Uint8Array {
  const magic    = new Uint8Array([0x54,0x4C,0x4E,0x4B]);
  const version  = new Uint8Array([0x00,0x01]);
  const hdrBytes = new TextEncoder().encode(JSON.stringify(header));
  const hdrLen   = hdrBytes.length;
  const lenB     = new Uint8Array([hdrLen&0xff,(hdrLen>>8)&0xff,(hdrLen>>16)&0xff,(hdrLen>>24)&0xff]);
  const key      = makeTLKey(header.shareId as string, secret);
  const enc      = xorData(rawData, key);
  const out      = new Uint8Array(4+2+4+hdrLen+enc.length);
  let p=0; out.set(magic,p);p+=4; out.set(version,p);p+=2; out.set(lenB,p);p+=4;
  out.set(hdrBytes,p);p+=hdrLen; out.set(enc,p);
  return out;
}
async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

app.post('/api/upload/tl', async (c) => {
  if (!c.env.R2) return c.json({ ok:false, error:'R2 없음' }, 500);
  try {
    const formData = await c.req.parseBody({ limit: 200*1024*1024 });
    const file     = formData['file'] as File;
    const shareId  = (formData['shareId'] as string) || ('s_'+Date.now());
    const metaRaw  = formData['meta'] as string || '{}';
    const meta     = JSON.parse(metaRaw);
    if (!file) return c.json({ ok:false, error:'file 필요' }, 400);
    if (file.size > 200*1024*1024) return c.json({ ok:false, error:'200MB 초과' }, 400);
    const raw    = new Uint8Array(await file.arrayBuffer());
    const hash   = await sha256Hex(raw);
    const ext    = (file.name.split('.').pop() || 'bin').toLowerCase();
    const secret = (c.env as any).TL_SECRET || 'timelink_default_secret_2026';
    const tlPerSec  = Number(meta.tl_per_sec||1.0);
    const duration  = Number(meta.duration||0);
    const fileTL    = Math.ceil(duration * tlPerSec) || 3600;
    const xorKey    = shareId + secret + 'TIMELINK_v1';
    const header = {
      shareId, creatorId: Number(meta.creatorId||0), creatorName: String(meta.creatorName||''),
      title: String(meta.title||file.name.replace(/\.[^.]+$/, '')), artist: String(meta.artist||''),
      fileType: file.type || 'application/octet-stream', ext, duration,
      tl_per_sec: tlPerSec, plan: String(meta.plan||'A'),
      tl_balance: fileTL,
      tl_max: fileTL,
      xorKey,
      uploadedAt: new Date().toISOString(), contentHash: hash, platform: 'timelink.digital', version: 1,
    };
    const tlData = buildTLFile(header, raw, secret);
    const key    = `tl/${shareId}.tl`;
    await c.env.R2.put(key, tlData, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { shareId, title: header.title, ext, originalHash: hash },
    });
    return c.json({ ok:true, key, shareId, size: tlData.length, hash });
  } catch(e:any) { return c.json({ ok:false, error: e.message }, 500); }
});

app.get('/api/download/:shareId', async (c) => {
  const token   = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId  = parseTokenUserId(token);
  const shareId = c.req.param('shareId');
  if (!userId) return c.json({ error:'인증 필요' }, 401);
  try {
    const share = await c.env.DB.prepare('SELECT id,title,stream_url FROM tl_shares WHERE id=?').bind(shareId).first() as any;
    if (!share) return c.json({ error:'파일 없음' }, 404);
    const streamUrl = share.stream_url || '';
    let rawKey = '';
    if (streamUrl.includes('r2.dev/')) rawKey = streamUrl.split('r2.dev/')[1];
    else if (streamUrl.startsWith('tracks/')) rawKey = streamUrl;
    else { const fn=streamUrl.split('/').pop()?.split('?')[0]||''; rawKey='tracks/'+fn; }
    const rawObj = await c.env.R2.get(rawKey);
    if (!rawObj) return c.json({ error:'원본 파일 없음' }, 404);
    const raw    = new Uint8Array(await rawObj.arrayBuffer());
    const secret = (c.env as any).TL_SECRET || 'timelink_default_secret_2026';
    const ext    = rawKey.split('.').pop() || 'bin';
    const hash   = await sha256Hex(raw);
    const shareFull = await c.env.DB.prepare(
      'SELECT title, artist, duration, file_tl, plan FROM tl_shares WHERE id=?'
    ).bind(shareId).first() as any;
    const tlPerSec2  = Number(shareFull?.tl_per_sec || 1.0);
    const duration2  = Number(shareFull?.duration || 0);
    const xorKey2    = shareId + secret + 'TIMELINK_v1';

    const userFileTL = await c.env.DB.prepare(
      'SELECT tl_balance, total_charged FROM tl_user_files WHERE user_id=? AND share_id=?'
    ).bind(userId, shareId).first() as any;

    const fileTL2 = Number(userFileTL?.tl_balance ?? shareFull?.file_tl ?? 3600);
    const tlMax2  = Number(userFileTL?.total_charged ?? shareFull?.file_tl ?? fileTL2);

    const header = {
      shareId,
      userId,
      creatorId: 0, creatorName: shareFull?.artist||'',
      title: shareFull?.title||share.title||'', artist: shareFull?.artist||'',
      fileType: rawObj.httpMetadata?.contentType||'audio/mpeg', ext, duration: duration2,
      tl_per_sec: tlPerSec2, plan: shareFull?.plan||'A',
      tl_balance: fileTL2,
      tl_max: tlMax2,
      xorKey: xorKey2,
      uploadedAt: new Date().toISOString(), contentHash: hash,
      platform: 'timelink.digital', version: 1,
    };
    const tlData = buildTLFile(header, raw, secret);
    const title2 = encodeURIComponent((share.title||'file').replace(/[<>:"/\\|?*]/g,'_'));
    return new Response(tlData, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${title2}.tl"`,
        'Content-Length': String(tlData.length),
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});


// ── AI 윤리 검사 프록시 ──
app.post('/api/ethics/check', async (c) => {
  try {
    const { title, desc, url } = await c.req.json() as any;
    const secret = (c.env as any).ANTHROPIC_API_KEY || '';

    const prompt = '아래 광고를 검토해주세요. 명백히 불법(마약/아동착취/테러/보이스피싱)인 경우만 차단하고, 일반 상업 광고는 모두 통과시키세요.\n\n'
      + '광고 제목: ' + (title||'') + '\n'
      + (desc ? '광고 설명: ' + desc + '\n' : '')
      + (url  ? '연결 URL: ' + url + '\n' : '')
      + '\n반드시 JSON만 반환하세요:\n'
      + '{"pass":true,"score":85,"category":"통과","reason":"일반 상업 광고입니다.","suggestion":""}';

    if (!secret) {
      return c.json({ result: { pass: true, score: 85, category: '통과', reason: 'AI 검사 생략 (키 미설정)', suggestion: '' } });
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': secret,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: '당신은 광고 심의 AI입니다. 명백히 불법이거나 심각하게 유해한 광고만 차단하고, 일반 상업 광고는 모두 통과시킵니다. JSON만 반환하세요.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json() as any;
    const raw = data?.content?.[0]?.text || '{"pass":true,"score":80,"category":"통과","reason":"검사 완료","suggestion":""}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    return c.json({ result });
  } catch(e: any) {
    return c.json({ result: { pass: true, score: 75, category: '통과', reason: '검사 중 오류 — 수동 검토 예정', suggestion: '' } });
  }
});

app.options('/api/download/:shareId', async (c) => new Response(null,{status:204,headers:{
  'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS',
  'Access-Control-Allow-Headers':'Authorization',
}}));

app.post('/api/decrypt/:shareId', async (c) => {
  const token   = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId  = parseTokenUserId(token);
  const shareId = c.req.param('shareId');
  if (!userId) return c.json({ error:'인증 필요' }, 401);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  try {
    const user = await c.env.DB.prepare(
      'SELECT COALESCE(tl,0) as tl, COALESCE(tl_p,tl,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=?'
    ).bind(userId).first() as any;
    const totalTL = Number(user?.tl_p||0)+Number(user?.tl_a||0)+Number(user?.tl_b||0);
    if (!user || totalTL <= 0) {
      return new Response(JSON.stringify({ error:'TL 부족', code:'TL_INSUFFICIENT', tl:totalTL }), {
        status:402, headers:{...cors,'Content-Type':'application/json'}
      });
    }
    const tlKey = `tl/${shareId}.tl`;
    let tlObj = await c.env.R2.get(tlKey);
    if (!tlObj) {
      const share = await c.env.DB.prepare('SELECT stream_url, title, artist FROM tl_shares WHERE id=?').bind(shareId).first() as any;
      if (!share) return new Response(JSON.stringify({ error:'파일 없음' }), {status:404,headers:cors});
      const streamUrl = share.stream_url || '';
      let rawKey = '';
      if (streamUrl.includes('r2.dev/')) rawKey = decodeURIComponent(streamUrl.split('r2.dev/')[1].split('?')[0]);
      else if (streamUrl.startsWith('tracks/') || streamUrl.startsWith('tl/')) rawKey = decodeURIComponent(streamUrl.split('?')[0]);
      else if (streamUrl.startsWith('https://') || streamUrl.startsWith('http://')) {
        try { const u = new URL(streamUrl); rawKey = decodeURIComponent(u.pathname.replace(/^\//, '')); }
        catch { const fn = streamUrl.split('/').pop()?.split('?')[0] || ''; rawKey = 'tracks/' + fn; }
      } else { const fn = streamUrl.split('/').pop()?.split('?')[0] || ''; rawKey = fn ? 'tracks/' + fn : ''; }
      const rawObj = await c.env.R2.get(rawKey);
      if (!rawObj) return new Response(JSON.stringify({ error:'원본 파일 없음', rawKey }), {status:404,headers:cors});
      const raw = new Uint8Array(await rawObj.arrayBuffer());
      const rawExt = (rawKey.split('.').pop()||'').toLowerCase();
      const extMimeMap: Record<string,string> = {
        'mp3':'audio/mpeg','mp4':'video/mp4','wav':'audio/wav','ogg':'audio/ogg',
        'flac':'audio/flac','aac':'audio/aac','m4a':'audio/mp4','webm':'audio/webm',
        'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','gif':'image/gif',
        'pdf':'application/pdf','txt':'text/plain',
      };
      const contentType = rawObj.httpMetadata?.contentType || extMimeMap[rawExt] || 'audio/mpeg';
      return new Response(raw, {
        status: 200,
        headers: { ...cors, 'Content-Type': contentType, 'Content-Length': String(raw.length),
          'X-TL-Header': JSON.stringify({ title:share.title, artist:share.artist, duration:0 }),
          'Cache-Control': 'no-store',
        },
      });
    }
    const tlData   = new Uint8Array(await tlObj.arrayBuffer());
    const secret   = (c.env as any).TL_SECRET || 'timelink_default_secret_2026';
    if (tlData[0]!==0x54||tlData[1]!==0x4C||tlData[2]!==0x4E||tlData[3]!==0x4B) {
      return new Response(JSON.stringify({ error:'유효하지 않은 .tl 파일' }), {status:400,headers:cors});
    }
    const hdrLen = tlData[6]|(tlData[7]<<8)|(tlData[8]<<16)|(tlData[9]<<24);
    const hdrBytes = tlData.slice(10, 10+hdrLen);
    const header   = JSON.parse(new TextDecoder().decode(hdrBytes)) as Record<string,any>;
    const encData  = tlData.slice(10+hdrLen);
    const key      = makeTLKey(shareId, secret);
    const rawData  = xorData(encData, key);
    const actualHash = await sha256Hex(rawData);
    if (header.contentHash && header.contentHash !== actualHash) {
      return new Response(JSON.stringify({ error:'파일 무결성 오류' }), {status:422,headers:cors});
    }
    const contentType = (header.fileType as string) || 'audio/mpeg';
    return new Response(rawData, {
      status: 200,
      headers: { ...cors, 'Content-Type': contentType, 'Content-Length': String(rawData.length),
        'X-TL-Header': JSON.stringify({ title:header.title, artist:header.artist, duration:header.duration }),
        'Cache-Control': 'no-store',
      },
    });
  } catch(e:any) {
    return new Response(JSON.stringify({ error:e.message }), {status:500,headers:cors});
  }
});

app.options('/api/decrypt/:shareId', async (c) => new Response(null,{status:204,headers:{
  'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization',
}}));

// ── 카페 채널 ──
app.post('/api/cafe/channel', async (c) => {
  try {
    const { channel_id, name, owner_id, biz_no, owner_name, addr, addr_detail, description, playlist, schedules } = await c.req.json();
    if (!channel_id || !name || !owner_id) return c.json({ error: '필수 항목 누락' }, 400);
    const exists = await c.env.DB.prepare('SELECT id FROM cafe_channels WHERE channel_id=?').bind(channel_id).first();
    if (exists) return c.json({ error: '이미 사용 중인 채널 ID입니다' }, 409);
    const user = await c.env.DB.prepare('SELECT id, tl FROM users WHERE id=?').bind(owner_id).first();
    if (!user) return c.json({ error: '유저를 찾을 수 없습니다' }, 404);
    if ((user.tl as number) < 50000) return c.json({ error: 'TL 잔액 부족 (필요: 50,000 TL)' }, 402);
    await c.env.DB.prepare('UPDATE users SET tl=tl-50000 WHERE id=?').bind(owner_id).run();
    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    const expires = new Date(Date.now()+30*24*60*60*1000).toISOString().replace('T',' ').substring(0,19);
    await c.env.DB.prepare(
      'INSERT INTO cafe_channels (channel_id, name, owner_id, biz_no, owner_name, addr, addr_detail, description, playlist, schedules, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(channel_id, name, owner_id, biz_no||'', owner_name||'', addr||'', addr_detail||'', description||'', JSON.stringify(playlist||[]), JSON.stringify(schedules||[]), now, expires).run();
    const updated = await c.env.DB.prepare(USER_SELECT + ' WHERE id=?').bind(owner_id).first();
    return c.json({ ok: true, channel_id, expires_at: expires, user: updated });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.get('/api/cafe/channels', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT * FROM cafe_channels WHERE is_active=1 ORDER BY created_at DESC').all();
    return c.json({ channels: result.results || [] });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.get('/api/cafe/channel/:owner_id', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT * FROM cafe_channels WHERE owner_id=? AND is_active=1 ORDER BY created_at DESC').bind(c.req.param('owner_id')).all();
    return c.json({ channels: result.results || [] });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ── 인카 채널 ──
app.post('/api/incar/channel', async (c) => {
  try {
    const b = await c.req.json();
    const exp = new Date(Date.now()+30*24*60*60*1000).toISOString();
    await c.env.DB.prepare(
      'INSERT INTO incar_channels (channel_id,name,owner_id,owner_name,car_plate,car_type,drive_region,description,theme,playlist,schedules,poc_index_at_creation,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind((b as any).channel_id,(b as any).name,(b as any).owner_id,(b as any).owner_name,(b as any).car_plate||'',(b as any).car_type||'',(b as any).drive_region||'',(b as any).description||'',(b as any).theme||'city',(b as any).playlist||'[]',(b as any).schedules||'[]',(b as any).poc_index_at_creation||1.0,exp).run();
    return c.json({ok:true});
  } catch(e:any){ return c.json({error:e.message},500); }
});

app.get('/api/incar/channels', async (c) => {
  try {
    const r = await c.env.DB.prepare('SELECT * FROM incar_channels WHERE is_active=1 ORDER BY created_at DESC').all();
    return c.json({channels: r.results||[]});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// ── 워터마크 로그 ──
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

// ── 파일별 TL 충전/소비 ──
app.post('/api/shares/:id/charge', async (c) => {
  try {
    const share_id = c.req.param('id');
    const token2 = (c.req.header('Authorization')||'').replace('Bearer ','').trim();
    const tokenUserId2 = parseTokenUserId(token2);
    const body2 = await c.req.json() as any;
    const amount = body2.amount;
    const user_id = body2.user_id || tokenUserId2;
    if(!amount || amount <= 0) return c.json({error:'Invalid amount'}, 400);
    if(!user_id) return c.json({error:'user_id 확인 불가'}, 401);
    await c.env.DB.prepare('UPDATE users SET tl=tl-?, tl_p=MAX(0,COALESCE(tl_p,tl,0)-?) WHERE id=? AND tl>=?')
      .bind(amount, amount, user_id, amount).run();
    await c.env.DB.prepare(`INSERT INTO tl_user_files (user_id,share_id,tl_balance,total_charged)
      VALUES (?,?,?,?) ON CONFLICT(user_id,share_id) DO UPDATE SET
      tl_balance=tl_balance+excluded.tl_balance,
      total_charged=total_charged+excluded.total_charged,
      updated_at=datetime('now')`)
      .bind(user_id, share_id, amount, amount).run();
    await c.env.DB.prepare('UPDATE tl_shares SET pulse=pulse+1 WHERE id=?').bind(share_id).run();
    const row = await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?').bind(user_id, share_id).first();
    return c.json({ok:true, user_tl: (row as any)?.tl_balance || 0, new_balance: (row as any)?.tl_balance || 0});
  } catch(e:any){ return c.json({error:e.message},500); }
});

app.post('/api/shares/:id/consume', async (c) => {
  try {
    const share_id = c.req.param('id');
    const { seconds, user_id } = await c.req.json();
    if(!user_id) return c.json({error:'user_id required'},400);
    const consume = seconds || 5;
    await c.env.DB.prepare(`UPDATE tl_user_files SET
      tl_balance=MAX(0,tl_balance-?), total_consumed=total_consumed+?,
      last_played=datetime('now'), updated_at=datetime('now')
      WHERE user_id=? AND share_id=?`)
      .bind(consume, consume, user_id, share_id).run();
    const share = await c.env.DB.prepare('SELECT user_id,plan FROM tl_shares WHERE id=?').bind(share_id).first() as any;
    if(share){
      const rate = share.plan==='B' ? 0.45 : 0.62;
    const earn = Math.floor(consume * rate);
      if(earn>0) await c.env.DB.prepare('UPDATE users SET tl=tl+?, tl_p=COALESCE(tl_p,0)+?, total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?').bind(earn, earn, earn, share.user_id).run();
    }
    const row = await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?').bind(user_id, share_id).first();
    return c.json({ok:true, user_tl: (row as any)?.tl_balance || 0, new_balance: (row as any)?.tl_balance || 0});
  } catch(e:any){ return c.json({error:e.message},500); }
});

app.get('/api/user/file-tl', async (c) => {
  try {
    const user_id = c.req.query('user_id');
    if(!user_id) return c.json({error:'user_id required'},400);
    const result = await c.env.DB.prepare('SELECT share_id, tl_balance, total_charged, total_consumed FROM tl_user_files WHERE user_id=? AND tl_balance>0').bind(user_id).all();
    return c.json({files: result.results || []});
  } catch(e:any){ return c.json({error:e.message},500); }
});

// ── 활동 보고 ──
app.post('/api/user/activity', async (c) => {
  try {
    const { user_id, mode, seconds, tl_spent, poc_gained, poc_total,
            share_id, tl_mode } = await c.req.json();
    let fileTlRemain: number | undefined;
    if(tl_spent > 0){
      if(tl_mode === 'file' && share_id){
        await c.env.DB.prepare(
          'UPDATE tl_user_files SET tl_balance=MAX(0,tl_balance-?), total_consumed=total_consumed+? WHERE user_id=? AND share_id=?'
        ).bind(tl_spent, tl_spent, user_id, share_id).run();
        const shareRow = await c.env.DB.prepare('SELECT user_id as creator_id, plan FROM tl_shares WHERE id=?').bind(share_id).first() as any;
        if(shareRow){
          const ratio = shareRow.plan === 'B' ? 0.45 : 0.62;
         const creatorEarn = Math.floor(tl_spent * ratio);
          if(creatorEarn > 0){
            await c.env.DB.prepare('UPDATE users SET tl=tl+?, tl_p=COALESCE(tl_p,0)+?, total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?').bind(creatorEarn, creatorEarn, creatorEarn, shareRow.creator_id).run();
          }
        }
        await c.env.DB.prepare('UPDATE users SET total_tl_spent=total_tl_spent+? WHERE id=?').bind(tl_spent, user_id).run();
        const fileTlRow = await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?').bind(user_id, share_id).first() as any;
        fileTlRemain = Number(fileTlRow?.tl_balance || 0);
      } else {
        await c.env.DB.prepare('UPDATE users SET tl=MAX(0,tl-?), total_tl_spent=total_tl_spent+? WHERE id=?').bind(tl_spent, tl_spent, user_id).run();
      }
    }
    if(seconds > 0 || poc_gained > 0){
      await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS poc_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER, mode TEXT, seconds INTEGER DEFAULT 0,
        tl_spent REAL DEFAULT 0, poc_gained REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`).run().catch(()=>{});
      await c.env.DB.prepare('INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))').bind(user_id, mode||'cafe', seconds||0, tl_spent||0, poc_gained||0).run();
    }
    const userRow = await c.env.DB.prepare('SELECT total_tl_spent, total_tl_exchanged, poc_index FROM users WHERE id=?').bind(user_id).first() as any;
    const spent = Number(userRow?.total_tl_spent || 0);
    const exchanged = Number(userRow?.total_tl_exchanged || 0);
    const pocIndex = Number(userRow?.poc_index || 1.0);
    const mineableTlc = Math.max(0, (spent - exchanged) * 0.5 * pocIndex);
    return c.json({
      ok: true, poc_index: pocIndex, total_tl_spent: spent,
      mineable_tlc: mineableTlc, file_tl: fileTlRemain
    });
  } catch(e: any){ return c.json({error: e.message}, 500); }
});

// ── 유저 목록 ──
app.get('/api/users', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT u.id, u.email, u.username, u.tl, u.tl_balance, u.tlc_balance as tlc, u.created_at, COALESCE(u.is_advertiser,0) as is_advertiser, COALESCE(u.business_name,u.username) as business_name, (SELECT COUNT(*) FROM tl_shares s WHERE CAST(s.user_id AS TEXT)=CAST(u.id AS TEXT)) as share_count FROM users u ORDER BY u.id ASC'
    ).all();
    return c.json({ users: result.results || [] });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ── Admin SQL ──
const ADMIN_EMAILS = ['mununglee@gmail.com'];
const ADMIN_USER_IDS = [1, 2];

async function requireAdmin(c: any): Promise<{ ok: boolean; reason?: string }> {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, reason: '인증 토큰 없음' };
  const userId = parseTokenUserId(token);
  if (!userId) return { ok: false, reason: '유효하지 않은 토큰' };
  if (ADMIN_USER_IDS.includes(userId)) return { ok: true };
  try {
    const user = await c.env.DB.prepare('SELECT email FROM users WHERE id=?').bind(userId).first() as any;
    if (user && ADMIN_EMAILS.includes(user.email)) return { ok: true };
  } catch {}
  return { ok: false, reason: '관리자 권한 없음' };
}

app.post('/api/admin/sql', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    const body = await c.req.json() as any;
    const sql: string = (body.sql || body.query || '').trim();
    if (!sql) return c.json({ error: 'sql required' }, 400);
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run().catch(() => {});
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_ads (
      id TEXT PRIMARY KEY, advertiser_id INTEGER DEFAULT 0, business_name TEXT DEFAULT '',
      title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '', ad_type TEXT DEFAULT 'video',
      media_url TEXT DEFAULT '', thumbnail_url TEXT DEFAULT '', target_url TEXT DEFAULT '',
      tl_reward INTEGER DEFAULT 300, budget_tl INTEGER DEFAULT 10000, spent_tl INTEGER DEFAULT 0,
      daily_limit INTEGER DEFAULT 100, status TEXT DEFAULT 'active', start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '', views INTEGER DEFAULT 0, completions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(() => {});
    const upper = sql.toUpperCase();
    if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
      const result = await c.env.DB.prepare(sql).all();
      return c.json({ results: result.results || [], count: result.results?.length || 0 });
    } else {
      const result = await c.env.DB.prepare(sql).run();
      return c.json({ success: true, meta: result.meta });
    }
  } catch (e: any) {
    return c.json({ error: e.message, sql_hint: 'Check table/column names' }, 500);
  }
});

app.get('/api/admin/settings/:key', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run().catch(() => {});
    const row = await c.env.DB.prepare('SELECT value FROM tl_settings WHERE key=? LIMIT 1').bind(c.req.param('key')).first() as any;
    return c.json({ key: c.req.param('key'), value: row ? row.value : null });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post('/api/admin/settings/:key', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run().catch(() => {});
    const body = await c.req.json() as any;
    const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
    await c.env.DB.prepare(`INSERT INTO tl_settings (key,value,updated_at) VALUES (?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(c.req.param('key'), value).run();
    return c.json({ ok: true, key: c.req.param('key'), value });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.delete('/api/admin/settings/:key', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    await c.env.DB.prepare('DELETE FROM tl_settings WHERE key=?').bind(c.req.param('key')).run();
    return c.json({ ok: true, key: c.req.param('key'), deleted: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.get('/api/admin/revenue', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    const db = c.env.DB;
    await db.prepare(`CREATE TABLE IF NOT EXISTS tl_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, method TEXT NOT NULL,
      pg_id TEXT NOT NULL UNIQUE, merchant_uid TEXT, amount_krw INTEGER NOT NULL,
      tl_granted INTEGER NOT NULL, bonus_tl INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(()=>{});
    await db.prepare("ALTER TABLE tl_payments ADD COLUMN bonus_tl INTEGER DEFAULT 0").run().catch(()=>{});
    const payRow = await db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='success' THEN amount_krw ELSE 0 END),0) AS total_krw,
      COALESCE(SUM(CASE WHEN status='success' THEN tl_granted ELSE 0 END),0) AS total_tl_sold,
      COUNT(CASE WHEN status='success' THEN 1 END) AS pay_count,
      COALESCE(SUM(CASE WHEN status='success' AND created_at>=date('now','start of month') THEN amount_krw ELSE 0 END),0) AS month_krw,
      COALESCE(SUM(CASE WHEN status='success' AND created_at>=date('now','-7 days') THEN amount_krw ELSE 0 END),0) AS week_krw,
      COALESCE(SUM(CASE WHEN status='success' AND date(created_at)=date('now') THEN amount_krw ELSE 0 END),0) AS today_krw
      FROM tl_payments`).first() as any;
    const rewardRow = await db.prepare(`SELECT
      COALESCE(SUM(tl_a),0) AS total_tl_a_distributed,
      COALESCE(SUM(tl_p),0) AS total_tl_p_held,
      COALESCE(SUM(tl),0) AS total_tl_held,
      COALESCE(SUM(total_tl_spent),0) AS total_tl_consumed,
      COALESCE(SUM(total_tl_exchanged),0) AS total_tl_cash_requested,
      COUNT(*) AS user_count FROM users`).first() as any;
    const tlcRow = await db.prepare(`SELECT
      COALESCE(SUM(tlc_mined),0) AS total_tlc_mined,
      COUNT(DISTINCT user_id) AS miners_count,
      COALESCE(SUM(CASE WHEN created_at>=date('now','-30 days') THEN tlc_mined ELSE 0 END),0) AS month_tlc
      FROM tlc_mining_logs`).first() as any;
    const recentPays = await db.prepare(`SELECT p.*, u.email, u.username FROM tl_payments p
      LEFT JOIN users u ON CAST(p.user_id AS TEXT)=CAST(u.id AS TEXT)
      WHERE p.status='success' ORDER BY p.created_at DESC LIMIT 10`).all().catch(()=>({results:[]}));
    const dailyRevenue = await db.prepare(`SELECT date(created_at) as day, SUM(amount_krw) as krw, SUM(tl_granted) as tl, COUNT(*) as cnt
      FROM tl_payments WHERE status='success' AND created_at >= date('now','-30 days')
      GROUP BY date(created_at) ORDER BY day DESC`).all().catch(()=>({results:[]}));
    return c.json({ ok: true,
      revenue: {
        total_krw: Number(payRow?.total_krw||0), month_krw: Number(payRow?.month_krw||0),
        week_krw: Number(payRow?.week_krw||0), today_krw: Number(payRow?.today_krw||0),
        pay_count: Number(payRow?.pay_count||0), total_tl_sold: Number(payRow?.total_tl_sold||0),
        total_tl_consumed: Number(rewardRow?.total_tl_consumed||0),
        total_tl_p_held: Number(rewardRow?.total_tl_p_held||0),
        total_tlc_mined: Number(tlcRow?.total_tlc_mined||0),
        month_tlc: Number(tlcRow?.month_tlc||0), miners_count: Number(tlcRow?.miners_count||0),
        user_count: Number(rewardRow?.user_count||0),
      },
      recent_payments: recentPays.results || [], daily_revenue: dailyRevenue.results || [],
    });
  } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
});

// ── 지갑 잔액 조회 ──
app.get('/api/eco/wallet', async (c) => {
  const token = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'인증 필요' }, 401);
  try {
    const user = await c.env.DB.prepare(
      `SELECT tl, COALESCE(tl_p,tl,0) as tl_p, COALESCE(tl_a,0) as tl_a,
       COALESCE(tl_b,0) as tl_b, COALESCE(tlc_balance,0) as tlc,
       COALESCE(poc_index,1.0) as poc_index,
       COALESCE(total_tl_spent,0) as total_tl_spent,
       COALESCE(total_tl_exchanged,0) as total_tl_exchanged
       FROM users WHERE id=?`
    ).bind(userId).first() as any;
    if (!user) return c.json({ error:'유저없음' }, 404);
    const tl_p = Number(user.tl_p||user.tl||0);
    const tl_a = Number(user.tl_a||0);
    const tl_b = Number(user.tl_b||0);
    return c.json({ ok: true, tl: tl_p+tl_a+tl_b, tl_p, tl_a, tl_b,
      tlc: Number(user.tlc||0), poc_index: Number(user.poc_index||1.0),
      total_tl_spent: Number(user.total_tl_spent||0),
      total_tl_exchanged: Number(user.total_tl_exchanged||0),
    });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── POC 계산 ──
app.post('/api/eco/calc-poc', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);

    const playRow = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(seconds),0) as total_sec FROM poc_logs WHERE user_id=? AND mode='listen' AND created_at>=?"
    ).bind(userId, monthStart).first() as any;
    const creationRow = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(pulse),0) as plays FROM tl_shares WHERE user_id=? AND created_at>=?"
    ).bind(String(userId), monthStart).first() as any;
    const monthPlays = Number(creationRow?.plays || 0);
    const creationScore = Math.min(monthPlays / 500 * 2.0, 2.0);

    const spendRow = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(tl_spent),0) as spent FROM poc_logs WHERE user_id=? AND created_at>=?"
    ).bind(userId, monthStart).first() as any;
    const monthSpent = Number(spendRow?.spent || 0);
    const spendScore = Math.min(monthSpent / 5000 * 1.5, 1.5);

    const listenRow = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(seconds),0) as secs FROM poc_logs WHERE user_id=? AND created_at>=?"
    ).bind(userId, monthStart).first() as any;
    const monthSecs = Number(listenRow?.secs || 0);
    const listenScore = Math.min(monthSecs / 108000 * 1.0, 1.0);

    const uploadRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM tl_shares WHERE user_id=? AND created_at>=?"
    ).bind(String(userId), monthStart).first() as any;
    const monthUploads = Number(uploadRow?.cnt || 0);
    const uploadScore = Math.min(monthUploads / 5 * 0.5, 0.5);

    const pocIndex = Math.round(Math.min(
      creationScore + spendScore + listenScore + uploadScore, 5.0
    ) * 100) / 100;

    await c.env.DB.prepare('UPDATE users SET poc_index=? WHERE id=?').bind(pocIndex, userId).run();

    const mineableTlc = Math.floor(monthSpent * pocIndex * 0.1 * 100) / 100;

    return c.json({
      ok: true,
      poc_index: pocIndex,
      breakdown: {
        creation: { score: Math.round(creationScore*100)/100, plays: monthPlays, max: 2.0, weight: '40%' },
        spending: { score: Math.round(spendScore*100)/100, tl_spent: monthSpent, max: 1.5, weight: '30%' },
        listening: { score: Math.round(listenScore*100)/100, hours: Math.round(monthSecs/360)/10, max: 1.0, weight: '20%' },
        upload: { score: Math.round(uploadScore*100)/100, count: monthUploads, max: 0.5, weight: '10%' },
      },
      mineable_tlc: mineableTlc,
    });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── TLC 채굴 ──
app.post('/api/eco/mine', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const user = await c.env.DB.prepare(
      `SELECT COALESCE(tl_p,tl,0) as tl_p,
              COALESCE(total_tl_spent,0) as spent,
              COALESCE(total_tl_exchanged,0) as exchanged,
              COALESCE(poc_index,1.0) as poc_index,
              COALESCE(tlc_balance,tlc,0) as tlc
       FROM users WHERE id=?`
    ).bind(userId).first() as any;
    if (!user) return c.json({ error:'유저없음' }, 404);
    const pocIndex = Number(user.poc_index || 0);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);

    const spendRow = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(tl_spent),0) as spent FROM poc_logs WHERE user_id=? AND created_at>=?"
    ).bind(userId, monthStart).first() as any;
    const monthSpent = Number(spendRow?.spent || 0);

    const maxMineable = Math.floor(monthSpent * pocIndex * 0.1 * 100) / 100;

    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tlc_mining_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
      tlc_mined REAL DEFAULT 0, poc_index REAL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(() => {});
    const alreadyRow = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(tlc_mined),0) as mined FROM tlc_mining_logs WHERE user_id=? AND created_at>=?"
    ).bind(userId, monthStart).first() as any;
    const alreadyMined = Number(alreadyRow?.mined || 0);
    const actualMine = Math.max(0, Math.round((maxMineable - alreadyMined) * 100) / 100);

    if (pocIndex <= 0) {
      return c.json({ ok: false, error: 'POC 기여 지수가 없습니다. 청취·창작·업로드로 기여도를 쌓으세요.', mined: 0, tlc_total: Number(user.tlc || 0) });
    }
    if (actualMine <= 0) {
      return c.json({ ok: false, error: `이번 달 채굴 가능한 TLC가 없습니다. (이미 채굴: ${alreadyMined} TLC / 최대: ${maxMineable} TLC)`, mined: 0, tlc_total: Number(user.tlc || 0) });
    }

    await c.env.DB.prepare('UPDATE users SET tlc_balance=COALESCE(tlc_balance,0)+?, tlc=COALESCE(tlc,0)+? WHERE id=?').bind(actualMine, actualMine, userId).run();
    await c.env.DB.prepare("INSERT INTO tlc_mining_logs (user_id, tlc_mined, poc_index) VALUES (?,?,?)").bind(userId, actualMine, pocIndex).run();
    const updated = await c.env.DB.prepare('SELECT COALESCE(tlc_balance,tlc,0) as tlc FROM users WHERE id=?').bind(userId).first() as any;
    return c.json({
      ok: true, mined: actualMine, poc_index: pocIndex, tlc_total: Number(updated?.tlc || 0),
      formula: `월 TL_P 소비(${monthSpent}) × POC지수(${pocIndex}) × 10% = ${maxMineable} TLC (이번달 가능)`,
      already_mined: alreadyMined, max_mineable: maxMineable
    });
  } catch(e: any) { return c.json({ error: e.message }, 500); }
});

// ── 채굴 내역 ──
app.get('/api/eco/mining-history', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const rows = await c.env.DB.prepare(
      'SELECT tlc_mined, poc_index, created_at FROM tlc_mining_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 30'
    ).bind(userId).all();
    return c.json({ ok: true, history: rows.results || [] });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── TL 교환 ──
app.post('/api/eco/exchange', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const { tl_amount } = await c.req.json() as any;
    if (!tl_amount || tl_amount < 1000) return c.json({ error:'최소 1,000 TL부터 교환 가능' }, 400);
    const user = await c.env.DB.prepare('SELECT COALESCE(tl_p,tl,0) as tl_p FROM users WHERE id=?').bind(userId).first() as any;
    if (!user || Number(user.tl_p) < tl_amount) return c.json({ error:'구매TL 잔액 부족' }, 402);
    const fee = Math.ceil(tl_amount * 0.05);
    const net = tl_amount - fee;
    await c.env.DB.prepare(
      'UPDATE users SET tl_p=COALESCE(tl_p,tl,0)-?, tl=COALESCE(tl,0)-?, total_tl_exchanged=COALESCE(total_tl_exchanged,0)+? WHERE id=?'
    ).bind(tl_amount, tl_amount, tl_amount, userId).run();
    return c.json({ ok: true, fee_tl: fee, net_tl: net, exchanged: tl_amount });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── 활동 보고 (에코) ──
app.post('/api/eco/activity', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const { seconds, tl_p_spent, tl_a_spent, mode, share_id } = await c.req.json() as any;
    const tlSpent = Number(tl_p_spent||0) + Number(tl_a_spent||0);
    if (tlSpent > 0) {
      const user = await c.env.DB.prepare(
        'SELECT COALESCE(tl_p,tl,0) as tl_p, COALESCE(tl_a,0) as tl_a FROM users WHERE id=?'
      ).bind(userId).first() as any;
      let pSpent = Math.min(Number(tl_p_spent||0), Number(user?.tl_p||0));
      let aSpent = Math.min(Number(tl_a_spent||0), Number(user?.tl_a||0));
      await c.env.DB.prepare(
        'UPDATE users SET tl_p=MAX(0,COALESCE(tl_p,tl,0)-?), tl_a=MAX(0,COALESCE(tl_a,0)-?), tl=MAX(0,COALESCE(tl,0)-?), total_tl_spent=COALESCE(total_tl_spent,0)+? WHERE id=?'
      ).bind(pSpent, aSpent, pSpent+aSpent, pSpent+aSpent, userId).run();
    }
    if (seconds > 0) {
      await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS poc_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
        seconds INTEGER DEFAULT 0, tl_spent REAL DEFAULT 0, poc_gained REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`).run().catch(()=>{});
      await c.env.DB.prepare('INSERT INTO poc_logs (user_id, mode, seconds, tl_spent) VALUES (?,?,?,?)').bind(userId, mode||'listen', seconds, tlSpent).run();
    }
    const updated = await c.env.DB.prepare(
      'SELECT COALESCE(tl_p,tl,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b, COALESCE(poc_index,1.0) as poc_index FROM users WHERE id=?'
    ).bind(userId).first() as any;
    return c.json({ ok: true, tl_p: Number(updated?.tl_p||0), tl_a: Number(updated?.tl_a||0), tl_b: Number(updated?.tl_b||0), poc_index: Number(updated?.poc_index||1.0) });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── TON 지갑 ──
app.post('/api/ton/connect', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const { ton_address } = await c.req.json() as any;
    if (!ton_address) return c.json({ error:'TON 주소 필요' }, 400);
    const isValid = /^[0EU]Q[A-Za-z0-9_-]{46}$/.test(ton_address);
    if (!isValid) return c.json({ error:'유효하지 않은 TON 주소' }, 400);
    await c.env.DB.prepare("ALTER TABLE users ADD COLUMN ton_address TEXT DEFAULT ''").run().catch(()=>{});
    await c.env.DB.prepare("ALTER TABLE users ADD COLUMN ton_connected_at TEXT DEFAULT ''").run().catch(()=>{});
    await c.env.DB.prepare("UPDATE users SET ton_address=?, ton_connected_at=datetime('now') WHERE id=?").bind(ton_address, userId).run();
    return c.json({ ok: true, ton_address });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

app.post('/api/ton/withdraw', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const { tlc_amount } = await c.req.json() as any;
    if (!tlc_amount || tlc_amount < 1) return c.json({ error:'최소 출금 1 TLC' }, 400);

    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tlc_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      ton_address TEXT NOT NULL, tlc_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending', tx_hash TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), processed_at TEXT DEFAULT ''
    )`).run().catch(()=>{});

    const user = await c.env.DB.prepare(
      "SELECT COALESCE(tlc_balance,tlc,0) as tlc, ton_address FROM users WHERE id=?"
    ).bind(userId).first() as any;
    if (!user) return c.json({ error:'유저없음' }, 404);
    if (!user.ton_address) return c.json({ error:'TON 지갑을 먼저 연결하세요', code:'NO_TON_WALLET' }, 400);

    const tlcBalance = Number(user.tlc || 0);
    if (tlcBalance < tlc_amount) {
      return c.json({ error:`TLC 잔액 부족 (보유: ${tlcBalance.toFixed(2)} TLC)`, balance: tlcBalance }, 402);
    }

    const pending = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM tlc_withdrawals WHERE user_id=? AND status IN ('pending','processing')"
    ).bind(userId).first() as any;
    if (Number(pending?.cnt||0) > 0) {
      return c.json({ error:'이미 처리 중인 출금 신청이 있습니다. 처리 완료 후 다시 시도하세요.', code:'PENDING_EXISTS' }, 409);
    }

    await c.env.DB.prepare(
      "UPDATE users SET tlc_balance=COALESCE(tlc_balance,0)-?, tlc=COALESCE(tlc,0)-? WHERE id=?"
    ).bind(tlc_amount, tlc_amount, userId).run();

    const txHash = '';
    const status = 'pending';
    const message = `${tlc_amount} TLC 출금 신청 완료! 관리자 검토(1-3일) 후 TON 지갑으로 전송됩니다.`;

    await c.env.DB.prepare(
      "INSERT INTO tlc_withdrawals (user_id, ton_address, tlc_amount, status, tx_hash) VALUES (?,?,?,?,?)"
    ).bind(userId, user.ton_address, tlc_amount, status, txHash).run();

    return c.json({
      ok: true,
      message,
      ton_address: user.ton_address,
      tlc_amount,
      status,
      tx_hash: txHash,
      jetton_enabled: true,
    });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── Jetton 잔액 조회 ──
app.get('/api/ton/jetton-balance', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const user = await c.env.DB.prepare("SELECT ton_address FROM users WHERE id=?").bind(userId).first() as any;
    if (!user?.ton_address) return c.json({ ok:true, jetton_balance: 0, note:'TON 지갑 미연결' });
    const balance = await getJettonBalance(c.env, user.ton_address);
    return c.json({ ok:true, jetton_balance: balance, ton_address: user.ton_address });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── Admin: 출금 수동 승인 ──
app.post('/api/admin/ton/approve-withdrawal', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    const { withdrawal_id } = await c.req.json() as any;
    if (!withdrawal_id) return c.json({ error:'withdrawal_id 필요' }, 400);

    const wd = await c.env.DB.prepare(
      "SELECT * FROM tlc_withdrawals WHERE id=? AND status='pending'"
    ).bind(withdrawal_id).first() as any;
    if (!wd) return c.json({ error:'출금 신청 없음 또는 이미 처리됨' }, 404);

    const mintResult = await mintTLC(c.env, wd.ton_address, wd.tlc_amount);
    if (!mintResult.ok) return c.json({ error:'민팅 실패: ' + mintResult.error }, 500);

    await c.env.DB.prepare(
      "UPDATE tlc_withdrawals SET status='processing', tx_hash=?, processed_at=datetime('now') WHERE id=?"
    ).bind(mintResult.txHash || '', withdrawal_id).run();

    return c.json({ ok:true, tx_hash: mintResult.txHash, tlc_amount: wd.tlc_amount });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

app.get('/api/ton/status', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const user = await c.env.DB.prepare("SELECT ton_address, COALESCE(tlc_balance,tlc,0) as tlc FROM users WHERE id=?").bind(userId).first() as any;
    const withdrawals = await c.env.DB.prepare("SELECT * FROM tlc_withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 10").bind(userId).all();
    return c.json({ ok: true, ton_address: user?.ton_address || '', tlc_balance: Number(user?.tlc || 0), withdrawals: withdrawals.results || [] });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── 토스페이먼츠 ──
const TL_PACKAGES: Record<number,{tl:number,bonus:number}> = {
   5000: { tl:  5000, bonus:    0 },
  10000: { tl: 10000, bonus:  500 },
  30000: { tl: 30000, bonus: 2000 },
  50000: { tl: 50000, bonus: 5000 },
 100000: { tl:100000, bonus:15000 },
};

app.post('/api/payment/toss/confirm', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const { paymentKey, orderId, amount } = await c.req.json() as any;
    if (!paymentKey || !orderId || !amount) return c.json({ error:'paymentKey, orderId, amount 필수' }, 400);
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, method TEXT NOT NULL,
      pg_id TEXT NOT NULL UNIQUE, merchant_uid TEXT, amount_krw INTEGER NOT NULL,
      tl_granted INTEGER NOT NULL, bonus_tl INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(()=>{});
    await c.env.DB.prepare("ALTER TABLE tl_payments ADD COLUMN bonus_tl INTEGER DEFAULT 0").run().catch(()=>{});
    const dup = await c.env.DB.prepare('SELECT id FROM tl_payments WHERE pg_id=?').bind(paymentKey).first();
    if (dup) return c.json({ error:'이미 처리된 결제입니다' }, 409);
    const SECRET_KEY = (c.env as any).TOSS_SECRET_KEY || 'test_sk_d26DlbXAaV0xQbpa7y1VqY50Q9RB';
    const confirmRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(SECRET_KEY + ':'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });
    const confirmData = await confirmRes.json() as any;
    if (!confirmRes.ok) {
      await c.env.DB.prepare('INSERT OR IGNORE INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,bonus_tl,status) VALUES (?,?,?,?,?,?,?,?)').bind(userId,'toss',paymentKey,orderId,amount,0,0,'fail').run().catch(()=>{});
      return c.json({ error: confirmData.message || '결제 승인 실패', code: confirmData.code }, 400);
    }
    const pkg = TL_PACKAGES[Number(amount)];
    const tlGranted = pkg ? pkg.tl : Number(amount);
    const bonusTl   = pkg ? pkg.bonus : 0;
    const totalTl   = tlGranted + bonusTl;
    await c.env.DB.prepare('UPDATE users SET tl=COALESCE(tl,0)+?, tl_p=COALESCE(tl_p,tl,0)+? WHERE id=?').bind(totalTl, totalTl, userId).run();
    await c.env.DB.prepare('INSERT INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,bonus_tl,status) VALUES (?,?,?,?,?,?,?,?)').bind(userId,'toss',paymentKey,orderId,Number(amount),tlGranted,bonusTl,'success').run();
    const user = await c.env.DB.prepare('SELECT tl, COALESCE(tl_p,tl,0) as tl_p FROM users WHERE id=?').bind(userId).first() as any;
    return c.json({ ok: true, tl_granted: tlGranted, bonus_tl: bonusTl, total_tl: totalTl, tl_balance: user?.tl || 0, tl_p: user?.tl_p || 0, order_id: orderId, payment_key: paymentKey });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

app.get('/api/payment/toss/history', async (c) => {
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);
  try {
    const rows = await c.env.DB.prepare('SELECT * FROM tl_payments WHERE user_id=? ORDER BY created_at DESC LIMIT 20').bind(userId).all();
    return c.json({ ok:true, payments: rows.results || [] });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── AI 번역 ──
app.post('/api/translate', async (c) => {
  try {
    const { texts, target } = await c.req.json() as any;
    if (!texts || !Array.isArray(texts) || !target) return c.json({ error: 'texts(배열), target 필수' }, 400);
    const VALID_LANGS = ['en','ja','zh','th','vi','ko'];
    if (!VALID_LANGS.includes(target)) return c.json({ error: '지원 언어 아님' }, 400);
    if (target === 'ko') return c.json({ ok:true, translations: texts });
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_hash TEXT NOT NULL,
      source_text TEXT NOT NULL, target_lang TEXT NOT NULL, translated TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), UNIQUE(source_hash, target_lang)
    )`).run().catch(()=>{});
    const ANTHROPIC_KEY = (c.env as any).ANTHROPIC_API_KEY || '';
    const results: string[] = [];
    const toTranslate: { idx: number; text: string }[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (!text || text.trim() === '') { results[i] = text; continue; }
      const hash = Array.from(new TextEncoder().encode(text + target))
        .reduce((h,b) => ((h << 5) - h + b) | 0, 0).toString(36);
      const cached = await c.env.DB.prepare('SELECT translated FROM tl_translations WHERE source_hash=? AND target_lang=?').bind(hash, target).first<any>().catch(()=>null);
      if (cached) results[i] = cached.translated;
      else toTranslate.push({ idx: i, text });
    }
    if (toTranslate.length > 0 && ANTHROPIC_KEY) {
      const LANG_NAMES: Record<string,string> = { en:'English', ja:'Japanese', zh:'Simplified Chinese', th:'Thai', vi:'Vietnamese' };
      const prompt = `Translate the following Korean UI texts to ${LANG_NAMES[target] || target}.\nReturn ONLY a JSON array of translated strings in the same order.\nKeep special characters, numbers, and symbols unchanged.\nTexts:\n${JSON.stringify(toTranslate.map(t => t.text))}`;
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      });
      if (apiRes.ok) {
        const apiData = await apiRes.json() as any;
        const raw = apiData.content?.[0]?.text || '[]';
        const clean = raw.replace(/```json|```/g, '').trim();
        try {
          const translated: string[] = JSON.parse(clean);
          for (let j = 0; j < toTranslate.length; j++) {
            const { idx, text } = toTranslate[j];
            const result = translated[j] || text;
            results[idx] = result;
            const hash = Array.from(new TextEncoder().encode(text + target)).reduce((h,b) => ((h << 5) - h + b) | 0, 0).toString(36);
            await c.env.DB.prepare('INSERT OR IGNORE INTO tl_translations (source_hash,source_text,target_lang,translated) VALUES (?,?,?,?)').bind(hash, text, target, result).run().catch(()=>{});
          }
        } catch { toTranslate.forEach(({ idx, text }) => { results[idx] = text; }); }
      } else { toTranslate.forEach(({ idx, text }) => { results[idx] = text; }); }
    } else { toTranslate.forEach(({ idx, text }) => { results[idx] = text; }); }
    return c.json({ ok: true, translations: results, target });
  } catch(e:any) { return c.json({ error: e.message }, 500); }
});

// ── AI DJ ──
app.post('/api/dj/chat', async (c) => {
  const ANTHROPIC_KEY = (c.env as any).ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) {
    const slots: Record<string, string> = {
      morning: '좋은 아침! 하루를 상쾌하게 열어줄 어쿠스틱 팝을 틀게요.',
      lunch: '점심 시간엔 역시 재즈죠. 여유롭게 즐겨보세요.',
      afternoon: '카페 감성 가득한 인디팝 타임. 기분 좋은 오후 되세요.',
      evening: '하루를 마무리하는 감성적인 곡들로 채워드릴게요.',
      night: '밤의 감성을 깨우는 드림팝. 조용히 빠져들어봐요.',
    };
    const hour = new Date().getHours();
    const slot = hour < 9 ? 'morning' : hour < 14 ? 'lunch' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'night';
    return c.json({ reply: slots[slot] || '최고의 음악을 선곡하고 있어요!', fallback: true });
  }
  try {
    const body = await c.req.json() as any;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': ANTHROPIC_KEY },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: body.max_tokens || 200, system: body.system, messages: body.messages }),
    });
    const data: any = await res.json();
    if (data.error) return c.json({ reply: '좋은 음악을 선곡하고 있어요!', fallback: true, error_detail: data.error });
    const text = data.content?.[0]?.text;
    if (!text) return c.json({ reply: '최고의 음악을 선곡하고 있어요!', fallback: true, raw: data });
    return c.json({ reply: text, usage: data.usage });
  } catch (e: any) {
    return c.json({ reply: '최고의 음악을 선곡하고 있어요!', fallback: true, error: e.message });
  }
});

// ── 뉴스 헤드라인 ──
app.get('/api/news/headlines', async (c) => {
  try {
    const feeds = [
      'https://news.naver.com/main/rss/rankingNews.naver?rankingType=popular_day&sectionId=106',
      'https://rss.etnews.com/Section901.xml',
    ];
    const results: string[] = [];
    for (const url of feeds) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const xml = await r.text();
        const matches = xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g);
        let count = 0;
        for (const m of matches) {
          const title = (m[1] || m[2] || '').trim();
          if (title && !title.includes('RSS') && !title.includes('뉴스') && title.length > 5) {
            results.push(title);
            if (++count >= 3) break;
          }
        }
      } catch {}
      if (results.length >= 5) break;
    }
    return c.json({ ok: true, headlines: results.slice(0, 5) });
  } catch (e: any) {
    return c.json({ ok: true, headlines: [] });
  }
});

// ── 차트 ──
app.get('/api/chart', async (c) => {
  try {
    const type = c.req.query('type') || 'music';
    const genre = c.req.query('genre') || 'all';
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, share_id TEXT,
      tl_balance INTEGER DEFAULT 0, total_charged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(()=>{});
    await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN category_type TEXT DEFAULT ''").run().catch(()=>{});
    await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN stream_url TEXT DEFAULT ''").run().catch(()=>{});
    let rows;
    if (type === 'tl') {
      const res = await c.env.DB.prepare(`SELECT s.id, s.title, s.artist, s.album, s.category, s.file_type, s.duration, s.cover_url, s.pulse, s.file_tl, COALESCE(u.username, s.username, 'User') as username, s.file_tl as total_tl_charged FROM tl_shares s LEFT JOIN users u ON CAST(s.user_id AS TEXT) = CAST(u.id AS TEXT) ORDER BY s.file_tl DESC, s.pulse DESC LIMIT ?`).bind(limit).all();
      rows = res.results;
    } else {
      let typeFilter = '';
      if (type === 'music') typeFilter = `AND (s.file_type LIKE 'audio/%' OR UPPER(s.category) IN ('MUSIC','K-POP','POP','팝','HIPHOP','힙합','R&B','록','ROCK','클래식','재즈','EDM','인디'))`;
      else if (type === 'video') typeFilter = `AND (s.file_type LIKE 'video/%' OR UPPER(s.category) IN ('VIDEO','영상','MV'))`;
      else if (type === 'doc') typeFilter = `AND (s.file_type LIKE 'application/%' OR s.file_type LIKE 'text/%' OR UPPER(s.category) IN ('DOCUMENT','문서','전자책','강의'))`;
      else if (type === 'image') typeFilter = `AND (s.file_type LIKE 'image/%' OR UPPER(s.category) IN ('IMAGE','이미지','ART'))`;
      let genreFilter = '';
      if (genre !== 'all') genreFilter = `AND UPPER(s.category) = UPPER('${genre.replace(/'/g,"''")}')`;
      const res = await c.env.DB.prepare(`SELECT s.id, s.title, s.artist, s.album, s.category, s.file_type, s.duration, s.cover_url, s.pulse, s.file_tl, COALESCE(u.username, s.username, 'User') as username, 0 as total_tl_charged FROM tl_shares s LEFT JOIN users u ON CAST(s.user_id AS TEXT) = CAST(u.id AS TEXT) WHERE 1=1 ${typeFilter} ${genreFilter} ORDER BY s.pulse DESC, s.file_tl DESC LIMIT ?`).bind(limit).all();
      rows = res.results;
    }
    return c.json({ ok: true, chart: rows || [] });
  } catch(e: any) { return c.json({ error: e.message }, 500); }
});

// ── 국세청 사업자 진위확인 ──
app.post('/api/biz/verify', async (c) => {
  try {
    const { biz_no } = await c.req.json() as any;
    if (!biz_no) return c.json({ ok: false, error: '사업자등록번호가 없습니다.' }, 400);
    const cleanNo = biz_no.replace(/[^0-9]/g, '');
    if (cleanNo.length !== 10) return c.json({ ok: false, error: '사업자등록번호 10자리를 입력하세요.' }, 400);
    const NTS_KEY = (c.env as any).NTS_API_KEY || '';
    if (!NTS_KEY) return c.json({ ok: false, error: 'NTS API 키가 없습니다.' }, 500);
    const res = await fetch(`https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${NTS_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b_no: [cleanNo] })
    });
    const data = await res.json() as any;
    if (data.status_code !== 'OK' || !data.data?.length) {
      return c.json({ ok: false, error: '사업자 정보를 확인할 수 없습니다.' });
    }
    const biz = data.data[0];
    const isActive = biz.b_stt_cd === '01';
    return c.json({
      ok: true,
      active: isActive,
      status: biz.b_stt,
      tax_type: biz.tax_type,
      b_no: biz.b_no
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ── TL 파일 마이그레이션 ──
app.post('/api/admin/migrate-tl-files', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason || '접근 거부' }, 403);
  try {
    const shares = await c.env.DB.prepare(
      "SELECT id, file_type FROM tl_shares WHERE file_type IS NOT NULL AND file_type != ''"
    ).all();

    const results = { success: 0, skip: 0, error: 0, details: [] as string[] };

    for (const share of (shares.results || []) as any[]) {
      const shareId = share.id;
      const { ext, folder } = getTLExtAndFolder(share.file_type || 'audio/mpeg');
      const newKey = `${folder}/${shareId}.${ext}`;
      const oldKey = `tl/${shareId}.tl`;

      const exists = await c.env.R2.head(newKey);
      if (exists) { results.skip++; continue; }

      const oldObj = await c.env.R2.get(oldKey);
      if (!oldObj) { results.skip++; continue; }

      try {
        const data = await oldObj.arrayBuffer();
        await c.env.R2.put(newKey, data, {
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: { shareId, migratedFrom: oldKey, migratedAt: new Date().toISOString() }
        });
        results.success++;
        results.details.push(`${shareId}: ${oldKey} → ${newKey}`);
      } catch(e: any) {
        results.error++;
        results.details.push(`${shareId}: ERROR - ${e.message}`);
      }
    }

    return c.json({ ok: true, ...results });
  } catch(e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/covers/generate', async (c) => {
  try {
    const { share_id, title, artist, genre } = await c.req.json() as any;
    if (!share_id) return c.json({ ok: false, error: 'share_id 필요' }, 400);

    const share = await c.env.DB.prepare('SELECT cover_url FROM tl_shares WHERE id=?').bind(share_id).first() as any;
    if (share?.cover_url) return c.json({ ok: true, cover_url: share.cover_url, cached: true });

    const coverKey = `covers/${share_id}.svg`;
    const existing = await c.env.R2.head(coverKey);
    if (existing) {
      const url = `https://pub-c8d04f598d434d2f9568c08938d892a7.r2.dev/${coverKey}`;
      c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE tl_shares SET cover_url=? WHERE id=?').bind(url, share_id).run());
      return c.json({ ok: true, cover_url: url, cached: true });
    }

    const genreColors: Record<string, [string,string]> = {
      'K-POP':['#ff6b9d','#c44dff'],'POP':['#f7971e','#ffd200'],
      'BALLAD':['#4facfe','#00f2fe'],'발라드':['#4facfe','#00f2fe'],
      'HIPHOP':['#f953c6','#b91d73'],'힙합':['#f953c6','#b91d73'],
      'R&B':['#8e2de2','#4a00e0'],'JAZZ':['#2c3e50','#4ca1af'],'재즈':['#2c3e50','#4ca1af'],
      'EDM':['#00c6ff','#0072ff'],'ROCK':['#f12711','#f5af19'],'록':['#f12711','#f5af19'],
      'CLASSIC':['#2c3e50','#bdc3c7'],'클래식':['#2c3e50','#bdc3c7'],
      'INDIE':['#56ab2f','#a8e063'],'인디':['#56ab2f','#a8e063'],
    };
    const gKey = (genre||'').toUpperCase();
    const colors = genreColors[gKey] || genreColors[genre||''] || ['#667eea','#764ba2'];
    const c1 = colors[0], c2 = colors[1];
    const t1 = (title||'').substring(0,14).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const a1 = (artist||'').substring(0,16).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const ini = (title||'?').substring(0,2).toUpperCase();
    const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:${c1}"/><stop offset="100%" style="stop-color:${c2}"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="220" r="100" fill="rgba(255,255,255,0.12)"/><circle cx="300" cy="220" r="70" fill="rgba(255,255,255,0.15)"/><text x="300" y="240" font-family="Arial" font-size="72" font-weight="bold" fill="white" text-anchor="middle">${ini}</text><text x="300" y="370" font-family="Arial" font-size="32" font-weight="bold" fill="white" text-anchor="middle">${t1}</text><text x="300" y="415" font-family="Arial" font-size="22" fill="rgba(255,255,255,0.75)" text-anchor="middle">${a1}</text><text x="300" y="475" font-family="Arial" font-size="16" fill="rgba(255,255,255,0.5)" text-anchor="middle">TimeLink</text></svg>`;
    const svgBytes = new TextEncoder().encode(svgStr);
    await c.env.R2.put(coverKey, svgBytes, {
      httpMetadata: { contentType: 'image/svg+xml' },
      customMetadata: { share_id, generated: 'svg' },
    });
    const coverUrl = `https://pub-c8d04f598d434d2f9568c08938d892a7.r2.dev/${coverKey}`;
    c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE tl_shares SET cover_url=? WHERE id=?').bind(coverUrl, share_id).run());
    return c.json({ ok: true, cover_url: coverUrl });
  } catch(e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});


// ══════════════════════════════════════════════════════════
// SOCIAL API (좋아요/팔로우/댓글/플레이리스트)
// ══════════════════════════════════════════════════════════

const POC_SECONDS: Record<string, number> = {
  like: 5, follow: 1, comment: 60, playlist_create: 120,
  playlist_subscribe: 30, share: 30, checkin: 30, invite_success: 3600
};

async function logPocAction(db: any, user_id: number, action_type: string, target_id: string) {
  const sec = POC_SECONDS[action_type] || 0;
  await db.prepare(
    'INSERT INTO poc_action_logs (user_id, action_type, target_id, seconds_equivalent, created_at) VALUES (?,?,?,?,datetime("now"))'
  ).bind(user_id, action_type, target_id, sec).run();
}

app.post('/api/social/like/:shareId', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const share_id = c.req.param('shareId');
  const todayCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM poc_action_logs WHERE user_id=? AND action_type='like' AND created_at>=date('now')"
  ).bind(user_id).first() as any;
  if ((todayCount?.cnt||0) >= 50) return c.json({ error: '일일 좋아요 한도 초과 (50개)' }, 429);
  try {
    await c.env.DB.prepare(
      'INSERT INTO user_likes (user_id, share_id, created_at) VALUES (?,?,datetime("now"))'
    ).bind(user_id, share_id).run();
    await logPocAction(c.env.DB, user_id, 'like', share_id);
    const cnt = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM user_likes WHERE share_id=?').bind(share_id).first() as any;
    return c.json({ ok: true, likes: cnt?.cnt||0 });
  } catch { return c.json({ ok: false, error: '이미 좋아요함' }, 409); }
});

app.delete('/api/social/like/:shareId', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const share_id = c.req.param('shareId');
  await c.env.DB.prepare('DELETE FROM user_likes WHERE user_id=? AND share_id=?').bind(user_id, share_id).run();
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM user_likes WHERE share_id=?').bind(share_id).first() as any;
  return c.json({ ok: true, likes: cnt?.cnt||0 });
});

app.post('/api/social/follow/:userId', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const follower_id = Number(m[1]);
  const following_id = Number(c.req.param('userId'));
  if (follower_id === following_id) return c.json({ error: '자기 자신 팔로우 불가' }, 400);
  try {
    await c.env.DB.prepare(
      'INSERT INTO user_follows (follower_id, following_id, created_at) VALUES (?,?,datetime("now"))'
    ).bind(follower_id, following_id).run();
    await logPocAction(c.env.DB, follower_id, 'follow', String(following_id));
    return c.json({ ok: true });
  } catch { return c.json({ ok: false, error: '이미 팔로우함' }, 409); }
});

app.delete('/api/social/follow/:userId', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const follower_id = Number(m[1]);
  const following_id = Number(c.req.param('userId'));
  await c.env.DB.prepare('DELETE FROM user_follows WHERE follower_id=? AND following_id=?').bind(follower_id, following_id).run();
  return c.json({ ok: true });
});

app.post('/api/social/comment/:shareId', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const share_id = c.req.param('shareId');
  const { content } = await c.req.json();
  if (!content || content.trim().length < 10) return c.json({ error: '댓글은 10자 이상' }, 400);
  const dup = await c.env.DB.prepare(
    "SELECT id FROM comments WHERE user_id=? AND share_id=? AND content=? AND created_at>=datetime('now','-1 hour')"
  ).bind(user_id, share_id, content.trim()).first();
  if (dup) return c.json({ error: '동일 댓글은 1시간 후 가능' }, 429);
  const result = await c.env.DB.prepare(
    'INSERT INTO comments (user_id, share_id, content, created_at) VALUES (?,?,?,datetime("now"))'
  ).bind(user_id, share_id, content.trim()).run();
  await logPocAction(c.env.DB, user_id, 'comment', share_id);
  return c.json({ ok: true, comment_id: result.meta.last_row_id });
});

app.get('/api/social/comments/:shareId', async (c) => {
  const share_id = c.req.param('shareId');
  const rows = await c.env.DB.prepare(
    'SELECT c.id, c.content, c.created_at, c.report_count, u.username FROM comments c JOIN users u ON c.user_id=u.id WHERE c.share_id=? AND c.is_deleted=0 ORDER BY c.created_at DESC LIMIT 50'
  ).bind(share_id).all();
  return c.json({ ok: true, comments: rows.results });
});

app.post('/api/social/report/comment/:commentId', async (c) => {
  const comment_id = Number(c.req.param('commentId'));
  await c.env.DB.prepare('UPDATE comments SET report_count=report_count+1 WHERE id=?').bind(comment_id).run();
  await c.env.DB.prepare('UPDATE comments SET is_deleted=1 WHERE id=? AND report_count>=5').bind(comment_id).run();
  return c.json({ ok: true });
});

app.post('/api/playlist', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const { title, is_public } = await c.req.json();
  if (!title) return c.json({ error: '제목 필요' }, 400);
  const result = await c.env.DB.prepare(
    'INSERT INTO playlists (user_id, title, is_public, created_at) VALUES (?,?,?,datetime("now"))'
  ).bind(user_id, title, is_public ? 1 : 0).run();
  await logPocAction(c.env.DB, user_id, 'playlist_create', String(result.meta.last_row_id));
  return c.json({ ok: true, playlist_id: result.meta.last_row_id });
});

app.post('/api/playlist/:id/add', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const playlist_id = Number(c.req.param('id'));
  const { share_id } = await c.req.json();
  const pl = await c.env.DB.prepare('SELECT * FROM playlists WHERE id=? AND user_id=?').bind(playlist_id, user_id).first() as any;
  if (!pl) return c.json({ error: '플레이리스트 없음' }, 404);
  const ids = JSON.parse(pl.share_ids||'[]');
  if (!ids.includes(share_id)) ids.push(share_id);
  await c.env.DB.prepare('UPDATE playlists SET share_ids=? WHERE id=?').bind(JSON.stringify(ids), playlist_id).run();
  return c.json({ ok: true, count: ids.length });
});

app.post('/api/playlist/:id/subscribe', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const playlist_id = Number(c.req.param('id'));
  try {
    await c.env.DB.prepare(
      'INSERT INTO playlist_subscribers (user_id, playlist_id, created_at) VALUES (?,?,datetime("now"))'
    ).bind(user_id, playlist_id).run();
    await c.env.DB.prepare('UPDATE playlists SET subscriber_count=subscriber_count+1 WHERE id=?').bind(playlist_id).run();
    await logPocAction(c.env.DB, user_id, 'playlist_subscribe', String(playlist_id));
    return c.json({ ok: true });
  } catch { return c.json({ ok: false, error: '이미 구독함' }, 409); }
});

app.get('/api/social/stats/:shareId', async (c) => {
  const share_id = c.req.param('shareId');
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  const user_id = m ? Number(m[1]) : 0;
  const likes = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM user_likes WHERE share_id=?').bind(share_id).first() as any;
  const comments = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM comments WHERE share_id=? AND is_deleted=0').bind(share_id).first() as any;
  const myLike = user_id ? await c.env.DB.prepare('SELECT id FROM user_likes WHERE user_id=? AND share_id=?').bind(user_id, share_id).first() : null;
  return c.json({ ok: true, likes: likes?.cnt||0, comments: comments?.cnt||0, my_like: !!myLike });
});

app.get('/api/playlist/my', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ error: '인증 필요' }, 401);
  const user_id = Number(m[1]);
  const rows = await c.env.DB.prepare(
    'SELECT id, title, is_public, share_ids, subscriber_count, created_at FROM playlists WHERE user_id=? ORDER BY created_at DESC'
  ).bind(user_id).all();
  return c.json({ ok: true, playlists: rows.results });
});

app.get('/api/social/follow-status/:userId', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
  const m = auth.match(/^(?:token|fallback)_([^_]+)_/);
  if (!m) return c.json({ following: false });
  const follower_id = Number(m[1]);
  const following_id = Number(c.req.param('userId'));
  const row = await c.env.DB.prepare(
    'SELECT id FROM user_follows WHERE follower_id=? AND following_id=?'
  ).bind(follower_id, following_id).first();
  return c.json({ following: !!row });
});

app.post('/api/investor/contact', async (c) => {
  try {
    const { name, email, message } = await c.req.json() as any;
    if (!name || !email || !message) return c.json({ ok: false, error: '필수 항목 누락' }, 400);
    if (message.length > 1000) return c.json({ ok: false, error: '1,000자 초과' }, 400);

    const RESEND_KEY = (c.env as any).RESEND_API_KEY || '';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'TimeLink <onboarding@resend.dev>',
        to: ['mununglee@gmail.com'],
        subject: `[TimeLink 투자문의] ${name}`,
        html: `
          <h2>TimeLink 투자 문의</h2>
          <p><b>이름/회사:</b> ${name}</p>
          <p><b>이메일:</b> ${email}</p>
          <hr>
          <p><b>문의 내용:</b></p>
          <p style="white-space:pre-wrap">${message}</p>
        `,
        reply_to: email,
      }),
    });

    if (!res.ok) {
      const err = await res.json() as any;
      return c.json({ ok: false, error: err.message || '발송 실패' }, 500);
    }
    return c.json({ ok: true });
  } catch(e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
//  P1: 크리에이터 정산 관리
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/creators/payouts', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);
  try {
    const db = c.env.DB;
    await db.prepare("ALTER TABLE tl_shares ADD COLUMN creator_earned INTEGER DEFAULT 0").run().catch(()=>{});
    await db.prepare(`CREATE TABLE IF NOT EXISTS creator_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, amount_tl INTEGER NOT NULL,
      amount_krw INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    )`).run().catch(()=>{});

    const creators = await db.prepare(`
      SELECT u.id, u.username, u.email,
        COALESCE(u.tl_p,u.tl,0)+COALESCE(u.tl_a,0)+COALESCE(u.tl_b,0) as tl_balance,
        COALESCE(u.total_tl_earned,0) as total_earned,
        COALESCE(u.total_tl_exchanged,0) as total_exchanged,
        COUNT(s.id) as track_count,
        COALESCE(SUM(s.pulse),0) as total_pulse,
        COALESCE(SUM(s.file_tl),0) as total_file_tl
      FROM users u
      LEFT JOIN tl_shares s ON CAST(s.user_id AS TEXT)=CAST(u.id AS TEXT)
      GROUP BY u.id
      HAVING COUNT(s.id)>0
      ORDER BY total_earned DESC LIMIT 50
    `).all().catch(()=>({results:[]}));

    const requests = await db.prepare(`
      SELECT cp.*, u.username, u.email
      FROM creator_payouts cp
      LEFT JOIN users u ON cp.user_id=u.id
      ORDER BY cp.created_at DESC LIMIT 20
    `).all().catch(()=>({results:[]}));

    const summary = await db.prepare(`
      SELECT COALESCE(SUM(COALESCE(total_tl_earned,0)-COALESCE(total_tl_exchanged,0)),0) as unpaid_tl,
             COUNT(*) as creator_count
      FROM users WHERE id IN (SELECT DISTINCT CAST(user_id AS INTEGER) FROM tl_shares)
    `).first() as any;

    return c.json({ ok: true, creators: creators.results||[], requests: requests.results||[], summary });
  } catch(e:any) { return c.json({ ok:false, error:e.message },500); }
});

app.post('/api/admin/creators/:id/payout', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);
  const userId = c.req.param('id');
  const body = await c.req.json() as any;
  const amount = Number(body.amount_tl || 0);
  if (amount <= 0) return c.json({ error: 'amount_tl 필요' }, 400);
  try {
    await c.env.DB.prepare(
      "INSERT INTO creator_payouts (user_id,amount_tl,amount_krw,status,note) VALUES (?,?,?,?,?)"
    ).bind(userId, amount, body.amount_krw||0, body.status||'completed', body.note||'관리자 수동 정산').run();
    if (body.status === 'completed') {
      await c.env.DB.prepare(
        "UPDATE users SET total_tl_exchanged=COALESCE(total_tl_exchanged,0)+? WHERE id=?"
      ).bind(amount, userId).run();
    }
    return c.json({ ok: true });
  } catch(e:any) { return c.json({ ok:false, error:e.message },500); }
});

// ══════════════════════════════════════════════════════════════
//  P1: 실시간 대시보드
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/realtime', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);
  try {
    const db = c.env.DB;
    const [users, shares, payments, recent] = await Promise.all([
      db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(COALESCE(tl_p,tl,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)),0) as total_tl FROM users").first() as any,
      db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(pulse),0) as pulse, COALESCE(SUM(file_tl),0) as file_tl FROM tl_shares").first() as any,
      db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount_krw),0) as total FROM tl_payments WHERE status='success' AND date(created_at)=date('now')").first() as any,
      db.prepare("SELECT s.title, s.artist, s.pulse, s.cover_url FROM tl_shares s ORDER BY s.pulse DESC LIMIT 5").all().catch(()=>({results:[]})),
    ]);
    const cafeChannels = await db.prepare("SELECT COUNT(*) as cnt FROM cafe_channels WHERE is_active=1").first().catch(()=>({cnt:0})) as any;
    return c.json({
      ok: true,
      users: { total: Number(users?.cnt||0), total_tl: Number(users?.total_tl||0) },
      shares: { total: Number(shares?.cnt||0), total_pulse: Number(shares?.pulse||0), total_file_tl: Number(shares?.file_tl||0) },
      today: { payments: Number(payments?.cnt||0), revenue_krw: Number(payments?.total||0) },
      cafe_channels: Number(cafeChannels?.cnt||0),
      top_tracks: recent.results||[],
      timestamp: new Date().toISOString(),
    });
  } catch(e:any) { return c.json({ ok:false, error:e.message },500); }
});

// ══════════════════════════════════════════════════════════════
//  P2: 음악 콘텐츠 분석
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/music/analytics', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);
  try {
    const db = c.env.DB;
    const [genres, bpm, top, recent] = await Promise.all([
      db.prepare("SELECT category, COUNT(*) as cnt, COALESCE(SUM(pulse),0) as pulse FROM tl_shares GROUP BY category ORDER BY cnt DESC LIMIT 15").all().catch(()=>({results:[]})),
      db.prepare("SELECT CASE WHEN bpm=0 OR bpm IS NULL THEN '미측정' WHEN bpm<80 THEN '느림(~80)' WHEN bpm<110 THEN '보통(80~110)' WHEN bpm<135 THEN '신남(110~135)' ELSE '빠름(135+)' END as range, COUNT(*) as cnt FROM tl_shares GROUP BY range ORDER BY cnt DESC").all().catch(()=>({results:[]})),
      db.prepare("SELECT id,title,artist,category,pulse,file_tl,bpm,cover_url FROM tl_shares ORDER BY pulse DESC LIMIT 10").all().catch(()=>({results:[]})),
      db.prepare("SELECT id,title,artist,category,pulse,created_at FROM tl_shares ORDER BY created_at DESC LIMIT 10").all().catch(()=>({results:[]})),
    ]);
    const totals = await db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(pulse),0) as pulse, COALESCE(AVG(NULLIF(bpm,0)),0) as avg_bpm FROM tl_shares").first() as any;
    return c.json({ ok:true, genres:genres.results||[], bpm_dist:bpm.results||[], top_tracks:top.results||[], recent_tracks:recent.results||[], totals });
  } catch(e:any) { return c.json({ ok:false, error:e.message },500); }
});

// ══════════════════════════════════════════════════════════════
//  P2: 카페방송 채널 관리
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/cafe/channels', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);
  try {
    const db = c.env.DB;
    await db.prepare("ALTER TABLE cafe_channels ADD COLUMN monthly_fee INTEGER DEFAULT 50000").run().catch(()=>{});
    const channels = await db.prepare(`
      SELECT cc.*, u.username, u.email,
        CASE WHEN cc.expires_at > datetime('now') THEN 'active' ELSE 'expired' END as status,
        CAST((julianday(cc.expires_at) - julianday('now')) AS INTEGER) as days_left
      FROM cafe_channels cc
      LEFT JOIN users u ON CAST(cc.owner_id AS TEXT)=CAST(u.id AS TEXT)
      ORDER BY cc.created_at DESC
    `).all().catch(()=>({results:[]}));

    const summary = await db.prepare(`
      SELECT COUNT(*) as total,
        COUNT(CASE WHEN expires_at > datetime('now') THEN 1 END) as active,
        COUNT(CASE WHEN expires_at <= datetime('now') THEN 1 END) as expired
      FROM cafe_channels
    `).first().catch(()=>null) as any;

    return c.json({ ok:true, channels:channels.results||[], summary });
  } catch(e:any) { return c.json({ ok:false, error:e.message },500); }
});

// ══════════════════════════════════════════════════════════════
//  P3: 인프라/운영 비용 추적
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/infra/stats', async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);
  try {
    const db = c.env.DB;
    const storage = await db.prepare("SELECT COUNT(*) as files, COALESCE(SUM(file_size),0) as total_bytes FROM upload_logs").first().catch(()=>({files:0,total_bytes:0})) as any;
    const workers = await db.prepare("SELECT COUNT(*) as requests FROM api_logs WHERE created_at >= date('now','-30 days')").first().catch(()=>({requests:0})) as any;

    const gb = Number(storage?.total_bytes||0) / (1024**3);
    const r2_cost_usd = gb * 0.015;
    const workers_requests = Number(workers?.requests||0);
    const workers_cost_usd = Math.max(0, (workers_requests - 10_000_000) / 1_000_000 * 0.30);

    return c.json({
      ok: true,
      storage: { files: Number(storage?.files||0), total_gb: gb.toFixed(3), cost_usd: r2_cost_usd.toFixed(4) },
      workers: { requests_30d: workers_requests, cost_usd: workers_cost_usd.toFixed(4) },
      estimated_monthly_usd: (r2_cost_usd + workers_cost_usd).toFixed(2),
      estimated_monthly_krw: Math.round((r2_cost_usd + workers_cost_usd) * 1350),
    });
  } catch(e:any) { return c.json({ ok:false, error:e.message },500); }
});

// ── 배치 처리: 매일 자정 충전 기록 TON 블록체인에 기록 ──
async function batchRecordToTON(env: Env) {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);

    const logs = await (env as any).DB.prepare(`
      SELECT user_id, share_id, SUM(amount) as total_amount, COUNT(*) as charge_count
      FROM tl_charge_logs
      WHERE date(created_at) = ? AND confirmed = 0
      GROUP BY user_id, share_id
    `).bind(dateStr).all();

    if (!logs.results?.length) return { ok: true, message: '기록 없음' };

    const batchData = {
      type: 'tl_charge_batch',
      date: dateStr,
      totalRecords: logs.results.length,
      totalAmount: logs.results.reduce((s: number, r: any) => s + Number(r.total_amount), 0),
      records: logs.results.map((r: any) => ({
        u: r.user_id,
        s: r.share_id,
        a: r.total_amount,
        n: r.charge_count
      })),
      platform: 'timelink.digital'
    };

    const batchJson = JSON.stringify(batchData);
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(batchJson));
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');

    await (env as any).DB.prepare(`
      CREATE TABLE IF NOT EXISTS tl_batch_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_date TEXT NOT NULL,
        record_count INTEGER DEFAULT 0,
        total_amount INTEGER DEFAULT 0,
        batch_hash TEXT NOT NULL,
        batch_json TEXT,
        ton_tx_hash TEXT DEFAULT '',
        confirmed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run().catch(() => {});

    await (env as any).DB.prepare(`
      INSERT INTO tl_batch_logs (batch_date, record_count, total_amount, batch_hash, batch_json)
      VALUES (?, ?, ?, ?, ?)
    `).bind(dateStr, logs.results.length, batchData.totalAmount, hashHex, batchJson).run();

    const { mintTLC } = await import('./jetton');
    const memo = `TLCHARGE:${dateStr}:${hashHex.slice(0,16)}:${batchData.totalRecords}rec:${batchData.totalAmount}TL`;

    const tonApiKey = (env as any).TON_API_KEY || '';
    const adminWallet = (env as any).TON_ADMIN_WALLET || '';
    if (adminWallet && tonApiKey) {
      const tonRes = await fetch(`https://testnet.toncenter.com/api/v2/sendBoc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': tonApiKey },
        body: JSON.stringify({ boc: memo })
      }).catch(() => null);
    }

    await (env as any).DB.prepare(`
      UPDATE tl_charge_logs SET confirmed=1 WHERE date(created_at)=?
    `).bind(dateStr).run();

    return { ok: true, date: dateStr, records: logs.results.length, hash: hashHex };
  } catch(e: any) {
    return { ok: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
//  Not Found 핸들러
// ══════════════════════════════════════════════════════════════
app.notFound((c) => c.json({ detail: 'Not found' }, 404));

// ══════════════════════════════════════════════════════════════
//  Cron 핸들러 (배치 작업)
// ══════════════════════════════════════════════════════════════
export default {
  fetch: app.fetch,
  async scheduled(event: any, env: Env, ctx: any) {
    ctx.waitUntil(batchRecordToTON(env));
  }
};