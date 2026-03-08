// ═══════════════════════════════════════════════════════
// TimeLink Backend Worker — src/index.js (통합본)
// ═══════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// JWT payload 추출
function parseToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('expired');
    return {
      userId: payload.userId || payload.id || payload.uid,
      username: payload.username || payload.email || 'User'
    };
  } catch(e) { throw new Error('Invalid token'); }
}

// Spotify 토큰 캐시
let _spToken = null, _spExp = 0;
async function getSpotifyToken(env) {
  if (_spToken && Date.now() < _spExp) return _spToken;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  _spToken = d.access_token;
  _spExp = Date.now() + (d.expires_in - 60) * 1000;
  return _spToken;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ✅ CORS Preflight
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {

      // ── Health ────────────────────────────────────────
      if (path === '/api/health' || path === '/api/test') {
        return json({ status: 'ok', ts: Date.now() });
      }

      // ══════════════════════════════════════════════════
      // 인증 API
      // ══════════════════════════════════════════════════

      if (path === '/api/login' && method === 'POST') {
        try {
          const { email, password } = await request.json();
          const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
          if (!user) return err('User not found', 401);
          if (user.password_hash !== password) return err('Invalid password', 401);
          const { password_hash, ...safe } = user;
          return json({ success: true, user: safe, token: 'token_' + user.id + '_' + Date.now() });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/register' && method === 'POST') {
        try {
          const { username, email, password, role, isBusiness, businessName } = await request.json();
          if (!username || !email || !password) return err('username, email, password 필수');
          const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
          if (existing) return err('Email already exists', 400);
          const tl = isBusiness ? 20000 : (role === 'creator' ? 15000 : 10000);
          const result = await env.DB.prepare(
            'INSERT INTO users (username, email, password_hash, tl, tlc, role, is_business, business_name) VALUES (?,?,?,?,0,?,?,?)'
          ).bind(username, email, password, tl, role || 'listener', isBusiness ? 1 : 0, businessName || null).run();
          return json({ success: true, userId: result.meta.last_row_id, tl });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/auth-register' && method === 'POST') {
        try {
          const b = await request.json();
          if (!b.tlFileId || !b.title) return err('tlFileId, title 필수');
          const exists = await env.DB.prepare('SELECT id FROM auth_records WHERE tl_file_id=?').bind(b.tlFileId).first();
          if (exists) return json({ ok: true, action: 'already_exists' });
          await env.DB.prepare(`
            INSERT INTO auth_records(tl_file_id,title,artist,copyright_owner,composer,lyricist,release_date,label,isrc,reg_num,description,auth_method,registered_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(b.tlFileId, b.title, b.artist||'', b.copyright||'', b.composer||'', b.lyricist||'',
            b.releaseDate||'', b.label||'', b.isrc||'', b.regNum||'', b.description||'',
            b.authMethod||'manual', new Date().toISOString()).run();
          return json({ ok: true, action: 'registered' });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/user' && method === 'GET') {
        const email = url.searchParams.get('email');
        if (!email) return err('email 필수');
        try {
          const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
          return json({ user: user || null });
        } catch(e) { return json({ user: null }); }
      }

      // ══════════════════════════════════════════════════
      // 트랙 API (tracks 테이블 — 기존)
      // ══════════════════════════════════════════════════

      if (path === '/api/tracks' && method === 'GET') {
        const genre = url.searchParams.get('genre');
        const q = url.searchParams.get('q');
        const userId = url.searchParams.get('userId');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 200);
        let sql = 'SELECT * FROM tracks WHERE shared=1';
        const params = [];
        if (userId) { sql = 'SELECT * FROM tracks WHERE user_id=?'; params.push(userId); }
        else {
          if (genre && genre !== 'all') { sql += ' AND genre=?'; params.push(genre); }
          if (q) { sql += ' AND (title LIKE ? OR artist LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
          sql += ' ORDER BY pulse DESC LIMIT ?'; params.push(limit);
        }
        const { results } = await env.DB.prepare(sql).bind(...params).all();
        return json({ tracks: results || [] });
      }

      if (path === '/api/tracks' && method === 'POST') {
        try {
          const b = await request.json();
          // tl_files 테이블 방식 (신규)
          if (b.user_id && !b.id) {
            const result = await env.DB.prepare(
              'INSERT INTO tl_files (user_id,title,artist,genre,file_type,file_tl,max_file_tl,file_url) VALUES (?,?,?,?,?,?,?,?)'
            ).bind(b.user_id, b.title, b.artist, b.genre, b.type, b.file_tl||0, b.file_tl||0, b.url||null).run();
            return json({ success: true, trackId: result.meta.last_row_id });
          }
          // tracks 테이블 방식 (기존)
          if (!b.id || !b.title || !b.artist) return err('id, title, artist 필수');
          const exists = await env.DB.prepare('SELECT id FROM tracks WHERE id=?').bind(b.id).first();
          if (exists) {
            await env.DB.prepare('UPDATE tracks SET title=?,artist=?,genre=?,cover_image=?,duration=?,price_per_sec=?,auth_method=?,auth_status=?,shared=1,updated_at=? WHERE id=?')
              .bind(b.title, b.artist, b.genre||'기타', b.coverImage||null, b.duration||0, b.pricePerSec||1, b.authMethod||'manual', b.authStatus||'verified', Date.now(), b.id).run();
            return json({ ok: true, action: 'updated', id: b.id });
          }
          await env.DB.prepare('INSERT INTO tracks(id,title,artist,genre,cover_image,duration,price_per_sec,file_tl,creator_tl,auth_method,auth_status,username,pulse,shared,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,0,?,?,?,0,1,?,?)')
            .bind(b.id, b.title, b.artist, b.genre||'기타', b.coverImage||null, b.duration||0, b.pricePerSec||1, b.authMethod||'manual', b.authStatus||'verified', b.username||'unknown', Date.now(), Date.now()).run();
          return json({ ok: true, action: 'created', id: b.id });
        } catch(e) { return err(e.message, 500); }
      }

      if (path.startsWith('/api/tracks/') && method === 'DELETE') {
        const id = path.split('/')[3];
        try {
          await env.DB.prepare('DELETE FROM tracks WHERE id=?').bind(id).run();
          return json({ ok: true, deleted: id });
        } catch(e) { return err(e.message, 500); }
      }

      // 트랙 충전
      const chargeM = path.match(/^\/api\/tracks\/([^/]+)\/charge$/);
      if (chargeM && method === 'POST') {
        try {
          const { amount, username } = await request.json();
          const id = chargeM[1];
          const track = await env.DB.prepare('SELECT * FROM tracks WHERE id=?').bind(id).first();
          if (!track) return err('Track not found', 404);
          await env.DB.prepare('UPDATE tracks SET file_tl=file_tl+?,updated_at=? WHERE id=?').bind(amount, Date.now(), id).run();
          await env.DB.prepare('INSERT INTO tl_charges(track_id,amount,username,charged_at) VALUES(?,?,?,?)').bind(id, amount, username||'unknown', Date.now()).run();
          return json({ ok: true, file_tl: (track.file_tl||0) + amount });
        } catch(e) { return err(e.message, 500); }
      }

      // 재생 기록
      const playM = path.match(/^\/api\/tracks\/([^/]+)\/play$/);
      if (playM && method === 'POST') {
        try {
          const b = await request.json();
          const id = playM[1];
          const seconds = parseInt(b.seconds) || 1;
          const mode = b.mode || 'wallet';
          const track = await env.DB.prepare('SELECT * FROM tracks WHERE id=?').bind(id).first();
          if (!track) return err('Track not found', 404);
          const tlEarned = seconds * (track.price_per_sec || 1);
          const newCreator = (track.creator_tl||0) + tlEarned;
          const newPulse = (track.pulse||0) + seconds;
          let newFileTL = track.file_tl || 0;
          if (mode === 'file') newFileTL = Math.max(0, newFileTL - tlEarned);
          await env.DB.prepare('UPDATE tracks SET file_tl=?,creator_tl=?,pulse=?,updated_at=? WHERE id=?')
            .bind(newFileTL, newCreator, newPulse, Date.now(), id).run();
          await env.DB.prepare('INSERT INTO play_logs(track_id,username,seconds,mode,tl_used,played_at) VALUES(?,?,?,?,?,?)')
            .bind(id, b.username||'anonymous', seconds, mode, tlEarned, Date.now()).run();
          return json({ ok: true, file_tl: newFileTL, creator_tl: newCreator, pulse: newPulse });
        } catch(e) { return err(e.message, 500); }
      }

      // 스트리밍 URL
      const streamM = path.match(/^\/api\/stream\/([^/]+)$/);
      if (streamM && method === 'GET') {
        const track = await env.DB.prepare('SELECT id,stream_url FROM tracks WHERE id=?').bind(streamM[1]).first();
        if (!track) return err('Track not found', 404);
        if (!track.stream_url) return err('스트리밍 URL 없음', 404);
        return json({ url: track.stream_url });
      }

      // ══════════════════════════════════════════════════
      // 파일 업로드 (R2)
      // ══════════════════════════════════════════════════

      if (path === '/api/upload' && method === 'POST') {
        if (!env.R2) return err('R2 미설정', 500);
        const formData = await request.formData();
        const file = formData.get('file');
        const trackId = formData.get('trackId');
        if (!file || !trackId) return err('file, trackId 필수');
        if (file.size > 500 * 1024 * 1024) return err('500MB 초과');
        const ext = (file.name.split('.').pop() || 'mp3').toLowerCase();
        const key = `tracks/${trackId}.${ext}`;
        await env.R2.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { trackId, uploadedAt: Date.now().toString() }
        });
        const publicUrl = `https://pub-c8d04f598d434d2f9568c08938d892a7.r2.dev/${key}`;
        await env.DB.prepare('UPDATE tracks SET stream_url=?,updated_at=? WHERE id=?').bind(publicUrl, Date.now(), trackId).run();
        return json({ ok: true, url: publicUrl, key });
      }

      // ══════════════════════════════════════════════════
      // 지갑 API
      // ══════════════════════════════════════════════════

      if (path === '/api/wallet' && method === 'GET') {
        try {
          const userId = url.searchParams.get('userId');
          if (!userId) return err('userId 필수');
          const user = await env.DB.prepare('SELECT tl, tlc FROM users WHERE id=?').bind(userId).first();
          const exchanges = await env.DB.prepare('SELECT * FROM exchanges WHERE user_id=? ORDER BY created_at DESC LIMIT 10').bind(userId).all();
          return json({ tl: user?.tl||0, tlc: user?.tlc||0, exchanges: exchanges.results||[] });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/exchange' && method === 'POST') {
        try {
          const { user_id, amount, payment_method } = await request.json();
          await env.DB.prepare('UPDATE users SET tl=tl-? WHERE id=? AND tl>=?').bind(amount, user_id, amount).run();
          const result = await env.DB.prepare('INSERT INTO exchanges (user_id,amount,payment_method) VALUES (?,?,?)').bind(user_id, amount, payment_method).run();
          return json({ success: true, exchangeId: result.meta.last_row_id });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/recharge' && method === 'POST') {
        try {
          const { user_id, amount } = await request.json();
          await env.DB.prepare('UPDATE users SET tl=tl+? WHERE id=?').bind(amount, user_id).run();
          return json({ success: true });
        } catch(e) { return err(e.message, 500); }
      }

      // ══════════════════════════════════════════════════
      // Spotify 검색
      // ══════════════════════════════════════════════════

      if (path === '/api/spotify/search' && method === 'GET') {
        const q = url.searchParams.get('q');
        if (!q) return err('q 필수');
        if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return json({ tracks: [] });
        try {
          const token = await getSpotifyToken(env);
          const r = await fetch(
            'https://api.spotify.com/v1/search?q=' + encodeURIComponent(q) + '&type=track&limit=6&market=KR',
            { headers: { 'Authorization': 'Bearer ' + token } }
          );
          const d = await r.json();
          const tracks = (d.tracks?.items || []).map(t => ({
            id: t.id,
            title: t.name,
            name: t.name,
            artist: t.artists.map(a => a.name).join(', '),
            album: t.album?.name || '',
            albumName: t.album?.name || '',
            duration: Math.round(t.duration_ms / 1000),
            cover_url: t.album?.images?.[0]?.url || '',
            coverImage: t.album?.images?.[0]?.url || null,
            preview_url: t.preview_url || '',
            spotify_url: t.external_urls?.spotify || '',
            spotifyId: t.id,
            release_date: t.album?.release_date || ''
          }));
          return json({ tracks });
        } catch(e) { return json({ tracks: [], error: e.message }); }
      }

      // ══════════════════════════════════════════════════
      // AI 인증 API
      // ══════════════════════════════════════════════════

      if (path === '/api/ai-verify' && method === 'POST') {
        return json({ success: true, verified: true, reward: 1000, message: 'AI 인증 완료' });
      }

      // ══════════════════════════════════════════════════
      // 기여도(POC) API
      // ══════════════════════════════════════════════════

      if (path === '/api/activity' && method === 'POST') {
        try {
          const { user_id, type, metadata } = await request.json();
          const pointMap = {
            listen_minute: 1, upload: 100, like: 2,
            comment: 5, share: 3, ad_view: 10, report: -20, violation: -100
          };
          let points = pointMap[type] || 0;
          if (type === 'listen_minute' && metadata?.minutes) points = metadata.minutes * pointMap.listen_minute;

          await env.DB.prepare('INSERT INTO user_activities (user_id,activity_type,points,metadata) VALUES (?,?,?,?)')
            .bind(user_id, type, points, JSON.stringify(metadata)).run().catch(()=>{});
          await env.DB.prepare(`
            INSERT INTO user_poc (user_id,total_points,last_updated) VALUES (?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET total_points=total_points+excluded.total_points, last_updated=CURRENT_TIMESTAMP
          `).bind(user_id, points).run().catch(()=>{});
          if (points > 0) {
            const today = new Date().toISOString().slice(0,10);
            await env.DB.prepare(`
              INSERT INTO daily_stats (stat_date,user_id,points_earned) VALUES (?,?,?)
              ON CONFLICT(stat_date,user_id) DO UPDATE SET points_earned=points_earned+excluded.points_earned
            `).bind(today, user_id, points).run().catch(()=>{});
          }
          return json({ success: true, points });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/user-stats' && method === 'GET') {
        try {
          const user_id = url.searchParams.get('user_id');
          const period = url.searchParams.get('period') || 'week';
          if (!user_id) return err('user_id 필수');
          const start = new Date();
          if (period === 'day') start.setDate(start.getDate()-1);
          else if (period === 'week') start.setDate(start.getDate()-7);
          else if (period === 'month') start.setMonth(start.getMonth()-1);
          const startStr = start.toISOString().slice(0,10);
          const stats = await env.DB.prepare(
            'SELECT SUM(points_earned) as total_points, SUM(tlc_mined) as total_tlc, SUM(tl_used) as total_tl_used FROM daily_stats WHERE user_id=? AND stat_date>=?'
          ).bind(user_id, startStr).first().catch(()=>null);
          const poc = await env.DB.prepare('SELECT total_points FROM user_poc WHERE user_id=?').bind(user_id).first().catch(()=>null);
          return json({ period, stats: stats || { total_points:0, total_tlc:0, total_tl_used:0 }, total_points: poc?.total_points||0 });
        } catch(e) { return err(e.message, 500); }
      }

      if (path === '/api/ranking' && method === 'GET') {
        try {
          const type = url.searchParams.get('type') || 'tlc';
          const period = url.searchParams.get('period') || 'week';
          const limit = parseInt(url.searchParams.get('limit') || '10');
          const start = new Date();
          if (period === 'day') start.setDate(start.getDate()-1);
          else if (period === 'week') start.setDate(start.getDate()-7);
          else if (period === 'month') start.setMonth(start.getMonth()-1);
          const startStr = start.toISOString().slice(0,10);
          const col = type === 'tlc' ? 'tlc_mined' : 'points_earned';
          const rows = await env.DB.prepare(
            `SELECT user_id, SUM(${col}) as value FROM daily_stats WHERE stat_date>=? GROUP BY user_id ORDER BY value DESC LIMIT ?`
          ).bind(startStr, limit).all().catch(()=>({ results:[] }));
          return json(rows.results || []);
        } catch(e) { return err(e.message, 500); }
      }

      // ══════════════════════════════════════════════════
      // 어드민 API
      // ══════════════════════════════════════════════════

      if (path === '/api/admin/users' && method === 'GET') {
        try {
          const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 100').all();
          return json({ users: results || [] });
        } catch(e) { return json({ users: [] }); }
      }

      if (path === '/api/admin/stats' && method === 'GET') {
        try {
          const userCount  = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
          const trackCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE shared=1').first().catch(()=>({c:0}));
          const playCount  = await env.DB.prepare('SELECT COUNT(*) as c FROM play_logs').first().catch(()=>({c:0}));
          const tlSum      = await env.DB.prepare('SELECT SUM(amount) as s FROM tl_charges').first().catch(()=>({s:0}));
          return json({ users: userCount?.c||0, tracks: trackCount?.c||0, plays: playCount?.c||0, tl_charged: tlSum?.s||0 });
        } catch(e) { return json({ users:0, tracks:0, plays:0, tl_charged:0 }); }
      }

      // ══════════════════════════════════════════════════
      // SharePlace API (tl_shares 테이블)
      // ══════════════════════════════════════════════════

      // GET /api/shares — 인증 불필요
      if (path === '/api/shares' && method === 'GET') {
        if (!env.DB) return json({ shares: [] });
        try {
          const { results } = await env.DB.prepare(
            'SELECT * FROM tl_shares ORDER BY created_at DESC LIMIT 100'
          ).all();
          return json({ shares: results || [] });
        } catch(e) {
          return json({ shares: [], _note: e.message });
        }
      }

      // POST /api/shares — 인증 필요, 5000 TL 차감
      if (path === '/api/shares' && method === 'POST') {
        const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
        if (!auth) return err('인증 필요', 401);
        let userId, username;
        try {
          const p = parseToken(auth);
          userId = p.userId; username = p.username;
        } catch(e) { return err('토큰 오류: ' + e.message, 401); }

        if (!env.DB) return err('DB 없음', 503);
        const userRow = await env.DB.prepare('SELECT tl FROM users WHERE id=?').bind(userId).first().catch(()=>null);
        if (!userRow) return err('유저 없음', 404);
        if ((userRow.tl || 0) < 5000) return err('TL 부족 (필요: 5000, 현재: ' + userRow.tl + ')', 402);

        const body = await request.json();
        if (!body.title) return err('title 필요', 400);

        // tl_shares 테이블 없으면 자동 생성
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS tl_shares (
            id TEXT PRIMARY KEY, user_id TEXT, username TEXT,
            title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '',
            duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0,
            category TEXT DEFAULT 'Music', description TEXT DEFAULT '', plan TEXT DEFAULT 'A',
            spotify_id TEXT, spotify_url TEXT, cover_url TEXT, preview_url TEXT,
            pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL
          )
        `).run().catch(()=>{});

        await env.DB.prepare('UPDATE users SET tl=tl-5000 WHERE id=?').bind(userId).run();

        const id = 'sh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        await env.DB.prepare(`
          INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,category,description,plan,spotify_id,spotify_url,cover_url,preview_url,pulse,created_at)
          VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,0,?)
        `).bind(
          id, String(userId), username,
          body.title, body.artist||'', body.album||'',
          body.duration||0,
          body.category||'Music', body.description||'', body.plan||'A',
          body.spotify_id||null, body.spotify_url||null,
          body.cover_url||null, body.preview_url||null,
          Date.now()
        ).run();

        const updated = await env.DB.prepare('SELECT tl FROM users WHERE id=?').bind(userId).first();
        return json({ ok: true, id, tl_remaining: updated?.tl || 0 });
      }

      // GET /api/shares/:id
      const shareIdM = path.match(/^\/api\/shares\/([\w-]+)$/);
      if (shareIdM && method === 'GET') {
        const share = await env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareIdM[1]).first().catch(()=>null);
        if (!share) return err('Share 없음', 404);
        return json({ share });
      }

      // DELETE /api/shares/:id
      if (shareIdM && method === 'DELETE') {
        const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
        if (!auth) return err('인증 필요', 401);
        let userId;
        try { userId = parseToken(auth).userId; } catch(e) { return err('토큰 오류', 401); }
        await env.DB.prepare('DELETE FROM tl_shares WHERE id=? AND user_id=?').bind(shareIdM[1], String(userId)).run().catch(()=>{});
        return json({ ok: true });
      }

      // POST /api/shares/:id/pulse
      const pulseM = path.match(/^\/api\/shares\/([\w-]+)\/pulse$/);
      if (pulseM && method === 'POST') {
        try {
          await env.DB.prepare('UPDATE tl_shares SET pulse=pulse+1 WHERE id=?').bind(pulseM[1]).run();
          const row = await env.DB.prepare('SELECT pulse FROM tl_shares WHERE id=?').bind(pulseM[1]).first();
          return json({ ok: true, pulse: row?.pulse || 0 });
        } catch(e) { return json({ ok: true, pulse: 0 }); }
      }

      // ── 404 ───────────────────────────────────────────
      return err('Not Found', 404);

    } catch(e) {
      console.error('Worker error:', e.message);
      return err('Server Error: ' + e.message, 500);
    }
  }
};
