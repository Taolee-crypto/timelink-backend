import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { getD1ObjectMeta, readD1Range } from '../d1-storage';

const router = new Hono<{ Bindings: Env }>();

// Register only an already verified, creator-owned TL3 asset. MP3 remains a private source Asset.
router.post('/', async (c) => {
  try {
    const auth = (c.req.header('Authorization') || '').replace(/^Bearer\\s+/, '').trim();
    if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
    const payload = await verifyToken(auth, c.env.JWT_SECRET);
    const userId = Number(payload?.sub || 0);
    if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ ok: false, error: '인증 사용자 확인 불가' }, 401);

    const body = await c.req.json<any>().catch(() => ({}));
    const title = String(body.title || '').trim();
    if (!title) return c.json({ ok: false, error: 'title required' }, 400);
    const user = await c.env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
      .bind(userId).first<any>();
    if (!user) return c.json({ ok: false, error: '사용자 없음' }, 404);

    await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS tl_shares (id TEXT PRIMARY KEY, user_id TEXT, username TEXT, title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '', duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0, category TEXT DEFAULT 'Music', file_type TEXT DEFAULT '', category_type TEXT DEFAULT '', description TEXT DEFAULT '', plan TEXT DEFAULT 'FREE', spotify_id TEXT, spotify_url TEXT, cover_url TEXT, preview_url TEXT, stream_url TEXT DEFAULT '', country TEXT DEFAULT 'KR', content_lang TEXT DEFAULT 'ko', pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL)").run();
    for (const sql of [
      "ALTER TABLE tl_shares ADD COLUMN price_per_sec REAL DEFAULT 1",
      "ALTER TABLE tl_shares ADD COLUMN composer TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN lyricist TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN lyrics TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN release_mode TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN storage_mode TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN origin_hash TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN release_check TEXT DEFAULT ''",
      "ALTER TABLE tl_shares ADD COLUMN content_kind TEXT DEFAULT ''"
    ]) await c.env.DB.prepare(sql).run().catch(() => {});

    const releaseMode = String(body.release_mode || '').toLowerCase();
    const fileType = String(body.file_type || '').toLowerCase();
    if (fileType === 'audio/mp3' || fileType === 'audio/mpeg' || releaseMode.startsWith('free_mp3')) {
      return c.json({ ok: false, error: 'MP3 원본은 비공개 소스 자산입니다. TL3로 변환한 뒤 공유해 주세요.' }, 400);
    }
    if(releaseMode!=='tl3'||fileType!=='audio/tl3'){
      return c.json({ ok: false, error: '정식 TL3 디지털 자산만 공유할 수 있습니다.' }, 400);
    }
    if(body.rights_confirmed!==true) return c.json({ ok: false, error: '창작자 권리 확인이 필요합니다.' }, 400);

    const streamUrl = String(body.stream_url || '').trim();
    let storageKey = streamUrl;
    if (streamUrl.includes('/api/storage/')) {
      storageKey = decodeURIComponent(streamUrl.split('/api/storage/')[1].split('?')[0]);
    }
    const ownedKey = storageKey.match(/^tracks\/u(\d+)\/[A-Za-z0-9_-]{1,160}\.tl3$/i);
    if (!ownedKey || Number(ownedKey[1]) !== userId) {
      return c.json({ ok: false, error: 'TL3 저장 자산의 소유권을 확인할 수 없습니다.' }, 403);
    }
    const stored = await getD1ObjectMeta(c.env.DB, storageKey);
    if (!stored) return c.json({ ok: false, error: '완료된 TL3 저장 자산을 찾을 수 없습니다.' }, 404);
    const prefix = await readD1Range(c.env.DB, storageKey, 0, Math.min(stored.size, 9));
    if (prefix.byteLength < 9 || prefix[0] !== 0x54 || prefix[1] !== 0x4c || prefix[2] !== 0x4e || prefix[3] !== 0x4b || prefix[4] !== 0x03) {
      return c.json({ ok: false, error: '유효한 TL3 v3 컨테이너가 아닙니다.' }, 400);
    }
    const headerLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(5, false);
    if (headerLength <= 0 || 9 + headerLength > stored.size) {
      return c.json({ ok: false, error: 'TL3 메타데이터가 손상되었습니다.' }, 400);
    }
    const headerBytes = await readD1Range(c.env.DB, storageKey, 9, headerLength);
    let header: any;
    try {
      header = JSON.parse(new TextDecoder().decode(headerBytes));
    } catch {
      return c.json({ ok: false, error: 'TL3 메타데이터 JSON이 올바르지 않습니다.' }, 400);
    }
    if (String(header.cid || '') !== String(userId)) {
      return c.json({ ok: false, error: 'TL3 창작자 ID가 로그인 사용자와 일치하지 않습니다.' }, 403);
    }

    const approvedFile = await c.env.DB.prepare(
      "SELECT f.id FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id WHERE f.user_id = ? AND LOWER(f.file_type) = 'audio/tl3' AND f.stream_url = ? AND f.shared = 1 AND COALESCE(f.revenue_held, 0) = 0 AND r.status='released' AND r.rights_confirmed=1 LIMIT 1"
    ).bind(userId, streamUrl).first<any>();
    if (!approvedFile) {
      return c.json({ ok: false, error: '창작자 권리 확인을 마친 TL3 자산을 먼저 발행해야 합니다.' }, 403);
    }

    const hash = String(body.origin_hash || '').trim().toLowerCase();
    if (hash) {
      const same = await c.env.DB.prepare(
        "SELECT id, title, artist FROM tl_shares WHERE lower(COALESCE(origin_hash, '')) = ? LIMIT 1"
      ).bind(hash).first<any>().catch(() => null);
      if (same) return c.json({ ok: false, error: '동일한 원본 자산이 이미 등록되어 있습니다.', existing: same }, 409);
    }

    const id = 'sh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const fileTl = Math.max(1, Math.floor(Number(body.file_tl || 5000)));
    await c.env.DB.prepare(
      "INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,category,file_type,category_type,description,plan,spotify_id,spotify_url,cover_url,preview_url,stream_url,country,content_lang,pulse,created_at,price_per_sec,composer,lyricist,lyrics,release_mode,storage_mode,origin_hash,release_check,content_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id, String(userId), String(user.username || 'User'), title, String(body.artist || ''),
      String(body.album || ''), Number(body.duration || 0), fileTl, String(body.category || 'Music'),
      'audio/tl3', String(body.category_type || ''), String(body.description || ''),
      String(body.plan || 'FREE'), body.spotify_id || null, body.spotify_url || null,
      body.cover_url || null, body.preview_url || null, streamUrl, String(body.country || 'KR'),
      String(body.content_lang || 'ko'), 0, Date.now(), Number(body.price_per_sec || 1),
      String(body.composer || ''), String(body.lyricist || ''), String(body.lyrics || ''),
      'tl3', String(body.storage_mode || ''), hash, String(body.release_check || ''), 'tl3'
    ).run();

    return c.json({ ok: true, id, content_kind: 'tl3' });
  } catch (e: any) {
    console.error('SharePlace POST error:', e);
    return c.json({ ok: false, error: e?.message || '등록 실패' }, 500);
  }
});

// GET / - SharePlace catalogue: expose only verified TL3 releases; never return provider/source URLs.
router.get('/', async (c) => {
  const genre = c.req.query('genre');
  const sort = c.req.query('sort') || 'pulse';
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 20)));
  const offset = Math.max(0, Number(c.req.query('offset') || 0));
  const orderCol = sort === 'new' ? 'f.created_at' : sort === 'tl' ? 'f.file_tl' : 'f.pulse';

  // SharePlace shows V4 only when the matching TL3 Spine release was actually sealed.
  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_spine_v4_releases (
    file_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, share_id TEXT NOT NULL,
    object_key TEXT NOT NULL, header_json TEXT NOT NULL, segment_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL, spine_root TEXT NOT NULL, spine_latest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sealed', created_at TEXT DEFAULT (datetime('now'))
  )`).run();

  let query = `SELECT f.id, f.user_id, u.username, f.title, f.artist, f.genre,
    f.file_type,
    COALESCE((SELECT CAST((r.duration_ms+999)/1000 AS INTEGER) FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.duration_ms>0 ORDER BY r.updated_at DESC LIMIT 1),NULLIF(f.duration_seconds,0),NULLIF(f.file_tl,0),0) AS required_file_tl,
    COALESCE((SELECT CAST((r.duration_ms+999)/1000 AS INTEGER) FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.duration_ms>0 ORDER BY r.updated_at DESC LIMIT 1),NULLIF(f.duration_seconds,0),0) AS duration_seconds,
    f.cover_image, f.pulse,
    f.play_count, f.created_at,
    (SELECT sv.status FROM tl3_spine_v4_releases sv
      WHERE sv.file_id=f.id AND sv.status='sealed' LIMIT 1) AS spine_v4_status,
    (SELECT c.cert_no FROM tl_asset_certs c
      JOIN tl_assets a ON a.asset_id = c.asset_id
      WHERE a.file_id = f.id AND c.status = 'active' LIMIT 1) AS cert_no
    FROM tl_files f JOIN users u ON f.user_id = u.id
    WHERE LOWER(f.file_type)='audio/tl3'
      AND f.shared=1 AND COALESCE(f.revenue_held,0)=0
      AND EXISTS (SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.rights_confirmed=1)`;
  const params: (string | number)[] = [];
  if (genre) { query += ' AND f.genre = ?'; params.push(genre); }
  query += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const legacyRows = await c.env.DB.prepare(query).bind(...params).all();
  const origin = new URL(c.req.url).origin;
  const legacy = ((legacyRows.results || []) as any[]).map((f: any) => ({
    id: String(f.id), user_id: Number(f.user_id || 0),
    username: String(f.username || 'User'), creator: String(f.username || 'User'),
    title: String(f.title || ''), artist: String(f.artist || ''),
    duration: Number(f.duration_seconds || 0), file_tl: Number(f.required_file_tl || 0),
    category: String(f.genre || 'Music'), file_type: 'audio/tl3',
    cover_url: f.cover_image || null, pulse: Number(f.pulse || 0),
    play_count: Number(f.play_count || 0), created_at: f.created_at,
    content_kind: 'tl3', shared: 1, auth_status: 'verified',
    stream_url: origin + '/api/legacy-stream/' + encodeURIComponent(String(f.id)),
    source_table: 'tl_file', cert_no: f.cert_no || null,
    spine_v4_status: f.spine_v4_status || null
  }));

  let modern: any[] = [];
  try {
    const modernRows = await c.env.DB.prepare(`
      SELECT s.id, s.user_id, u.username, s.title, s.artist, s.album,
        COALESCE((SELECT CAST((r.duration_ms+999)/1000 AS INTEGER) FROM tl3_releases r WHERE r.share_id=CAST(s.id AS TEXT) AND r.status='released' AND r.duration_ms>0 ORDER BY r.updated_at DESC LIMIT 1),NULLIF(s.duration,0),0) AS duration,
        COALESCE((SELECT CAST((v5.duration_ms+999)/1000 AS INTEGER) FROM tl3_v5_releases v5 WHERE v5.share_id=CAST(s.id AS TEXT) AND v5.status='sealed' ORDER BY v5.updated_at DESC LIMIT 1),
          (SELECT CAST((r.duration_ms+999)/1000 AS INTEGER) FROM tl3_releases r WHERE r.share_id=CAST(s.id AS TEXT) AND r.status='released' AND r.duration_ms>0 ORDER BY r.updated_at DESC LIMIT 1),NULLIF(s.duration,0),0) AS duration,
        COALESCE((SELECT CAST((v5.duration_ms+999)/1000 AS INTEGER) FROM tl3_v5_releases v5 WHERE v5.share_id=CAST(s.id AS TEXT) AND v5.status='sealed' ORDER BY v5.updated_at DESC LIMIT 1),
          (SELECT COALESCE(NULLIF(r.price_tl,0),CAST((r.duration_ms+999)/1000 AS INTEGER)) FROM tl3_releases r WHERE r.share_id=CAST(s.id AS TEXT) AND r.status='released' AND r.duration_ms>0 ORDER BY r.updated_at DESC LIMIT 1),NULLIF(s.duration,0),NULLIF(s.file_tl,0),0) AS file_tl,
        (SELECT v5.file_id FROM tl3_v5_releases v5 WHERE v5.share_id=CAST(s.id AS TEXT) AND v5.status='sealed' ORDER BY v5.updated_at DESC LIMIT 1) AS v5_file_id,
        (SELECT v5.status FROM tl3_v5_releases v5 WHERE v5.share_id=CAST(s.id AS TEXT) AND v5.status='sealed' ORDER BY v5.updated_at DESC LIMIT 1) AS v5_status,
        s.category, s.category_type, s.description,
        s.plan, s.cover_url, s.country, s.content_lang, s.pulse, s.created_at,
        s.composer, s.lyricist, s.lyrics, s.release_mode, s.content_kind,
        (SELECT sv.status FROM tl3_spine_v4_releases sv
          JOIN tl_files vf ON vf.id=sv.file_id
          WHERE sv.share_id=CAST(s.id AS TEXT) AND sv.status='sealed' LIMIT 1) AS spine_v4_status
      FROM tl_shares s
      JOIN users u ON CAST(s.user_id AS INTEGER) = u.id
      WHERE EXISTS (
        SELECT 1 FROM tl_files f
        WHERE LOWER(f.file_type)='audio/tl3'
          AND f.shared=1 AND COALESCE(f.revenue_held,0)=0
          AND (
            f.stream_url=s.stream_url
            OR EXISTS (SELECT 1 FROM tl3_spine_v4_releases sv WHERE sv.file_id=f.id AND sv.share_id=CAST(s.id AS TEXT) AND sv.status='sealed')
          )
          AND (
            EXISTS (SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.rights_confirmed=1)
            OR EXISTS (SELECT 1 FROM tl3_v5_releases v5 WHERE v5.file_id=f.id AND v5.share_id=CAST(s.id AS TEXT) AND v5.status='sealed')
          )
      )
      ORDER BY s.pulse DESC, s.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();
    modern = ((modernRows.results || []) as any[]).map((s: any) => ({
      id: String(s.id), user_id: Number(s.user_id || 0),
      username: String(s.username || 'User'), creator: String(s.username || 'User'),
      title: String(s.title || ''), artist: String(s.artist || ''),
      album: String(s.album || ''), duration: Number(s.duration || 0),
      file_tl: Number(s.file_tl || 0), category: String(s.category || 'Music'),
      category_type: String(s.category_type || ''), description: String(s.description || ''),
      plan: String(s.plan || 'FREE'), cover_url: s.cover_url || null,
      country: String(s.country || 'KR'), content_lang: String(s.content_lang || 'ko'),
      pulse: Number(s.pulse || 0), created_at: s.created_at,
      composer: String(s.composer || ''), lyricist: String(s.lyricist || ''),
      lyrics: String(s.lyrics || ''), release_mode: 'tl3', content_kind: 'tl3',
      file_type: 'audio/tl3', shared: 1, auth_status: 'verified',
      stream_url: origin + '/api/stream/' + encodeURIComponent(String(s.id)),
      source_table: 'share', spine_v4_status: s.spine_v4_status || null,
      spine_v5_status: s.v5_status || null, player_version: s.v5_status === 'sealed' ? 5 : (s.spine_v4_status === 'sealed' ? 4 : 3),
      file_id: s.v5_file_id == null ? null : Number(s.v5_file_id), share_id: String(s.id)
    }));
  } catch (e) {
    console.error('tl_shares list error:', e);
  }
  return c.json([...modern, ...legacy]);
});

// GET /contributor-ranking
router.get('/contributor-ranking', async (c) => {
  const period = c.req.query('period') || 'weekly';
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 20)));
  let dateFilter = '';
  if (period === 'weekly') dateFilter = "AND f.updated_at >= datetime('now', '-7 days')";
  else if (period === 'monthly') dateFilter = "AND f.updated_at >= datetime('now', '-30 days')";
  const query = `
    SELECT f.user_id, u.username, u.poc_index, u.false_dispute_strikes,
      u.account_forfeited, SUM(f.revenue) AS total_revenue,
      SUM(f.pulse) AS total_pulse, SUM(f.play_count) AS total_plays,
      COUNT(f.id) AS verified_tracks
    FROM tl_files f JOIN users u ON f.user_id = u.id
    WHERE LOWER(f.file_type)='audio/tl3'
      AND f.auth_status = 'verified' AND f.shared = 1
      AND COALESCE(f.revenue_held, 0) = 0 ${dateFilter}
    GROUP BY f.user_id ORDER BY total_pulse DESC LIMIT ?`;
  const rows = await c.env.DB.prepare(query).bind(limit).all();
  const results = ((rows.results || []) as any[]).map((r: any, i: number) => ({ ...r, rank: i + 1 }));
  return c.json(results);
});

export default router;
