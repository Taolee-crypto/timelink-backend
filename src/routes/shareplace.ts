import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();


router.post('/', async (c) => {
  try {
    const auth=(c.req.header('Authorization')||'').replace(/^Bearer\\s+/,'').trim();
    if(!auth) return c.json({ok:false,error:'인증 필요'},401);
    const payload=await verifyToken(auth,c.env.JWT_SECRET);
    const userId=Number(payload?.sub||0);
    if(!userId) return c.json({ok:false,error:'인증 사용자 확인 불가'},401);
    const body=await c.req.json<any>().catch(()=>({}));
    const title=String(body.title||'').trim();
    if(!title) return c.json({ok:false,error:'title 필요'},400);
    const user=await c.env.DB.prepare('SELECT id,username,email FROM users WHERE id=?').bind(userId).first<any>();
    if(!user) return c.json({ok:false,error:'유저 없음'},404);
    await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS tl_shares (id TEXT PRIMARY KEY, user_id TEXT, username TEXT, title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '', duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0, category TEXT DEFAULT 'Music', file_type TEXT DEFAULT '', category_type TEXT DEFAULT '', description TEXT DEFAULT '', plan TEXT DEFAULT 'FREE', spotify_id TEXT, spotify_url TEXT, cover_url TEXT, preview_url TEXT, stream_url TEXT DEFAULT '', country TEXT DEFAULT 'KR', content_lang TEXT DEFAULT 'ko', pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL)").run();
    for(const sql of [
      "ALTER TABLE tl_shares ADD COLUMN price_per_sec REAL DEFAULT 1","ALTER TABLE tl_shares ADD COLUMN composer TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN lyricist TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN lyrics TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN release_mode TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN storage_mode TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN origin_hash TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN release_check TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN content_kind TEXT DEFAULT ''"
    ]) await c.env.DB.prepare(sql).run().catch(()=>{});
    const isFree=String(body.release_mode||'').startsWith('free_mp3');
    if(isFree){
      if(String(body.file_type||'').toLowerCase()!=='audio/mp3') return c.json({ok:false,error:'무료 공개는 MP3만 가능합니다.'},400);
      if(body.rights_confirmed!==true) return c.json({ok:false,error:'창작자 권리 확인이 필요합니다.'},400);
      if(String(body.release_check||'')==='spotify_match') return c.json({ok:false,error:'기출시 곡으로 확인되어 무료 공개할 수 없습니다.'},409);
      const hash=String(body.origin_hash||'').trim().toLowerCase();
      if(hash){ const same=await c.env.DB.prepare("SELECT id,title,artist FROM tl_shares WHERE lower(COALESCE(origin_hash,''))=? LIMIT 1").bind(hash).first<any>().catch(()=>null); if(same) return c.json({ok:false,error:'동일한 원본 파일이 이미 등록되어 있습니다.',existing:same},409); }
    }
    const id='sh_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    const fileTl=isFree?0:Number(body.file_tl||5000);
    await c.env.DB.prepare("INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,category,file_type,category_type,description,plan,spotify_id,spotify_url,cover_url,preview_url,stream_url,country,content_lang,pulse,created_at,price_per_sec,composer,lyricist,lyrics,release_mode,storage_mode,origin_hash,release_check,content_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,String(userId),String(user.username||'User'),title,String(body.artist||''),String(body.album||''),Number(body.duration||0),fileTl,String(body.category||'Music'),String(body.file_type||''),String(body.category_type||''),String(body.description||''),String(body.plan||'FREE'),body.spotify_id||null,body.spotify_url||null,body.cover_url||null,body.preview_url||null,String(body.stream_url||''),String(body.country||'KR'),String(body.content_lang||'ko'),0,Date.now(),Number(body.price_per_sec||1),String(body.composer||''),String(body.lyricist||''),String(body.lyrics||''),String(body.release_mode||''),String(body.storage_mode||''),String(body.origin_hash||''),String(body.release_check||''),isFree?'mp3':'tl3').run();
    return c.json({ok:true,id,content_kind:isFree?'mp3':'tl3'});
  } catch(e:any) { console.error('SharePlace POST error:',e); return c.json({ok:false,error:e?.message||'등록 실패'},500); }
});

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
  const legacy = (rows.results||[]) as any[];
  let modern:any[]=[];
  try {
    const modernRows=await c.env.DB.prepare(`SELECT s.*, u.username FROM tl_shares s JOIN users u ON CAST(s.user_id AS INTEGER)=u.id WHERE 1=1 ORDER BY s.pulse DESC, s.created_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all();
    modern=(modernRows.results||[]).map((s:any)=>({
      ...s,
      id:s.id,
      user_id:Number(s.user_id),
      creator:s.username,
      file_type:s.file_type||'audio/mp3',
      stream_url:s.stream_url||'',
      shared:1,
      auth_status:'verified',
      revenue_held:0,
      content_kind:s.content_kind||'mp3'
    }));
  } catch(e) { console.error('tl_shares list error:',e); }
  return c.json([...modern,...legacy]);
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
