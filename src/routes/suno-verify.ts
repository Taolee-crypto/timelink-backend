import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

function parseTokenUserId(token: string): number {
  if (!token) return 0;
  const m = token.match(/(?:token|fallback)_(\d+)/);
  if (m) return Number(m[1]);
  try { const p = JSON.parse(atob(token.split('.')[1])); return Number(p.userId || p.id || p.sub || 0); }
  catch { return 0; }
}

router.post('/verify-plan', async (c) => {
  const token  = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ ok: false, reason: '로그인이 필요합니다.' }, 401);
  const form = await c.req.parseBody({ limit: 10 * 1024 * 1024 });
  const file = form['screenshot'] as File | null;
  if (!file) return c.json({ ok: false, reason: '이미지 파일이 없습니다.' }, 400);
  const buffer = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mediaType = (file.type as 'image/png' | 'image/jpeg' | 'image/webp');
  const ANTHROPIC_KEY = (c.env as any).ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) return c.json({ ok: false, reason: 'AI 키 없음' }, 500);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }, { type: 'text', text: 'Read this Suno account screenshot. Return ONLY valid JSON:\n{"plan":"plan name","credits":"number or null"}' }] }] })
    });
    const data = await res.json() as any;
    const text = (data?.content?.[0]?.text || '{}').replace(/json|/g, '').trim();
    const parsed = JSON.parse(text);
    const planLower = (parsed.plan || '').toLowerCase();
    const isAllowed = planLower.includes('pro') || planLower.includes('premier');
    if (!isAllowed) return c.json({ ok: false, plan: parsed.plan, reason: (parsed.plan || '알 수 없음') + ' 플랜은 권한이 없습니다.' });
    await c.env.DB.prepare('INSERT INTO suno_verifications (user_id,plan,end_date,credits,verified_at,expires_at) VALUES (?,?,null,?,datetime(\'now\'),date(\'now\',\'+35 days\')) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,credits=excluded.credits,verified_at=excluded.verified_at,expires_at=excluded.expires_at').bind(userId, parsed.plan, parsed.credits).run();
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_badges (user_id,badge,granted_at) VALUES (?,\'suno_verified\',datetime(\'now\'))').bind(userId).run().catch(()=>{});
    await c.env.DB.prepare('UPDATE users SET tl=COALESCE(tl,0)+100,tl_p=COALESCE(tl_p,tl,0)+100 WHERE id=?').bind(userId).run();
    return c.json({ ok: true, plan: parsed.plan, credits: parsed.credits });
  } catch (e: any) { return c.json({ ok: false, reason: 'AI 분석 오류: ' + e.message }, 500); }
});

router.get('/status', async (c) => {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ verified: false });
  try {
    const row = await c.env.DB.prepare('SELECT plan,credits,expires_at FROM suno_verifications WHERE user_id=?').bind(userId).first<any>();
    if (!row) return c.json({ verified: false });
    const expired = row.expires_at && new Date(row.expires_at) <= new Date();
    return c.json({ verified: !expired, plan: row.plan, credits: row.credits });
  } catch { return c.json({ verified: false }); }
});

router.post('/register-track', async (c) => {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  if (!userId) return c.json({ error: '로그인 필요' }, 401);
  try {
    const body = await c.req.json() as any;
    const tl3Id = 'tl3_' + Date.now();
    await c.env.DB.prepare('CREATE TABLE IF NOT EXISTS tl3_sources (id TEXT PRIMARY KEY,user_id INTEGER,title TEXT,artist TEXT,prompt TEXT,style TEXT,lyrics TEXT,spotify_url TEXT,isrc TEXT,audio_features TEXT,anonymous INTEGER DEFAULT 0,tl_reward INTEGER DEFAULT 0,registered_at TEXT DEFAULT (datetime(\'now\')))').run().catch(()=>{});
    const reward = 200 + (body.spotifyUrl?200:0) + ((body.lyrics?.length>50)?50:0) + ((body.prompt?.length>30)?50:0);
    await c.env.DB.prepare('INSERT INTO tl3_sources (id,user_id,title,artist,prompt,style,lyrics,spotify_url,isrc,audio_features,anonymous,tl_reward) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(tl3Id,userId,body.title,body.artist||'',body.prompt||'',body.style||'',body.lyrics||'',body.spotifyUrl||'',body.isrc||'',JSON.stringify(body.spotifyData||{}),body.anonymous?1:0,reward).run();
    await c.env.DB.prepare('UPDATE users SET tl=COALESCE(tl,0)+?,tl_p=COALESCE(tl_p,tl,0)+? WHERE id=?').bind(reward,reward,userId).run();
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_badges (user_id,badge,granted_at) VALUES (?,\'spotify_creator\',datetime(\'now\'))').bind(userId).run().catch(()=>{});
    return c.json({ ok: true, tl3Id, tlReward: reward });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

router.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const songId: string = body.song_id || extractSunoId(body.song_url || '');
  if (!songId) return c.json({ error: '유효한 song_id 또는 song_url이 필요합니다.' }, 400);
  try {
    await ensureSunoMetaTable(c.env.DB);
    const cached = await c.env.DB.prepare('SELECT * FROM suno_meta_cache WHERE song_id=? AND cached_at > datetime(\'now\',\'-1 day\')').bind(songId).first<any>().catch(() => null);
    if (cached) return c.json({ ok: true, cached: true, title: cached.title, artist: cached.artist, duration: cached.duration, genre: cached.genre, image_url: cached.image_url, audio_url: cached.audio_url });
    const meta = await fetchSunoMeta(songId);
    if (!meta) return c.json({ error: 'Suno에서 곡 정보를 가져올 수 없습니다. 공개 곡인지 확인하세요.' }, 404);
    await c.env.DB.prepare('INSERT INTO suno_meta_cache (song_id,title,artist,duration,genre,tags,image_url,audio_url,cached_at) VALUES (?,?,?,?,?,?,?,?,datetime(\'now\')) ON CONFLICT(song_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,duration=excluded.duration,genre=excluded.genre,tags=excluded.tags,image_url=excluded.image_url,audio_url=excluded.audio_url,cached_at=excluded.cached_at').bind(songId,meta.title||'',meta.artist||'',meta.duration||0,meta.genre||'',meta.tags||'',meta.image_url||'',meta.audio_url||'').run().catch(()=>{});
    return c.json({ ok: true, cached: false, ...meta });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

router.get('/meta', async (c) => {
  const songId = c.req.query('id') || '';
  if (!songId) return c.json({ error: 'id 파라미터 필요' }, 400);
  try {
    await ensureSunoMetaTable(c.env.DB);
    const cached = await c.env.DB.prepare('SELECT * FROM suno_meta_cache WHERE song_id=? AND cached_at > datetime(\'now\',\'-1 day\')').bind(songId).first<any>().catch(() => null);
    if (cached) return c.json(cached);
    const meta = await fetchSunoMeta(songId);
    if (!meta) return c.json({ error: '곡 정보 없음' }, 404);
    return c.json(meta);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

async function fetchSunoMeta(songId: string): Promise<Record<string,any>|null> {
  const endpoints = [
    'https://studio-api.suno.ai/api/feed/?ids=' + songId,
    'https://suno.com/api/clip/' + songId,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://suno.com/' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const raw = await res.json() as any;
      const clip = Array.isArray(raw) ? raw[0] : (raw?.clips?.[0] || raw);
      if (!clip) continue;
      const title    = clip.title || clip.display_name || '';
      const artist   = clip.display_name || clip.handle || clip?.user?.handle || 'Suno Creator';
      const duration = Math.round(clip.duration || clip.audio_duration || 0);
      const image_url = clip.image_url || clip.image_large_url || '';
      const audio_url = clip.audio_url || clip.cdn_url || '';
      const tags      = (clip?.metadata?.tags || clip.tags || '').toString();
      const genre     = tags.split(',')[0]?.trim() || 'Music';
      if (!title && !audio_url) continue;
      return { song_id: songId, title, artist, duration, genre, tags, image_url, audio_url };
    } catch { continue; }
  }
  return null;
}

function extractSunoId(url: string): string {
  const m = url.match(/suno\.com\/(?:song|track)\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

async function ensureSunoMetaTable(db: any): Promise<void> {
  await db.prepare('CREATE TABLE IF NOT EXISTS suno_meta_cache (song_id TEXT PRIMARY KEY, title TEXT DEFAULT \'\', artist TEXT DEFAULT \'\', duration INTEGER DEFAULT 0, genre TEXT DEFAULT \'\', tags TEXT DEFAULT \'\', image_url TEXT DEFAULT \'\', audio_url TEXT DEFAULT \'\', cached_at TEXT DEFAULT (datetime(\'now\')))').run().catch(() => {});
}

export default router;
