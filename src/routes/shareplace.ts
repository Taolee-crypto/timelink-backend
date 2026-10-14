import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { getD1ObjectMeta } from '../d1-storage';

const router = new Hono<{ Bindings: Env }>();


router.post('/', async (c) => {
  try {
    const auth=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
    if(!auth) return c.json({ok:false,error:'?�증 ?�요'},401);
    const payload=await verifyToken(auth,c.env.JWT_SECRET);
    const userId=Number(payload?.sub||0);
    if(!userId) return c.json({ok:false,error:'?�증 ?�용???�인 불�?'},401);
    const body=await c.req.json<any>().catch(()=>({}));
    const title=String(body.title||'').trim();
    if(!title) return c.json({ok:false,error:'title ?�요'},400);
    const user=await c.env.DB.prepare('SELECT id,username,email FROM users WHERE id=?').bind(userId).first<any>();
    if(!user) return c.json({ok:false,error:'?��? ?�음'},404);
    await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS tl_shares (id TEXT PRIMARY KEY, user_id TEXT, username TEXT, title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '', duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0, category TEXT DEFAULT 'Music', file_type TEXT DEFAULT '', category_type TEXT DEFAULT '', description TEXT DEFAULT '', plan TEXT DEFAULT 'FREE', spotify_id TEXT, spotify_url TEXT, cover_url TEXT, preview_url TEXT, stream_url TEXT DEFAULT '', country TEXT DEFAULT 'KR', content_lang TEXT DEFAULT 'ko', pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL)").run();
    for(const sql of [
      "ALTER TABLE tl_shares ADD COLUMN price_per_sec REAL DEFAULT 1","ALTER TABLE tl_shares ADD COLUMN composer TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN lyricist TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN lyrics TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN release_mode TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN storage_mode TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN origin_hash TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN release_check TEXT DEFAULT ''","ALTER TABLE tl_shares ADD COLUMN content_kind TEXT DEFAULT ''"
    ]) await c.env.DB.prepare(sql).run().catch(()=>{});
    const releaseMode=String(body.release_mode||'').toLowerCase();
    const fileType=String(body.file_type||'').toLowerCase();
    if(releaseMode.startsWith('free_mp3')||fileType==='audio/mp3'||fileType==='audio/mpeg')
      return c.json({ok:false,error:'MP3 원본은 비공개 소스 자산입니다. TL3로 변환한 뒤 공유해 주세요.'},400);
    if(releaseMode!=='tl3'||fileType!=='audio/tl3')
      return c.json({ok:false,error:'정식 TL3 디지털 자산만 공유할 수 있습니다.'},400);
    if(body.rights_confirmed!==true)return c.json({ok:false,error:'창작자 권리 확인이 필요합니다.'},400);
    const streamUrl=streamUrl.trim();
    let storageKey=streamUrl;
    if(streamUrl.includes('/api/storage/'))storageKey=decodeURIComponent(streamUrl.split('/api/storage/')[1].split('?')[0]);
    const ownedKey=storageKey.match(/^tracks\\/u(\\d+)\\/[A-Za-z0-9_-]{1,160}\\.tl3$/i);
    if(!ownedKey||Number(ownedKey[1])!==userId)return c.json({ok:false,error:'TL3 저장 자산의 소유권을 확인할 수 없습니다.'},403);
    const stored=await getD1ObjectMeta(c.env.DB,storageKey);
    if(!stored)return c.json({ok:false,error:'완료된 TL3 저장 자산을 찾을 수 없습니다.'},404);
    const hash=String(body.origin_hash||'').trim().toLowerCase();
    if(hash){const same=await c.env.DB.prepare("SELECT id,title,artist FROM tl_shares WHERE lower(COALESCE(origin_hash,''))=? LIMIT 1").bind(hash).first<any>().catch(()=>null);if(same)return c.json({ok:false,error:'동일한 원본 자산이 이미 등록되어 있습니다.',existing:same},409);}
    const id='sh_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    const fileTl=Number(body.file_tl||5000);
    await c.env.DB.prepare("INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,category,file_type,category_type,description,plan,spotify_id,spotify_url,cover_url,preview_url,stream_url,country,content_lang,pulse,created_at,price_per_sec,composer,lyricist,lyrics,release_mode,storage_mode,origin_hash,release_check,content_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,String(userId),String(user.username||'User'),title,String(body.artist||''),String(body.album||''),Number(body.duration||0),fileTl,String(body.category||'Music'),String(body.file_type||''),String(body.category_type||''),String(body.description||''),String(body.plan||'FREE'),body.spotify_id||null,body.spotify_url||null,body.cover_url||null,body.preview_url||null,String(body.stream_url||''),String(body.country||'KR'),String(body.content_lang||'ko'),0,Date.now(),Number(body.price_per_sec||1),String(body.composer||''),String(body.lyricist||''),String(body.lyrics||''),String(body.release_mode||''),String(body.storage_mode||''),String(body.origin_hash||''),String(body.release_check||''),'tl3').run();
    // Registration alone never grants POC. Only verified contribution events may reach the canonical ledger.
    return c.json({ok:true,id,content_kind:'tl3'});
  } catch(e:any) { console.error('SharePlace POST error:',e); return c.json({ok:false,error:e?.message||'?�록 ?�패'},500); }
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
    WHERE LOWER(f.file_type) = 'audio/tl3' AND f.auth_status = 'verified' AND f.shared = 1 AND f.revenue_held = 0`;
  const params: (string | number)[] = [];

  if (genre) { query += ' AND f.genre = ?'; params.push(genre); }
  if (fileType) { query += ' AND f.file_type = ?'; params.push(fileType); }

  const orderCol = sort === 'new' ? 'f.created_at' : sort === 'tl' ? 'f.file_tl' : 'f.pulse';
  query += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  const origin=new URL(c.req.url).origin;
  const legacy=((rows.results||[]) as any[]).map((f:any)=>({
    id:String(f.id),user_id:Number(f.user_id||0),username:String(f.username||'User'),creator:String(f.username||'User'),
    title:String(f.title||''),artist:String(f.artist||''),album:'',duration:Number(f.duration_seconds||0),
    file_tl:Number(f.file_tl||0),category:String(f.genre||'Music'),file_type:String(f.file_type||''),
    category_type:'',description:'',plan:'A',cover_url:f.cover_image||null,
    pulse:Number(f.pulse||0),play_count:Number(f.play_count||0),created_at:f.created_at,
    content_kind:'tl3',shared:1,auth_status:'verified',revenue_held:0,
    stream_url:origin+'/api/legacy-stream/'+encodeURIComponent(String(f.id)),source_table:'tl_file'
  }));
  let modern:any[]=[];
  try {
    const modernRows=await c.env.DB.prepare(`SELECT s.*, u.username FROM tl_shares s JOIN users u ON CAST(s.user_id AS INTEGER)=u.id WHERE EXISTS (SELECT 1 FROM tl_files f WHERE f.file_url=s.stream_url AND LOWER(f.file_type)='audio/tl3' AND f.auth_status='verified' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0) ORDER BY s.pulse DESC, s.created_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all();
    modern=(modernRows.results||[]).map((share:any)=>({
      id:String(share.id),user_id:Number(share.user_id||0),username:String(share.username||'User'),creator:String(share.username||'User'),
      title:String(share.title||''),artist:String(share.artist||''),album:String(share.album||''),duration:Number(share.duration||0),
      file_tl:Number(share.file_tl||0),category:String(share.category||'Music'),file_type:String(share.file_type||''),
      category_type:String(share.category_type||''),description:String(share.description||''),plan:String(share.plan||'FREE'),
      spotify_id:share.spotify_id||null,spotify_url:share.spotify_url||null,cover_url:share.cover_url||null,
      country:String(share.country||'KR'),content_lang:String(share.content_lang||'ko'),pulse:Number(share.pulse||0),
      created_at:share.created_at,content_kind:share.content_kind||'tl3',shared:1,auth_status:'verified',revenue_held:0,
      stream_url:origin+'/api/stream/'+encodeURIComponent(String(share.id)),source_table:'share'
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
