import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { buildCertTL3 } from './cert3';  // CERT3_ROUTE_V1
import { buildTL3SpineV4, verifyTL3SpineV4Container } from './tl3spine';

import { cors } from 'hono/cors';
import type { Env } from './types';
import { verifyToken, makeAccessToken, hashPassword, verifyPassword } from './auth';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import filesRouter from './routes/files';
import playbackRouter from './routes/playback';
import shareplaceRouter from './routes/shareplace';
import adminRouter from './routes/admin';
import disputesRouter from './routes/disputes';
import chartsRouter from './routes/charts';
import scoreRouter from './routes/score';
import paymentRouter from './payment';
import ecoRouter from './economics';
import economyV3Router from './routes/economy-v3';
import musicV3Router from './routes/music-v3';
import musicV3AdminRouter from './routes/music-v3-admin';
import musicV3SocialRouter from './routes/music-v3-social';
import adsRouter from './ads_backend';
import { mintTLC, getJettonBalance } from './jetton';
import { sendVerificationEmail, sendPayoutEmail } from './email';
import { ensureD1Storage, putD1Object, getD1ObjectMeta, readD1Range, readD1RangeFast, D1_OBJECT_CHUNK_SIZE, D1_MAX_OBJECT_SIZE, createD1UploadSession, writeD1UploadSessionPart, completeD1UploadSession } from './d1-storage';
import sunoVerifyRouter from './routes/suno-verify';
import cafeRouter from './routes/cafe';
import incarRouter from './routes/incar';
import searchRouter from './routes/search';
import djRouter from './routes/dj';
import djCafeRouter from './routes/dj-cafe';
import cafeSubscriptionsRouter from './routes/cafe-subscriptions';
import settingsRouter from './routes/settings';
import cafeBroadcastRouter from './routes/cafe-broadcast';
import contactRouter from './routes/contact';
import uploadPdfRouter from './routes/upload-pdf';
import { ensureStorageTables, beginStorageConnect, finishStorageConnect, createUploadSession, finalizeUpload, registerObject, externalStream, disconnectStorage } from './storage';
import { buildTL3V4FromMp3, deriveLicenseBytes, initialToken, nextToken, ivFor, hex, enc, sha256 } from './tl3v3';


const app = new Hono<{ Bindings: Env }>();
app.use('/api/upload/*', bodyLimit({ maxSize: D1_MAX_OBJECT_SIZE }));
app.use('/api/upload', bodyLimit({ maxSize: D1_MAX_OBJECT_SIZE }));
app.use('/api/upload/part', bodyLimit({ maxSize: D1_OBJECT_CHUNK_SIZE }));

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['X-TL3-Segment-Duration-Ms'],
  maxAge: 86400,
}));

// ★ 에러 발생 시에도 CORS 헤더 유지
app.onError((err, c) => {
  console.error("[onError]", err);
  const origin = c.req.header("Origin") || "*";
  return c.json(
    { ok: false, error: err.message || "Internal Server Error" },
    500,
    { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
  );
});

app.options('*', () => new Response(null, { status: 204 }));

// ══════════════════════════════════════════════════════════

// User-owned storage: TimeLink stores metadata, not creator files.

// Files are uploaded directly from the browser to the user's provider

// upload session; playback is authorized through TimeLink.

// ══════════════════════════════════════════════════════════
async function storageUser(c:any){
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  if(!token) return null;
  return await verifyToken(token,c.env.JWT_SECRET);
}

// Authenticated Creator Studio source-asset registration.
// Caller-supplied email, username, publication flags and verification status are never trusted.
app.post('/api/files/sync', async (c) => {
  const session = await storageUser(c);
  const userId = Number(session?.sub || 0);
  if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ ok: false, error: '인증 필요' }, 401);
  try {
    const body = await c.req.json<any>();
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return c.json({ ok: false, error: 'title required' }, 422);
    const streamUrl = String(body.stream_url || '').trim().slice(0, 2048);
    if (streamUrl) {
      if (streamUrl.startsWith('tracks/') || streamUrl.startsWith('tl/')) {
        if (!streamUrl.startsWith(`tracks/u${userId}/`) && !streamUrl.startsWith(`tl/u${userId}/`)) {
          return c.json({ ok: false, error: '저장 파일 소유권이 일치하지 않습니다.' }, 403);
        }
      } else if (/\/api\/storage\//.test(streamUrl)) {
        let key = '';
        try { key = decodeURIComponent(streamUrl.split('/api/storage/')[1].split('?')[0]); } catch {}
        if (!key.startsWith(`tracks/u${userId}/`) && !key.startsWith(`tl/u${userId}/`)) {
          return c.json({ ok: false, error: '저장 파일 소유권이 일치하지 않습니다.' }, 403);
        }
      } else if (!/^https:\/\//i.test(streamUrl)) {
        return c.json({ ok: false, error: '지원하지 않는 원본 주소입니다.' }, 422);
      }
    }
    const artist = String(body.artist || '').trim().slice(0, 200);
    const genre = String(body.genre || 'Music').trim().slice(0, 80);
    const cover = String(body.cover_image || '').trim().slice(0, 2048);
    const fileType = String(body.file_type || 'audio/mpeg').toLowerCase() === 'audio/tl3' ? 'audio/mpeg' : String(body.file_type || 'audio/mpeg').slice(0, 80);
    const existing = body.force_new === true ? null : await c.env.DB.prepare(
      'SELECT id FROM tl_files WHERE title = ? AND user_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(title, userId).first<{ id: number }>();
    if (existing) {
      await c.env.DB.prepare(`
        UPDATE tl_files SET artist=?,genre=?,file_type=?,stream_url=?,cover_image=?,
          shared_to_shareplace=0,shared=0,auth_status='unverified',icon=?,updated_at=datetime('now')
        WHERE id=? AND user_id=?
      `).bind(artist,genre,fileType,streamUrl,cover,String(body.icon||'🎵').slice(0,16),existing.id,userId).run();
      return c.json({ok:true,action:'updated',d1_id:existing.id,file_id:existing.id,id:existing.id,stream_url:streamUrl});
    }
    const created = await c.env.DB.prepare(`
      INSERT INTO tl_files
        (user_id,title,artist,genre,file_type,stream_url,cover_image,price_per_sec,
         spotify_album,shared_to_shareplace,pulse,auth_status,icon,file_tl,max_file_tl,shared)
      VALUES(?,?,?,?,?,?,?,1,'',0,0,'unverified',?,0,0,0) RETURNING id
    `).bind(userId,title,artist,genre,fileType,streamUrl,cover,String(body.icon||'🎵').slice(0,16)).first<{id:number}>();
    if (!created?.id) return c.json({ok:false,error:'원본 자산 등록에 실패했습니다.'},500);
    return c.json({ok:true,action:'created',d1_id:created.id,file_id:created.id,id:created.id,stream_url:streamUrl},201);
  } catch (e:any) {
    return c.json({ok:false,error:e?.message||'원본 자산 등록 실패'},500);
  }
});
async function playbackUserId(c:any,allowQueryToken=true):Promise<number>{
  const header=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  const token=header||(allowQueryToken?String(c.req.query('tk')||'').trim():'');
  if(!token) return 0;
  const payload=await verifyToken(token,c.env.JWT_SECRET);
  const id=Number(payload?.sub||0);
  if(!Number.isSafeInteger(id)||id<=0) return 0;
  const user=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(id).first();
  return user?id:0;
}

// Resolve a SharePlace entry to its exact TL3 asset.
// A reusable share_id may group several releases, so never choose an arbitrary
// release by share_id before checking the entry's own stream/file URL.
async function resolveTL3FileId(db:any, rawId:string):Promise<number>{
  const id=String(rawId||'').trim();
  if(!id) return 0;

  const linked=await db.prepare(
    "SELECT DISTINCT r.file_id FROM tl_shares s JOIN tl_files f ON (f.stream_url=s.stream_url OR f.file_url=s.stream_url) JOIN tl3_releases r ON r.file_id=f.id AND r.status='released' WHERE s.id=? AND LOWER(f.file_type)='audio/tl3' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 AND EXISTS (SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.rights_confirmed=1) LIMIT 2"
  ).bind(id).all().catch(()=>({results:[]}));
  const linkedRows:any[]=(linked.results||[]) as any[];
  const linkedIds:number[]=[...new Set<number>(linkedRows.map((row:any)=>Number(row.file_id)).filter((n:number)=>Number.isSafeInteger(n)&&n>0))];
  if(linkedIds.length===1) return linkedIds[0];
  if(linkedIds.length>1) return 0;

  // Backward compatibility for callers that pass a release share_id directly.
  // This fallback is safe only when that identifier resolves to exactly one asset.
  const direct=await db.prepare(
    "SELECT file_id FROM tl3_releases WHERE share_id=? AND status='released' LIMIT 2"
  ).bind(id).all().catch(()=>({results:[]}));
  const directRows:any[]=(direct.results||[]) as any[];
  const directIds:number[]=[...new Set<number>(directRows.map((row:any)=>Number(row.file_id)).filter((n:number)=>Number.isSafeInteger(n)&&n>0))];
  return directIds.length===1?directIds[0]:0;
}
async function isPublicPlaybackShare(db:D1Database,share:any):Promise<boolean>{
  // Existing TimeLink rule: shared TL3 assets are treated as shared.
  const contentKind=String(share?.content_kind||'').toLowerCase();
  const releaseMode=String(share?.release_mode||'').toLowerCase();
  const fileType=String(share?.file_type||'').toLowerCase();
  // PR29 security gate: public access requires a server-verified, shared TL3 record.
  // MP3 source assets are never public releases; only verified TL3 files pass below.
  if(fileType!=='audio/tl3') return false;
  // Never trust release_check here: legacy clients can submit it themselves.
  // TL3 becomes public only when a matching server-verified TL3 file is shared.
  const streamUrl=String(share?.stream_url||'').trim();
  if(streamUrl){
    const file=await db.prepare(
      "SELECT id FROM tl_files WHERE LOWER(file_type)='audio/tl3' AND auth_status='verified' AND shared=1 AND COALESCE(revenue_held,0)=0 AND (stream_url=? OR file_url=? OR file_url LIKE ?) LIMIT 1"
    ).bind(streamUrl,streamUrl,'%'+streamUrl).first().catch(()=>null);
    if(file) return true;
  }
  return false;

  if(contentKind==='tl3'||releaseMode==='tl3'||fileType==='audio/tl3') return true;
  return Number(share?.shared)===1;

}
async function hasPlaybackBalance(db:D1Database,userId:number):Promise<boolean>{
  if(!userId) return false;
  const row=await db.prepare(
    'SELECT COALESCE(tl_p,tl,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) AS total FROM users WHERE id=?'
  ).bind(userId).first<any>();
  return Number(row?.total||0)>0;
}

app.get('/api/storage/providers', async (c) => {
  return c.json({
    providers:[
      {id:'google_drive',name:'Google Drive',configured:!!c.env.GOOGLE_CLIENT_ID},
      {id:'onedrive',name:'Microsoft OneDrive',configured:!!c.env.ONEDRIVE_CLIENT_ID},
      {id:'local_agent',name:'TimeLink Local Agent',configured:true}
    ]
  });
});
app.get('/api/storage/connections', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  await ensureStorageTables(c.env.DB);
  const r=await c.env.DB.prepare("SELECT id,provider,provider_account_id,provider_email,provider_name,root_id,status,created_at,updated_at FROM storage_connections WHERE user_id=? AND status='active' ORDER BY id").bind(Number(u.sub)).all();
  return c.json({connections:r.results||[]});
});
// 개인 파일 보관함: 외부 저장소의 소유자 메타데이터만 반환한다.
app.get('/api/storage/objects', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  await ensureStorageTables(c.env.DB);
  const limit=Math.max(1,Math.min(Number(c.req.query('limit')||100),200));
  const offset=Math.max(0,Number(c.req.query('offset')||0));
  const r=await c.env.DB.prepare(
    "SELECT id,connection_id,provider,name,mime_type,size,content_hash,status,created_at,updated_at FROM storage_objects WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).bind(Number(u.sub),limit,offset).all();
  return c.json({objects:r.results||[],limit,offset});
});

app.get('/api/storage/connect/:provider', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  const provider=c.req.param('provider') as any;
  if(!['google_drive','onedrive'].includes(provider)) return c.json({error:'지원하지 않는 provider'},400);
  try { return c.redirect(await beginStorageConnect(c.env.DB,c.env,Number(u.sub),provider)); }
  catch(e:any){ return c.json({error:e.message},500); }
});
app.post('/api/storage/connect', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  try {
    const b=await c.req.json<any>();
    const provider=b.provider as any;
    if(!['google_drive','onedrive'].includes(provider)) return c.json({error:'지원하지 않는 provider'},400);
    const url=await beginStorageConnect(c.env.DB,c.env,Number(u.sub),provider);
    return c.json({ok:true,provider,authorization_url:url});
  } catch(e:any) {
    return c.json({error:e?.message||'저장소 연결 시작 실패'},500);
  }
});
app.get('/api/storage/oauth/:provider/callback', async (c) => {
  const provider=c.req.param('provider') as any,code=c.req.query('code')||'',state=c.req.query('state')||'',error=c.req.query('error');
  if(error) return c.html('<h2>TimeLink 저장소 연결 취소</h2><p>'+String(error)+'</p>');
  try {
    if(!code||!state) throw new Error('code/state가 없습니다.');
    const r=await finishStorageConnect(c.env.DB,c.env,provider,code,state);
    return c.html('<h2>TimeLink 저장소 연결 완료</h2><p>'+r.provider+' 연결이 완료되었습니다. 이 창을 닫고 TimeLink로 돌아가십시오.</p><script>window.opener&&window.opener.postMessage({type:"timelink-storage-connected",provider:"'+r.provider+'"},"*");</script>');
  } catch(e:any){ return c.html('<h2>TimeLink 저장소 연결 실패</h2><p>'+String(e.message).replace(/[<>]/g,'')+'</p>',500); }
});
app.delete('/api/storage/connections/:provider', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  const provider=c.req.param('provider') as any;
  if(!['google_drive','onedrive'].includes(provider)) return c.json({error:'지원하지 않는 provider'},400);
  await disconnectStorage(c.env.DB,Number(u.sub),provider); return c.json({ok:true});
});
app.post('/api/storage/upload-session', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  const b=await c.req.json<any>(),provider=b.provider as any,name=String(b.name||'').trim(),size=Number(b.size||0),mime=String(b.mime||'application/octet-stream');
  if(!['google_drive','onedrive'].includes(provider)||!name||!Number.isFinite(size)||size<=0) return c.json({error:'provider, name, size가 필요합니다.'},422);
  try { return c.json({ok:true,upload:await createUploadSession(c.env.DB,c.env,Number(u.sub),provider,name,size,mime,c.req.header('Origin')||'')}); }
  catch(e:any){ return c.json({ok:false,error:e.message},500); }
});
app.post('/api/storage/finalize', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  const b=await c.req.json<any>(),provider=b.provider as any;
  if(!['google_drive','onedrive'].includes(provider)) return c.json({error:'지원하지 않는 provider'},400);
  try{return c.json({ok:true,...await finalizeUpload(c.env.DB,c.env,Number(u.sub),Number(b.connectionId),provider,String(b.name||'file'))});}
  catch(e:any){return c.json({ok:false,error:e.message},502);}
});
app.post('/api/storage/object/register', async (c) => {
  const u=await storageUser(c); if(!u) return c.json({error:'인증 필요'},401);
  const b=await c.req.json<any>();
  try {
    const id=await registerObject(c.env.DB,Number(u.sub),Number(b.connectionId),b.provider,String(b.objectId),String(b.name||'file'),String(b.mime||'application/octet-stream'),Number(b.size||0),b.hash);
    if(b.shareId){
      await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN storage_object_id INTEGER").run().catch(()=>{});
      await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN storage_provider TEXT DEFAULT ''").run().catch(()=>{});
      await c.env.DB.prepare("UPDATE tl_shares SET storage_object_id=?,storage_provider=?,stream_url=? WHERE id=? AND CAST(user_id AS INTEGER)=?").bind(id,String(b.provider),`/api/stream/${String(b.shareId)}`,String(b.shareId),Number(u.sub)).run();
    }
    return c.json({ok:true,object_id:id,storage_mode:'external',shareId:b.shareId||null});
  } catch(e:any){ return c.json({ok:false,error:e.message},500); }
});
app.get('/api/storage/object/:id/stream', async (c) => {
  try {
    const objectId=Number(c.req.param('id'));
    if(!Number.isSafeInteger(objectId)||objectId<=0) return c.json({error:'잘못된 저장소 객체 ID'},400);
    await ensureStorageTables(c.env.DB);
    const object=await c.env.DB.prepare(
      "SELECT id,user_id FROM storage_objects WHERE id=? AND status='active'"
    ).bind(objectId).first<any>();
    if(!object) return c.json({error:'저장소 객체 없음'},404);

    const viewerId=await playbackUserId(c);
    const ownerId=Number(object.user_id);
    const linked=await c.env.DB.prepare(
      'SELECT * FROM tl_shares WHERE storage_object_id=? AND CAST(user_id AS INTEGER)=?'
    ).bind(objectId,ownerId).all<any>();
    let isPublic=false;
    for(const row of (linked.results||[])){
      if(await isPublicPlaybackShare(c.env.DB,row)){isPublic=true;break;}
    }
    const isOwner=viewerId===ownerId;
    if(!isOwner&&!isPublic) return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);
    if(!isOwner && (linked.results||[]).some((row:any)=>shareKind(row)==='tl3') && !await hasPlaybackBalance(c.env.DB,viewerId)){
      return c.json({error:'재생에 필요한 TL 잔액이 없습니다.'},402);
    }

    const r=await externalStream(c.env.DB,c.env,objectId,c.req.header('Range')||'');
    const h=new Headers(r.headers);
    h.set('Access-Control-Allow-Origin','*');
    h.set('Access-Control-Expose-Headers','Content-Range,Accept-Ranges,Content-Length');
    h.set('Cache-Control',isPublic?'no-store':'private, no-store');
    return new Response(r.body,{status:r.status,headers:h});
  } catch(e:any){return c.json({error:e.message||'외부 스트림 접근 실패'},404);}
});


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
app.route('/api/v3/economy', economyV3Router);
app.route('/api/v3/music', musicV3Router);
app.route('/api/v3/music-admin', musicV3AdminRouter);
app.route('/api/v3/music-social', musicV3SocialRouter);
app.route('/api/v1/files', filesRouter);
app.route('/api/v1/playback', playbackRouter);
app.route('/api/v1', scoreRouter);
app.route('/api/v1/shareplace', shareplaceRouter);
// SharePlace legacy endpoint: 기존 프론트엔드가 사용하는 /api/shares 경로를 유지한다.
app.route('/api/shares', shareplaceRouter);
app.route('/api/admin', adminRouter);
app.route('/api/cafe', cafeRouter);
app.route('/api/incar', incarRouter);
app.route('/api/search', searchRouter);
app.route('/api/dj', djRouter);
app.route('/api/dj-cafe', djCafeRouter);
app.route('/api/cafe-subscriptions', cafeSubscriptionsRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/cafe-broadcast', cafeBroadcastRouter);
app.route('/api/contact', contactRouter);
app.route('/api/upload-pdf', uploadPdfRouter);

// ── Track Page Social / Playlist ─────────────────────────────
async function ensureTrackSocialTables(db:any){
  const statements=[
    `CREATE TABLE IF NOT EXISTS social_likes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,share_id TEXT NOT NULL,user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT(datetime('now')),UNIQUE(share_id,user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS social_follows(
      id INTEGER PRIMARY KEY AUTOINCREMENT,follower_id INTEGER NOT NULL,followed_id INTEGER NOT NULL,
      created_at TEXT DEFAULT(datetime('now')),UNIQUE(follower_id,followed_id)
    )`,
    `CREATE TABLE IF NOT EXISTS social_comments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,share_id TEXT NOT NULL,user_id INTEGER NOT NULL,
      username TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS social_comment_reports(
      id INTEGER PRIMARY KEY AUTOINCREMENT,comment_id INTEGER NOT NULL,reporter_id INTEGER NOT NULL,
      created_at TEXT DEFAULT(datetime('now')),UNIQUE(comment_id,reporter_id)
    )`,
    `CREATE TABLE IF NOT EXISTS tl_playlists(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT(datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tl_playlist_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT,playlist_id INTEGER NOT NULL,share_id TEXT NOT NULL,
      created_at TEXT DEFAULT(datetime('now')),UNIQUE(playlist_id,share_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_social_likes_share ON social_likes(share_id)",
    "CREATE INDEX IF NOT EXISTS idx_social_comments_share ON social_comments(share_id,created_at)",
    "CREATE INDEX IF NOT EXISTS idx_social_follows_target ON social_follows(followed_id)"
  ];
  for(const sql of statements) await db.prepare(sql).run();
}

app.get('/api/social/stats/:id',async(c)=>{
  let shareId=c.req.param('id');
  try{
    await ensureTrackSocialTables(c.env.DB);
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share)return c.json({error:'곡을 찾을 수 없습니다.'},404);
    const viewerId=await shareAuthUser(c).catch(()=>0);
    if(Number(share.user_id)!==viewerId&&!await isPublicPlaybackShare(c.env.DB,share))return c.json({error:'비공개 곡입니다.'},403);
    const likes=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM social_likes WHERE share_id=?').bind(shareId).first<any>();
    const comments=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM social_comments WHERE share_id=?').bind(shareId).first<any>();
    const userId=await shareAuthUser(c).catch(()=>0);
    let myLike=false;
    if(userId){
      const row=await c.env.DB.prepare('SELECT id FROM social_likes WHERE share_id=? AND user_id=?').bind(shareId,userId).first();
      myLike=!!row;
    }
    return c.json({likes:Number(likes?.n||0),comments:Number(comments?.n||0),views:0,views_tracked:false,my_like:myLike});
  }catch(e:any){return c.json({error:e?.message||'곡 통계를 불러오지 못했습니다.'},500);}
});

app.post('/api/social/like/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  let shareId=c.req.param('id');
  try{
    await ensureTrackSocialTables(c.env.DB);
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share)return c.json({error:'곡을 찾을 수 없습니다.'},404);
    if(Number(share.user_id)!==userId&&!await isPublicPlaybackShare(c.env.DB,share))return c.json({error:'비공개 곡입니다.'},403);
    await c.env.DB.prepare('INSERT OR IGNORE INTO social_likes(share_id,user_id) VALUES(?,?)').bind(shareId,userId).run();
    const row=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM social_likes WHERE share_id=?').bind(shareId).first<any>();
    return c.json({ok:true,liked:true,likes:Number(row?.n||0)});
  }catch(e:any){return c.json({error:e?.message||'좋아요 처리 실패'},500);}
});

app.delete('/api/social/like/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  let shareId=c.req.param('id');
  try{
    await ensureTrackSocialTables(c.env.DB);
    await c.env.DB.prepare('DELETE FROM social_likes WHERE share_id=? AND user_id=?').bind(shareId,userId).run();
    const row=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM social_likes WHERE share_id=?').bind(shareId).first<any>();
    return c.json({ok:true,liked:false,likes:Number(row?.n||0)});
  }catch(e:any){return c.json({error:e?.message||'좋아요 취소 실패'},500);}
});

app.get('/api/social/follow-status/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0),target=Number(c.req.param('id')||0);
  if(!userId||!target)return c.json({following:false});
  try{
    await ensureTrackSocialTables(c.env.DB);
    const row=await c.env.DB.prepare('SELECT id FROM social_follows WHERE follower_id=? AND followed_id=?').bind(userId,target).first();
    return c.json({following:!!row});
  }catch(e:any){return c.json({error:e?.message||'팔로우 상태 조회 실패'},500);}
});

app.post('/api/social/follow/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0),target=Number(c.req.param('id')||0);
  if(!userId)return c.json({error:'인증 필요'},401);
  if(!target)return c.json({error:'대상 사용자를 확인할 수 없습니다.'},400);
  if(target===userId)return c.json({error:'본인은 팔로우할 수 없습니다.'},400);
  try{
    await ensureTrackSocialTables(c.env.DB);
    const user=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND is_active=1').bind(target).first();
    if(!user)return c.json({error:'사용자를 찾을 수 없습니다.'},404);
    await c.env.DB.prepare('INSERT OR IGNORE INTO social_follows(follower_id,followed_id) VALUES(?,?)').bind(userId,target).run();
    return c.json({ok:true,following:true});
  }catch(e:any){return c.json({error:e?.message||'팔로우 처리 실패'},500);}
});

app.delete('/api/social/follow/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0),target=Number(c.req.param('id')||0);
  if(!userId)return c.json({error:'인증 필요'},401);
  try{
    await ensureTrackSocialTables(c.env.DB);
    await c.env.DB.prepare('DELETE FROM social_follows WHERE follower_id=? AND followed_id=?').bind(userId,target).run();
    return c.json({ok:true,following:false});
  }catch(e:any){return c.json({error:e?.message||'팔로우 취소 실패'},500);}
});

app.get('/api/social/comments/:id',async(c)=>{
  let shareId=c.req.param('id');
  try{
    await ensureTrackSocialTables(c.env.DB);
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share)return c.json({error:'곡을 찾을 수 없습니다.'},404);
    const viewerId=await shareAuthUser(c).catch(()=>0);
    if(Number(share.user_id)!==viewerId&&!await isPublicPlaybackShare(c.env.DB,share))return c.json({error:'비공개 곡입니다.'},403);
    const rows=await c.env.DB.prepare(
      'SELECT id,user_id,username,content,created_at FROM social_comments WHERE share_id=? ORDER BY created_at DESC LIMIT 100'
    ).bind(shareId).all();
    return c.json({comments:rows.results||[]});
  }catch(e:any){return c.json({comments:[],error:e?.message||'댓글 조회 실패'},500);}
});

app.post('/api/social/comment/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  let shareId=c.req.param('id');
  const body=await c.req.json<any>().catch(()=>({}));
  const content=String(body.content||'').trim().slice(0,1000);
  if(!content)return c.json({error:'내용을 입력해 주세요.'},400);
  if(content.length<10)return c.json({error:'10자 이상 입력해 주세요.'},400);
  try{
    await ensureTrackSocialTables(c.env.DB);
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share)return c.json({error:'곡을 찾을 수 없습니다.'},404);
    if(Number(share.user_id)!==userId&&!await isPublicPlaybackShare(c.env.DB,share))return c.json({error:'비공개 곡입니다.'},403);
    const user=await c.env.DB.prepare('SELECT username FROM users WHERE id=?').bind(userId).first<any>();
    const username=user?.username||('User'+userId);
    const result=await c.env.DB.prepare(
      'INSERT INTO social_comments(share_id,user_id,username,content) VALUES(?,?,?,?) RETURNING id'
    ).bind(shareId,userId,username,content).first<any>();
    const fresh=await c.env.DB.prepare('SELECT id,user_id,username,content,created_at FROM social_comments WHERE id=?').bind(result?.id).first<any>();
    return c.json({ok:true,comment:fresh});
  }catch(e:any){return c.json({error:e?.message||'댓글 등록 실패'},500);}
});

app.post('/api/social/report/comment/:id',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  const commentId=Number(c.req.param('id')||0);
  if(!commentId)return c.json({error:'댓글을 확인할 수 없습니다.'},400);
  try{
    await ensureTrackSocialTables(c.env.DB);
    const comment=await c.env.DB.prepare('SELECT c.id,c.share_id,s.* FROM social_comments c JOIN tl_shares s ON s.id=c.share_id WHERE c.id=?').bind(commentId).first<any>();
    if(!comment)return c.json({error:'댓글을 찾을 수 없습니다.'},404);
    if(Number(comment.user_id)!==userId&&!await isPublicPlaybackShare(c.env.DB,comment))return c.json({error:'비공개 곡의 댓글은 신고할 수 없습니다.'},403);
    await c.env.DB.prepare('INSERT OR IGNORE INTO social_comment_reports(comment_id,reporter_id) VALUES(?,?)').bind(commentId,userId).run();
    return c.json({ok:true,reported:true});
  }catch(e:any){return c.json({error:e?.message||'신고 접수 실패'},500);}
});

app.get('/api/playlist/my',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  try{
    await ensureTrackSocialTables(c.env.DB);
    const rows=await c.env.DB.prepare(
      "SELECT p.id,p.title,p.is_public,p.created_at,GROUP_CONCAT(i.share_id,'|') AS share_ids_csv FROM tl_playlists p LEFT JOIN tl_playlist_items i ON i.playlist_id=p.id WHERE p.user_id=? GROUP BY p.id ORDER BY p.created_at DESC"
    ).bind(userId).all<any>();
    const playlists=(rows.results||[]).map((p:any)=>({...p,share_ids:JSON.stringify(String(p.share_ids_csv||'').split('|').filter(Boolean))}));
    return c.json({playlists});
  }catch(e:any){return c.json({error:e?.message||'플레이리스트 조회 실패'},500);}
});

app.post('/api/playlist',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  const body=await c.req.json<any>().catch(()=>({}));
  const title=String(body.title||'').trim().slice(0,80);
  if(!title)return c.json({error:'플레이리스트 이름을 입력해 주세요.'},400);
  try{
    await ensureTrackSocialTables(c.env.DB);
    const row=await c.env.DB.prepare(
      'INSERT INTO tl_playlists(user_id,title,is_public) VALUES(?,?,?) RETURNING id'
    ).bind(userId,title,body.is_public?1:0).first<any>();
    return c.json({ok:true,playlist_id:Number(row?.id||0),playlist:{id:Number(row?.id||0),title,is_public:!!body.is_public,share_ids:'[]'}});
  }catch(e:any){return c.json({error:e?.message||'플레이리스트 생성 실패'},500);}
});

app.post('/api/playlist/:id/add',async(c)=>{
  const userId=await shareAuthUser(c).catch(()=>0);
  if(!userId)return c.json({error:'인증 필요'},401);
  const playlistId=Number(c.req.param('id')||0);
  const body=await c.req.json<any>().catch(()=>({}));
  const shareId=String(body.share_id||'').trim();
  if(!playlistId||!shareId)return c.json({error:'플레이리스트와 곡 정보가 필요합니다.'},400);
  try{
    await ensureTrackSocialTables(c.env.DB);
    const playlist=await c.env.DB.prepare('SELECT id FROM tl_playlists WHERE id=? AND user_id=?').bind(playlistId,userId).first();
    if(!playlist)return c.json({error:'플레이리스트를 찾을 수 없습니다.'},404);
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share)return c.json({error:'곡을 찾을 수 없습니다.'},404);
    if(Number(share.user_id)!==userId&&!await isPublicPlaybackShare(c.env.DB,share))return c.json({error:'비공개 곡은 플레이리스트에 추가할 수 없습니다.'},403);
    await c.env.DB.prepare('INSERT OR IGNORE INTO tl_playlist_items(playlist_id,share_id) VALUES(?,?)').bind(playlistId,shareId).run();
    return c.json({ok:true,added:true});
  }catch(e:any){return c.json({error:e?.message||'곡 추가 실패'},500);}
});

// ── Track Social / Playlist: existing D1 tables, real persistence ──
app.get('/api/social/stats/:id', async (c) => {
  const shareId = c.req.param('id');
  const userId = await shareAuthUser(c);
  try {
    const [likes, comments, mine] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM user_likes WHERE share_id=?').bind(shareId).first<any>(),
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM social_comments WHERE share_id=?').bind(shareId).first<any>(),
      userId
        ? c.env.DB.prepare('SELECT 1 AS liked FROM user_likes WHERE user_id=? AND share_id=? LIMIT 1').bind(userId, shareId).first<any>()
        : Promise.resolve(null)
    ]);
    // play_logs/play_events are not currently a verified per-share view counter.
    return c.json({ likes: Number(likes?.total || 0), comments: Number(comments?.total || 0), views: 0, my_like: !!mine });
  } catch (e: any) {
    return c.json({ error: e?.message || '통계 조회 실패' }, 500);
  }
});
app.post('/api/social/like/:id', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const shareId = c.req.param('id');
  const share = await c.env.DB.prepare('SELECT id FROM tl_shares WHERE id=?').bind(shareId).first<any>();
  if (!share) return c.json({ error: '곡을 찾을 수 없습니다.' }, 404);
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_likes (user_id, share_id) VALUES (?, ?)').bind(userId, shareId).run();
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM user_likes WHERE share_id=?').bind(shareId).first<any>();
    return c.json({ ok: true, liked: true, likes: Number(row?.total || 0) });
  } catch (e: any) { return c.json({ error: e?.message || '좋아요 처리 실패' }, 500); }
});
app.delete('/api/social/like/:id', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const shareId = c.req.param('id');
  try {
    await c.env.DB.prepare('DELETE FROM user_likes WHERE user_id=? AND share_id=?').bind(userId, shareId).run();
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM user_likes WHERE share_id=?').bind(shareId).first<any>();
    return c.json({ ok: true, liked: false, likes: Number(row?.total || 0) });
  } catch (e: any) { return c.json({ error: e?.message || '좋아요 취소 실패' }, 500); }
});
app.get('/api/social/follow-status/:id', async (c) => {
  const targetId = Number(c.req.param('id'));
  const userId = await shareAuthUser(c);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return c.json({ error: '잘못된 창작자 ID' }, 400);
  if (!userId) return c.json({ following: false });
  try {
    const row = await c.env.DB.prepare('SELECT 1 AS following FROM user_follows WHERE follower_id=? AND following_id=? LIMIT 1').bind(userId, targetId).first<any>();
    return c.json({ following: !!row });
  } catch (e: any) { return c.json({ error: e?.message || '팔로우 상태 조회 실패' }, 500); }
});
app.post('/api/social/follow/:id', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const targetId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return c.json({ error: '잘못된 창작자 ID' }, 400);
  if (userId === targetId) return c.json({ error: '자기 자신은 팔로우할 수 없습니다.' }, 400);
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(targetId).first<any>();
  if (!target) return c.json({ error: '창작자를 찾을 수 없습니다.' }, 404);
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)').bind(userId, targetId).run();
    return c.json({ ok: true, following: true });
  } catch (e: any) { return c.json({ error: e?.message || '팔로우 처리 실패' }, 500); }
});
app.delete('/api/social/follow/:id', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const targetId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return c.json({ error: '잘못된 창작자 ID' }, 400);
  try {
    await c.env.DB.prepare('DELETE FROM user_follows WHERE follower_id=? AND following_id=?').bind(userId, targetId).run();
    return c.json({ ok: true, following: false });
  } catch (e: any) { return c.json({ error: e?.message || '팔로우 취소 실패' }, 500); }
});
app.get('/api/social/comments/:id', async (c) => {
  const shareId = c.req.param('id');
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id, user_id, username, content, created_at FROM social_comments WHERE share_id=? ORDER BY created_at DESC LIMIT 100'
    ).bind(shareId).all();
    return c.json({ comments: rows.results || [] });
  } catch (e: any) {
    return c.json({ comments: [], error: e?.message || '댓글 조회 실패' }, 500);
  }
});
app.post('/api/social/comment/:id', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const shareId = c.req.param('id');
  const share = await c.env.DB.prepare('SELECT id FROM tl_shares WHERE id=?').bind(shareId).first<any>();
  if (!share) return c.json({ error: '곡을 찾을 수 없습니다.' }, 404);
  const body = await c.req.json<any>().catch(() => ({}));
  const content = String(body.content || '').trim().slice(0, 1000);
  if (!content) return c.json({ error: '내용 필요' }, 400);
  if (content.length < 10) return c.json({ error: '10자 이상 입력해주세요' }, 400);
  const user = await c.env.DB.prepare('SELECT username FROM users WHERE id=?').bind(userId).first<any>();
  const username = user?.username || ('User' + userId);
  try {
    const r = await c.env.DB.prepare(
      'INSERT INTO social_comments (share_id, user_id, username, content) VALUES (?, ?, ?, ?)'
    ).bind(shareId, userId, username, content).run();
    const fresh = await c.env.DB.prepare(
      'SELECT id, user_id, username, content, created_at FROM social_comments WHERE id=?'
    ).bind(r.meta?.last_row_id).first<any>();
    return c.json({ ok: true, comment: fresh });
  } catch (e: any) { return c.json({ error: e?.message || '댓글 등록 실패' }, 500); }
});
app.post('/api/social/report/comment/:id', (c) => c.json({ ok: false, error: '신고 기능은 실제 신고 기록 테이블 연결 후 활성화됩니다.' }, 501));
app.get('/api/playlist/my', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id, user_id, title, is_public, share_ids, subscriber_count, created_at FROM playlists WHERE user_id=? ORDER BY created_at DESC'
    ).bind(userId).all();
    return c.json({ playlists: rows.results || [] });
  } catch (e: any) { return c.json({ error: e?.message || '플레이리스트 조회 실패' }, 500); }
});
app.post('/api/playlist/:id/add', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const playlistId = Number(c.req.param('id'));
  const body = await c.req.json<any>().catch(() => ({}));
  const shareId = String(body.share_id || '').trim();
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0 || !shareId) return c.json({ error: '플레이리스트와 곡 정보가 필요합니다.' }, 400);
  const playlist = await c.env.DB.prepare('SELECT id, share_ids FROM playlists WHERE id=? AND user_id=?').bind(playlistId, userId).first<any>();
  if (!playlist) return c.json({ error: '플레이리스트를 찾을 수 없거나 수정 권한이 없습니다.' }, 404);
  const share = await c.env.DB.prepare('SELECT id FROM tl_shares WHERE id=?').bind(shareId).first<any>();
  if (!share) return c.json({ error: '곡을 찾을 수 없습니다.' }, 404);
  try {
    let ids: string[] = [];
    try { const parsed = JSON.parse(String(playlist.share_ids || '[]')); if (Array.isArray(parsed)) ids = parsed.map(String); } catch {}
    if (!ids.includes(shareId)) ids.push(shareId);
    await c.env.DB.prepare('UPDATE playlists SET share_ids=? WHERE id=? AND user_id=?').bind(JSON.stringify(ids), playlistId, userId).run();
    return c.json({ ok: true, playlist_id: playlistId, share_ids: ids });
  } catch (e: any) { return c.json({ error: e?.message || '플레이리스트 추가 실패' }, 500); }
});
app.post('/api/playlist', async (c) => {
  const userId = await shareAuthUser(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) return c.json({ error: '플레이리스트 이름을 입력해주세요.' }, 400);
  try {
    const r = await c.env.DB.prepare(
      'INSERT INTO playlists (user_id, title, is_public, share_ids) VALUES (?, ?, ?, ?)'
    ).bind(userId, title, body.is_public ? 1 : 0, '[]').run();
    return c.json({ ok: true, playlist_id: Number(r.meta?.last_row_id || 0) });
  } catch (e: any) { return c.json({ error: e?.message || '플레이리스트 생성 실패' }, 500); }

});

// ── Unsplash 이미지 검색 (곡 커버 자동 매칭용) ──
app.get('/api/unsplash/search', async (c) => {
  const q = String(c.req.query('q') || '').trim();
  if (!q) return c.json({ error: 'q 필요' }, 400);
  const key = c.env.UNSPLASH_ACCESS_KEY;
  if (!key) return c.json({ error: 'Unsplash 키 없음' }, 503);
  try {
    const r = await fetch(
      'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(q) + '&per_page=5&orientation=squarish',
      { headers: { 'Authorization': 'Client-ID ' + key } }
    );
    if (!r.ok) return c.json({ error: 'Unsplash API 오류', status: r.status }, 502);
    const d = await r.json() as { results?: Array<{ id: string; urls?: { regular?: string; small?: string; thumb?: string }; alt_description?: string; user?: { name?: string; links?: { html?: string } } }> };
    const photos = (d.results || []).map(p => ({
      id: p.id,
      url: p.urls?.regular || p.urls?.small,
      thumb: p.urls?.thumb,
      alt: p.alt_description || '',
      author: p.user?.name || '',
      author_url: p.user?.links?.html || ''
    }));
    return c.json({ ok: true, photos });
  } catch (e: any) {
    return c.json({ error: e?.message || 'Unsplash 검색 실패' }, 500);
  }
});

// ── Admin: 전체 유저 목록 (관리자만) ──
app.get('/api/users', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return c.json({ error: 'Invalid token' }, 401);
  const meId = Number(payload.sub || 0);
  if (!meId) return c.json({ error: '인증 사용자 확인 불가' }, 401);
  const me = await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(meId).first<any>();
  if (!me || String(me.role || '').toLowerCase() !== 'admin') {
    return c.json({ error: '관리자 권한 필요' }, 403);
  }

  const limit = Math.min(Number(c.req.query('limit') || 500), 2000);
  const offset = Number(c.req.query('offset') || 0);
  const rows = await c.env.DB.prepare(
    'SELECT id, email, username, role, tl, tl_p, tl_a, tl_b, tl_balance, tlc, tlc_balance, poc_index, total_tl_spent, total_tl_earned, created_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();

  return c.json({ ok: true, users: rows.results || [] });
});

// ── Admin: 특정 유저 조회 ──
app.get('/api/users/:id', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return c.json({ error: 'Invalid token' }, 401);
  const meId = Number(payload.sub || 0);
  const me = await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(meId).first<any>();
  if (!me || String(me.role || '').toLowerCase() !== 'admin') {
    return c.json({ error: '관리자 권한 필요' }, 403);
  }
  const id = Number(c.req.param('id') || 0);
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first<any>();
  if (!row) return c.json({ error: '유저 없음' }, 404);
  delete row.password_hash;
  return c.json({ ok: true, user: row });
});
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
    COALESCE(is_advertiser, 0) as is_advertiser,
    COALESCE(biz_reg_num, '') as biz_reg_num,
    COALESCE(business_name, '') as business_name,
    created_at
  FROM users
`;

// GET /api/tracks
app.get('/api/tracks', async (c) => {
  try {
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, artist TEXT NOT NULL, price_tl INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'released', tl3_key TEXT, payload_offset INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0, segment_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
    const genre = c.req.query('genre');
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    let query = `
      SELECT f.id, f.title, f.artist, f.genre, f.icon,
        f.pulse, f.price_per_sec, f.stream_url, f.cover_image,
        f.spotify_album, f.auth_status, f.file_type,
        f.play_count, f.created_at, u.username as creator,
        r.status AS tl3_status, r.price_tl AS price_tl,
        r.duration_ms AS tl3_duration_ms, r.segment_count AS tl3_segment_count
      FROM tl_files f
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN tl3_releases r ON r.file_id = f.id
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
// 소유권은 요청 본문이 아니라 검증된 Bearer JWT 주체에서만 결정한다.
app.post('/api/files/sync', async (c) => {

  const session = await storageUser(c);
  const userId = Number(session?.sub || 0);
  if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ ok: false, error: '인증 필요' }, 401);

  try {
    const owner = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId).first<{ id: number }>();
    if (!owner) return c.json({ ok: false, error: '인증 사용자 확인 불가' }, 401);
    const body = await c.req.json<any>();

    if (!String(body.title || '').trim()) return c.json({ error: 'title required' }, 422);

    if (!body.title) return c.json({ error: 'title required' }, 422);

    const existing = body.force_new === true ? null : await c.env.DB.prepare(
      'SELECT id FROM tl_files WHERE title = ? AND user_id = ?'
    ).bind(body.title, userId).first<{ id: number }>();
    if (existing) {
      await c.env.DB.prepare(`
        UPDATE tl_files SET artist=?, genre=?, file_type=?, stream_url=?, cover_image=?,
        price_per_sec=?, spotify_album=?, shared_to_shareplace=0, shared=0, pulse=?,
        auth_status='unverified', icon=?, updated_at=datetime('now') WHERE id=?
      `).bind(
        body.artist||'', body.genre||'etc', body.file_type||'application/octet-stream', body.stream_url||'', body.cover_image||'',
        body.price_per_sec||1, body.spotify_album||'', body.pulse||0,
        body.icon||'🎵', existing.id
      ).run();
      return c.json({ ok: true, action: 'updated', d1_id: existing.id });
    } else {
      const res = await c.env.DB.prepare(`
        INSERT INTO tl_files (user_id,title,artist,genre,file_type,stream_url,cover_image,
          price_per_sec,spotify_album,shared_to_shareplace,pulse,auth_status,icon,file_tl,max_file_tl,shared)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'unverified',?,?,?,0) RETURNING id
      `).bind(
        userId, body.title, body.artist||'', body.genre||'etc', body.file_type||'application/octet-stream',
        body.stream_url||'', body.cover_image||'', body.price_per_sec||1,
        body.spotify_album||'', 0, body.pulse||0, body.icon||'🎵',
        Math.max(0,Math.floor(Number(body.file_tl||0))), Math.max(0,Math.floor(Number(body.file_tl||0)))
      ).first<{ id: number }>();
      return c.json({ ok: true, action: 'created', d1_id: res?.id, share_id: body.share_id || (res?.id ? 'tl3_' + res.id : '') });
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

// ── 인증된 TL3 컨테이너 저장 ──
// 브라우저에서 생성한 TLNK v2 컨테이너를 D1 Object Storage에 저장한다.
// share 생성 전용 단계이며 파일명/경로는 서버가 결정한다.
// ── 무료 MP3 원본 저장 ──
// 무료 공개 음원은 재생을 위해 TimeLink D1 Object Storage에 저장한다.
app.post('/api/upload/mp3', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\\s+/i,'').trim();
  const user=token ? await verifyToken(token,c.env.JWT_SECRET).catch(()=>null) : null;
  const userId=Number(user?.sub||0);
  if(!userId) return c.json({ok:false,error:'인증 필요'},401);
  try{
    await ensureD1Storage(c.env.DB);
    const form=await c.req.parseBody();
    const file=form['file'] as File;
    if(!file) return c.json({ok:false,error:'MP3 파일이 없습니다.'},400);
    const name=String(file.name||'audio.mp3').replace(/[^a-zA-Z0-9._-]/g,'_');
    const mime=String(file.type||'audio/mpeg').toLowerCase();
    if(file.size<=0) return c.json({ok:false,error:'빈 파일입니다.'},400);
    if(file.size>D1_MAX_FILE_SIZE) return c.json({ok:false,error:'파일당 100MB까지 지원합니다.'},413);
    if(mime!=='audio/mpeg' && !/\\.mp3$/i.test(name)) return c.json({ok:false,error:'MP3 파일만 업로드할 수 있습니다.'},400);
    const raw=new Uint8Array(await file.arrayBuffer());
    const hash=await sha256Hex(raw);
    const key='tracks/u'+userId+'/mp3_'+Date.now()+'_'+name;
    await putD1Object(c.env.DB,key,raw,'audio/mpeg',name);
    return c.json({ok:true,key,size:raw.length,hash,stream_url:'https://api.timelink.digital/api/storage/'+encodeURIComponent(key),storage_mode:'timelink_d1',release_mode:'free_mp3'});
  }catch(e:any){ return c.json({ok:false,error:e?.message||'MP3 저장 실패'},500); }
});

app.post('/api/upload/tl3', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\\s+/i,'').trim();
  const user=token ? await verifyToken(token,c.env.JWT_SECRET).catch(()=>null) : null;
  const userId=Number(user?.sub||0);
  if(!userId) return c.json({ok:false,error:'인증 필요'},401);
  try{
    await ensureD1Storage(c.env.DB);
    const form=await c.req.parseBody();
    const file=form['file'] as File;
    if(!file) return c.json({ok:false,error:'TL3 파일이 없습니다.'},400);
    if(file.size<=7) return c.json({ok:false,error:'TL3 파일이 너무 작습니다.'},400);
    if(file.size>D1_MAX_FILE_SIZE) return c.json({ok:false,error:'파일당 100MB까지 지원합니다.'},413);
    const raw=new Uint8Array(await file.arrayBuffer());
    if(raw[0]!==0x54||raw[1]!==0x4c||raw[2]!==0x4e||raw[3]!==0x4b||raw[4]!==0x02)
      return c.json({ok:false,error:'유효한 TL3(v2) 파일이 아닙니다.'},400);
    const headerLen=(raw[5]<<8)|raw[6];
    if(7+headerLen>raw.length) return c.json({ok:false,error:'TL3 헤더가 손상되었습니다.'},400);
    let meta:any;
    try{ meta=JSON.parse(new TextDecoder().decode(raw.slice(7,7+headerLen))); }
    catch(_){ return c.json({ok:false,error:'TL3 메타데이터가 손상되었습니다.'},400); }
    if(String(meta.cid||'')!==String(userId)) return c.json({ok:false,error:'TL3 창작자 정보가 로그인 사용자와 일치하지 않습니다.'},403);
    const shareId='tl3_'+userId+'_'+crypto.randomUUID().replace(/-/g,'');
    const key='tracks/u'+userId+'/'+shareId+'.tl3';
    await putD1Object(c.env.DB,key,raw,'application/octet-stream',shareId+'.tl3');
    return c.json({ok:true,shareId,key,stream_url:'https://api.timelink.digital/api/storage/'+encodeURIComponent(key),size:raw.length,storage_mode:'timelink_d1',release_mode:'tl3'});
  }catch(e:any){ return c.json({ok:false,error:e?.message||'TL3 저장 실패'},500); }
});

// ── TL3 / 파일 업로드 — R2 없는 D1 Object Storage
const D1_CHUNK_SIZE=D1_OBJECT_CHUNK_SIZE,D1_MAX_FILE_SIZE=D1_MAX_OBJECT_SIZE;
app.post('/api/upload/init',async(c)=>{
  const uid=await playbackUserId(c,false);
  if(!Number.isSafeInteger(uid)||uid<=0)return c.json({ok:false,error:'인증 필요'},401);
  try{
    const body=await c.req.json<any>();
    const trackId=String(body.trackId||'').trim();
    const fileName=String(body.fileName||`${trackId}.tl3`);
    const totalSize=Number(body.totalSize||0);
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(trackId))return c.json({ok:false,error:'유효하지 않은 trackId'},400);
    if(!Number.isSafeInteger(totalSize)||totalSize<=0||totalSize>D1_MAX_FILE_SIZE)return c.json({ok:false,error:'파일 크기가 올바르지 않습니다.'},413);
    const uploadId=crypto.randomUUID().replace(/-/g,'');
    const key=`tracks/u${uid}/${trackId}_${uploadId}.tl3`;
    const upload=await createD1UploadSession(c.env.DB,uid,uploadId,key,fileName,totalSize,'application/octet-stream');
    return c.json({ok:true,...upload,storage_mode:'d1'});
  }catch(e:any){return c.json({ok:false,error:e?.message||'TL3 업로드 초기화 실패'},400);}
});
app.put('/api/upload/part',async(c)=>{
  const uid=await playbackUserId(c,false);
  if(!Number.isSafeInteger(uid)||uid<=0)return c.json({ok:false,error:'인증 필요'},401);
  try{
    const uploadId=String(c.req.query('uploadId')||'');
    const partNumber=Number(c.req.query('partNumber')||0);
    if(!/^[A-Za-z0-9_-]{20,80}$/.test(uploadId))return c.json({ok:false,error:'유효하지 않은 업로드 세션 ID'},400);
    const declaredLength=Number(c.req.header('Content-Length')||0);
    if(declaredLength>D1_CHUNK_SIZE)return c.json({ok:false,error:'청크가 너무 큽니다.',max_chunk_size:D1_CHUNK_SIZE},413);
    const data=new Uint8Array(await c.req.arrayBuffer());
    const result=await writeD1UploadSessionPart(c.env.DB,uid,uploadId,partNumber,data);
    return c.json({ok:true,...result,storage_mode:'d1'});
  }catch(e:any){return c.json({ok:false,error:e?.message||'TL3 청크 업로드 실패'},400);}
});
app.post('/api/upload/complete',async(c)=>{
  const uid=await playbackUserId(c,false);
  if(!Number.isSafeInteger(uid)||uid<=0)return c.json({ok:false,error:'인증 필요'},401);
  try{
    const body=await c.req.json<any>();
    const uploadId=String(body.uploadId||'');
    if(!/^[A-Za-z0-9_-]{20,80}$/.test(uploadId))return c.json({ok:false,error:'유효하지 않은 업로드 세션 ID'},400);
    const meta=await completeD1UploadSession(c.env.DB,uid,uploadId);
    const url=`https://api.timelink.digital/api/storage/${encodeURIComponent(meta.key)}`;
    const trackId=meta.key.split('/').pop()?.replace(/_[A-F0-9]{32}\.tl3$/i,'')||'';
    return c.json({ok:true,url,stream_url:url,key:meta.key,trackId,file_type:'audio/tl3',release_mode:'tl3',size:meta.size,manifest_sha256:meta.manifest_sha256,storage_mode:'d1'});
  }catch(e:any){return c.json({ok:false,error:e?.message||'TL3 업로드 완료 실패'},400);}
});

app.get('/api/storage/:key{.+}', async (c) => {
  try {
    await ensureD1Storage(c.env.DB);
    const key=decodeURIComponent(c.req.param('key'));
    const meta=await getD1ObjectMeta(c.env.DB,key);
    if(!meta) return c.json({error:'파일 없음'},404);

    const canonical=`https://api.timelink.digital/api/storage/${encodeURIComponent(key)}`;
    const viewerId=await playbackUserId(c);
    const scoped=key.match(/^(?:tracks|tl)\/u(\d+)\//);
    const ownerIds=new Set<number>();
    if(scoped) ownerIds.add(Number(scoped[1]));
    let isPublic=false;

    const shareRows=await c.env.DB.prepare(
      'SELECT * FROM tl_shares WHERE stream_url IN (?,?,?) OR stream_url LIKE ?'
    ).bind(canonical,'/api/storage/'+encodeURIComponent(key),key,'%'+key).all<any>().catch(()=>({results:[]}));
    for(const share of (shareRows.results||[])){
      const uid=Number(share.user_id||0);if(uid>0) ownerIds.add(uid);
      if(await isPublicPlaybackShare(c.env.DB,share)) isPublic=true;
    }

    const fileRows=await c.env.DB.prepare(
      "SELECT id,user_id,auth_status,shared,revenue_held,file_url,stream_url,cover_image FROM tl_files WHERE LOWER(file_type)='audio/tl3' AND (stream_url IN (?,?) OR file_url IN (?,?) OR cover_image IN (?,?))"
    ).bind(canonical,'/api/storage/'+encodeURIComponent(key),canonical,'/api/storage/'+encodeURIComponent(key),canonical,'/api/storage/'+encodeURIComponent(key)).all<any>().catch(()=>({results:[]}));
    for(const file of (fileRows.results||[])){
      const uid=Number(file.user_id||0);if(uid>0) ownerIds.add(uid);
      if(Number(file.shared)===1&&Number(file.revenue_held||0)===0){const release=await c.env.DB.prepare("SELECT 1 FROM tl3_releases WHERE file_id=? AND status='released' AND rights_confirmed=1 LIMIT 1").bind(file.id).first();if(release)isPublic=true;}
    }

    const isOwner=ownerIds.has(viewerId)&&viewerId>0;
    if(!isOwner&&!isPublic) return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);

    const cors:Record<string,string>={
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers':'Range, Content-Type, Authorization',
      'Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length',
      'Accept-Ranges':'bytes',
      'Cache-Control':isPublic?'public, max-age=300':'private, no-store'
    };
    const range=c.req.header('Range')||'';
    let start=0,end=meta.size-1,status=200;
    if(range){
      const match=range.match(/bytes=(\d+)-(\d*)/);
      if(!match) return new Response('Invalid Range',{status:416,headers:cors});
      start=Number(match[1]);
      end=match[2]!==''?Math.min(Number(match[2]),meta.size-1):Math.min(start+D1_CHUNK_SIZE-1,meta.size-1);
      status=206;
    }
    if(start<0||start>=meta.size||end<start) return new Response('Range Not Satisfiable',{status:416,headers:cors});
    const bytes=await readD1Range(c.env.DB,key,start,end-start+1);
    const headers:Record<string,string>={...cors,'Content-Type':meta.content_type||'application/octet-stream','Content-Length':String(bytes.byteLength)};
    if(status===206) headers['Content-Range']=`bytes ${start}-${end}/${meta.size}`;
    return new Response(bytes,{status,headers});
  }catch(e:any){return c.json({error:e?.message||'파일 읽기 실패'},500);}
});
app.options('/api/storage/:key{.+}',()=>new Response(null,{status:204}));
app.post('/api/upload',async(c)=>{const session=await storageUser(c),uid=Number(session?.sub||0);if(!Number.isSafeInteger(uid)||uid<=0)return c.json({ok:false,error:'인증 필요'},401);try{await ensureD1Storage(c.env.DB);const f=await c.req.parseBody(),file=f['file'] as File,id=String(f['trackId']||'').trim(),mode=String(f['release_mode']||'').trim().toLowerCase(),isTl3=String(f['isTl3']||'').toLowerCase()==='true';if(!file||!/^[A-Za-z0-9_-]{1,100}$/.test(id))return c.json({ok:false,error:'file, 유효한 trackId 필수'},400);if(file.size<=0||file.size>D1_MAX_FILE_SIZE)return c.json({ok:false,error:'파일 크기가 올바르지 않습니다.'},413);if(isTl3){if(file.size<7)return c.json({ok:false,error:'잘못된 TL3 파일입니다.'},400);const h=new Uint8Array(await file.slice(0,7).arrayBuffer());if(h[0]!==0x54||h[1]!==0x4c||h[2]!==0x4e||h[3]!==0x4b||h[4]!==0x02)return c.json({ok:false,error:'TL3 v2 헤더가 아닙니다.'},400);}const ext=isTl3?'tl3':(mode==='free_mp3'?'mp3':(file.name.split('.').pop()||'bin').toLowerCase());if(!/^[a-z0-9]{1,8}$/.test(ext))return c.json({ok:false,error:'파일 확장자가 올바르지 않습니다.'},400);const key=`tracks/u${uid}/${id}.${ext}`,ct=isTl3?'application/octet-stream':(mode==='free_mp3'?'audio/mpeg':(file.type||'application/octet-stream'));await putD1Object(c.env.DB,key,new Uint8Array(await file.arrayBuffer()),ct,file.name||key);const url=`https://api.timelink.digital/api/storage/${encodeURIComponent(key)}`;return c.json({ok:true,url,stream_url:url,key,trackId:id,file_type:isTl3?'audio/tl3':ct,release_mode:isTl3?'tl3':(mode||'original'),size:file.size,storage_mode:'d1'});}catch(e:any){return c.json({ok:false,error:e?.message||'D1 파일 저장 실패'},500);}});
// ── TL3 시간 세그먼트: MP3 프레임 경계 기반 ─────────────────────────
// (TL3_XOR_KEY 제거됨 — v3에서 마스터 시크릿 사용)

// (tl3Xor 제거됨 — v3에서 AES-256-GCM 사용)

function parseMp3Segments(data: Uint8Array, targetMs=1000): Array<{offset:number,length:number,durationMs:number}> {
  const bitrateV1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const bitrateV2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const sampleBase = [44100,48000,32000,0];
  if (!Number.isFinite(targetMs) || targetMs <= 0 || targetMs > 5000) {
    throw new Error('TL3 Spine 세그먼트 목표 시간은 1~5000ms여야 합니다.');
  }

  const frames: Array<{offset:number,length:number,durationMs:number}> = [];
  let scan = 0;
  if (data.length >= 10 && data[0]===0x49 && data[1]===0x44 && data[2]===0x33) {
    const size = ((data[6]&0x7f)<<21)|((data[7]&0x7f)<<14)|((data[8]&0x7f)<<7)|(data[9]&0x7f);
    scan = 10 + size + ((data[5]&0x10) ? 10 : 0);
    if (scan > data.length) throw new Error('MP3 ID3 헤더 길이가 잘못되었습니다.');
  }

  while (scan + 4 <= data.length) {
    if (data[scan]!==0xff || (data[scan+1]&0xe0)!==0xe0) { scan++; continue; }
    const version = (data[scan+1]>>3)&3;
    const layer = (data[scan+1]>>1)&3;
    const bi = (data[scan+2]>>4)&15;
    const si = (data[scan+2]>>2)&3;
    const padding = (data[scan+2]>>1)&1;
    if (layer!==1 || version===1 || bi===0 || bi===15 || si===3) { scan++; continue; }
    const baseRate = sampleBase[si];
    const sampleRate = version===3 ? baseRate : Math.floor(baseRate/(version===2?2:4));
    const kbps = version===3 ? bitrateV1[bi] : bitrateV2[bi];
    const frameLength = Math.floor((version===3 ? 144000 : 72000) * kbps / sampleRate) + padding;
    if (frameLength < 24 || scan + frameLength > data.length) { scan++; continue; }
    const samples = version===3 ? 1152 : 576;
    frames.push({offset:scan,length:frameLength,durationMs:(samples*1000)/sampleRate});
    scan += frameLength;
  }
  if (!frames.length) throw new Error('지원되는 MP3 프레임을 찾지 못했습니다.');

  // 중간에 임의 바이트를 건너뛰면 그 바이트가 세그먼트에서 빠지므로 변환을 중단한다.
  for (let i=1;i<frames.length;i++) {
    const expected = frames[i-1].offset + frames[i-1].length;
    if (frames[i].offset !== expected) {
      throw new Error('MP3 프레임 사이에 해석할 수 없는 데이터가 있습니다. 손실 방지를 위해 변환을 중단합니다.');
    }
  }
  const firstFrame = frames[0].offset;
  const lastFrameEnd = frames[frames.length-1].offset + frames[frames.length-1].length;
  const prefixLength = firstFrame;
  let suffixLength = data.length - lastFrameEnd;
  if (suffixLength > 0) {
    const hasId3v1 = suffixLength === 128 && data[lastFrameEnd]===0x54 &&
      data[lastFrameEnd+1]===0x41 && data[lastFrameEnd+2]===0x47;
    if (!hasId3v1) throw new Error('MP3 끝부분에 해석할 수 없는 데이터가 있습니다. 원본 보존을 위해 변환을 중단합니다.');
  }

  const out:Array<{offset:number,length:number,durationMs:number}> = [];
  let groupStart = 0;
  let groupEnd = firstFrame;
  let groupDuration = 0;
  for (let i=0;i<frames.length;i++) {
    const frame=frames[i];
    if (groupDuration>0 && groupDuration+frame.durationMs>targetMs) {
      out.push({offset:groupStart,length:groupEnd-groupStart,durationMs:Math.round(groupDuration)});
      groupStart=frame.offset;
      groupDuration=0;
    }
    groupEnd=frame.offset+frame.length;
    groupDuration+=frame.durationMs;
  }
  if (suffixLength) groupEnd=data.length;
  if (groupEnd>groupStart) out.push({offset:groupStart,length:groupEnd-groupStart,durationMs:Math.round(groupDuration)});
  if (!out.length || out[0].offset!==0 || out[out.length-1].offset+out[out.length-1].length!==data.length) {
    throw new Error('MP3 세그먼트가 원본 전체를 연속적으로 포함하지 않습니다.');
  }
  return out;
}

// (buildTL3V2 제거됨 — v3에서 buildTL3V3 사용)

app.post('/api/v1/tl3/releases', async (c) => {
  try {
    const body = await c.req.json<any>();
    // ★ CORS 헤더 강제 설정 (preflight 이후 실제 요청에도 필요)
    const _origin = c.req.header('Origin') || '*';
    c.header('Access-Control-Allow-Origin', _origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (body.rights_confirmed !== true) {
      return c.json({ok:false,error:'저작권 또는 적법한 이용 권한 확인이 필요합니다.'},400);
    }
    const fileId = Number(body.file_id || 0);
    const shareIdParam = String(body.share_id || '');
    if (!fileId || !body.title || !body.artist) return c.json({ok:false,error:'file_id, title, artist가 필요합니다.'},400);
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND is_active=1').bind(payload.sub).first<any>();
    if (!user) return c.json({ok:false,error:'사용자를 확인할 수 없습니다.'},401);
    const file = await c.env.DB.prepare('SELECT id,user_id,title,artist,stream_url FROM tl_files WHERE id=?').bind(fileId).first<any>();
    if (!file || Number(file.user_id)!==Number(user.id)) return c.json({ok:false,error:'본인의 음원만 TL3로 출시할 수 있습니다.'},403);
    const sourceUrl = String(file.stream_url || '');
    if (!sourceUrl) return c.json({ok:false,error:'TL3 출시용 원본 주소가 없습니다.'},400);

    // LP 전체 오디오는 저장하지 않고 재생 파라미터만 기록한다.
    const lpLicense: any = body.lp_license || null;
    let lpHashed: string | null = null;
    const lpPrice = lpLicense && lpLicense.lp_enabled === true
      ? Math.max(0, Math.floor(Number(lpLicense.lp_price_tl || 1000))) : 0;
    let lpAlreadyCharged = false;

    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, artist TEXT NOT NULL, price_tl INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'released', tl3_key TEXT, payload_offset INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0, segment_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
    for (const sql of [
      "ALTER TABLE tl3_releases ADD COLUMN tl3_key TEXT",
      "ALTER TABLE tl3_releases ADD COLUMN payload_offset INTEGER DEFAULT 0",
      "ALTER TABLE tl3_releases ADD COLUMN duration_ms INTEGER DEFAULT 0",
      "ALTER TABLE tl3_releases ADD COLUMN segment_count INTEGER DEFAULT 0"
    ]) { try { await c.env.DB.prepare(sql).run(); } catch (_) {} }
    try { await c.env.DB.prepare('ALTER TABLE tl3_releases ADD COLUMN header_json TEXT').run(); } catch (_) {}
    const priorRelease = await c.env.DB.prepare('SELECT header_json,status FROM tl3_releases WHERE file_id=?').bind(fileId).first<any>();
    if (priorRelease && String(priorRelease.status) === 'released') {
      try { lpAlreadyCharged = JSON.parse(String(priorRelease.header_json || '{}'))?.lp_meta?.enabled === true; } catch (_) {}
    }
    if (lpPrice > 0 && !lpAlreadyCharged) {
      const walletRow = await c.env.DB.prepare('SELECT tl_p,tl_a,tl_b,tl_balance,tl,CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END p,COALESCE(tl_a,0) a,COALESCE(tl_b,0) b FROM users WHERE id=?').bind(user.id).first<any>();
      if (!walletRow) return c.json({ok:false,error:'사용자 잔액 조회 실패'},500);
      const wallet = tlWalletParts(walletRow);
      const balance = wallet.p + wallet.a + wallet.b;
      if (balance < lpPrice) return c.json({ok:false,error:'LP 적용에 필요한 TL이 부족합니다. (필요: '+lpPrice+' TL / 보유: '+balance+' TL)',code:'LP_INSUFFICIENT_TL'},402);
    }
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_segments (
      file_id INTEGER NOT NULL, segment_index INTEGER NOT NULL, offset INTEGER NOT NULL,
      length INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      PRIMARY KEY(file_id, segment_index)
    )`).run();

    // TL3_SELFFETCH_FIX: self-fetch 우회 — D1 직접 읽기
    let raw: Uint8Array;
    {
      const sp = '/api/storage/';
      const si = sourceUrl.indexOf(sp);
      if (si >= 0) {
        const key = decodeURIComponent(sourceUrl.slice(si + sp.length).split('?')[0]);
        const meta = await getD1ObjectMeta(c.env.DB, key);
        if (!meta) return c.json({ok:false,error:'원본 MP3 (D1) 없음: '+key},404);
        raw = await readD1Range(c.env.DB, key, 0, meta.size);
      } else {
        const upstream = await fetch(sourceUrl);
        if (!upstream.ok) return c.json({ok:false,error:'원본 MP3 가져오기 실패 (HTTP '+upstream.status+')'},502);
        raw = new Uint8Array(await upstream.arrayBuffer());
      }
    }
    if (raw.length > 100*1024*1024) return c.json({ok:false,error:'TL3 출시용 음원은 100MB 이하만 지원합니다.'},413);

    // TL3 정식 규격: MP3 프레임 경계를 보존하며 최대 1초 단위로 분할한다.
    const segments = parseMp3Segments(raw,5000);  // 2026-10-19: 5초 세그먼트 (1초 세그먼트 응답 지연 해결)
    const durationMs = segments.reduce((n,x)=>n+x.durationMs,0);

    // ★ 음원 길이(초) = 재생에 필요한 TL량 (초당 1TL)
    const durationSec = Math.max(1, Math.ceil(durationMs / 1000));
    const price = durationSec; // price_tl 컬럼에 초 단위 TL 저장 (기존 스키마 호환)

    // 마스터 시크릿
    const masterSecret = String((c.env as any).TL3_MASTER_SECRET || '');
    if (!masterSecret) return c.json({ok:false,error:'TL3_MASTER_SECRET not set'},500);

    // Ensure the release schema is ready before checking share ID ownership.
    try { await c.env.DB.prepare('ALTER TABLE tl3_releases ADD COLUMN share_id TEXT').run(); } catch (_) {}
    // Remove any legacy unique index whose sole indexed column is share_id.
    // Index names are read from SQLite metadata and quoted before use.
    const releaseIndexes = await c.env.DB.prepare("PRAGMA index_list('tl3_releases')").all<any>().catch(() => ({results:[]}));
    for (const idx of (releaseIndexes.results || [])) {
      if (Number(idx.unique) !== 1 || String(idx.origin || '') === 'pk') continue;
      const indexName = String(idx.name || '').replace(/"/g, '""');
      if (!indexName) continue;
      const indexColumns = await c.env.DB.prepare(`PRAGMA index_info("${indexName}")`).all<any>().catch(() => ({results:[]}));
      const columns = (indexColumns.results || []).map((col:any) => String(col.name || '').toLowerCase());
      if (columns.length === 1 && columns[0] === 'share_id') {
        await c.env.DB.prepare(`DROP INDEX IF EXISTS "${indexName}"`).run();
      }
    }
    await c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tl3_releases_share_id_lookup ON tl3_releases(share_id)').run().catch(() => {});
    // share_id groups SharePlace entries; it is intentionally reusable across assets.
    const shareId = shareIdParam || `tl3_${fileId}`;

    // v3 빌드 (AES-256-GCM + 타임토큰 체인)
    // LP 오디오는 TL3 컨테이너에 포함하지 않는다. 재생 시점에 Player DSP로 적용한다.
    const build = await buildTL3V4FromMp3({
      fileId: fileId,
      title: file.title,
      artist: file.artist,
      cid: String(user.id),
      name: String(user.id),
      creator_id: Number(user.id),
      mp3Raw: raw,
      segments,
      lpOpusData: null, // LP 실시간 DSP: 추가 오디오 페이로드 없음
      masterSecret,
      shareId,
      licId: 'k_2026_01'
    });

    const tl3Key = `tl3/releases/${fileId}.tl3`;
    await putD1Object(c.env.DB, tl3Key, build.data, 'application/octet-stream', `${file.title}.tl3`);

    // LP 요금은 TL3 파일 생성과 D1 저장이 성공한 뒤 한 번만 차감한다.
    if (lpPrice > 0 && !lpAlreadyCharged) {
      const walletRow = await c.env.DB.prepare('SELECT tl_p,tl_a,tl_b,tl_balance,tl,CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END p,COALESCE(tl_a,0) a,COALESCE(tl_b,0) b FROM users WHERE id=?').bind(user.id).first<any>();
      if (!walletRow) return c.json({ok:false,error:'LP 요금 결제 중 사용자 잔액 조회 실패'},500);
      const wallet = tlWalletParts(walletRow);
      if (wallet.p + wallet.a + wallet.b < lpPrice) return c.json({ok:false,error:'LP 요금 결제 중 잔액이 변경되었습니다. 다시 시도해 주세요.',code:'LP_INSUFFICIENT_TL'},402);
      let left = lpPrice;
      const takeP = Math.min(left,wallet.p); left = Number((left-takeP).toFixed(6));
      const takeA = Math.min(left,wallet.a); left = Number((left-takeA).toFixed(6));
      const takeB = Math.min(left,wallet.b); left = Number((left-takeB).toFixed(6));
      const debit = await c.env.DB.prepare(`UPDATE users SET
        tl_p=COALESCE(tl_p,tl,tl_balance,0)-?,
        tl_a=COALESCE(tl_a,0)-?,
        tl_b=COALESCE(tl_b,0)-?,
        tl=COALESCE(tl_p,tl,tl_balance,0)-?+COALESCE(tl_a,0)-?+COALESCE(tl_b,0)-?,
        total_tl_spent=COALESCE(total_tl_spent,0)+?,updated_at=datetime('now')
        WHERE id=? AND COALESCE(tl_p,tl,tl_balance,0)>=? AND COALESCE(tl_a,0)>=? AND COALESCE(tl_b,0)>=?`)
        .bind(takeP,takeA,takeB,takeP,takeA,takeB,lpPrice,user.id,takeP,takeA,takeB).run();
      if (!debit.meta?.changes) return c.json({ok:false,error:'LP 요금 차감이 동시 잔액 변경으로 취소되었습니다. 다시 시도해 주세요.',code:'LP_DEBIT_CONFLICT'},409);
      try {
        await c.env.DB.prepare("INSERT INTO transactions (user_id, tx_type, amount, note, created_at) VALUES (?, 'lp_charge', ?, 'LP 음질 향상', datetime('now'))").bind(user.id,-lpPrice).run();
      } catch (_) {}
    }

    // ─ D1: tl3_releases v3 컬럼 확장
    for (const sql of [
      'ALTER TABLE tl3_releases ADD COLUMN fid TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN salt TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN lic_id TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN hash_mp3 TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN hash_lp TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN header_json TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN mp3_token_root TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN mp3_token_latest TEXT',
      'ALTER TABLE tl3_releases ADD COLUMN rights_confirmed INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE tl3_releases ADD COLUMN rights_confirmed_at TEXT'
    ]) { try { await c.env.DB.prepare(sql).run(); } catch (_) {} }

    // ─ D1: tl3_tokens (v3 신규)
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_tokens (
      share_id TEXT NOT NULL, kind TEXT NOT NULL, segment_index INTEGER NOT NULL,
      token TEXT NOT NULL, PRIMARY KEY (share_id, kind, segment_index)
    )`).run();
    // Keep token chains isolated per asset even when SharePlace ID is reused.
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_release_tokens (
      file_id INTEGER NOT NULL, share_id TEXT NOT NULL, kind TEXT NOT NULL,
      segment_index INTEGER NOT NULL, token TEXT NOT NULL,
      PRIMARY KEY (file_id, kind, segment_index)
    )`).run();

    // ─ D1: tl3_segments 확장 (ciphertext 위치)
    for (const sql of [
      'ALTER TABLE tl3_segments ADD COLUMN ct_offset INTEGER',
      'ALTER TABLE tl3_segments ADD COLUMN ct_length INTEGER'
    ]) { try { await c.env.DB.prepare(sql).run(); } catch (_) {} }

    // ─ 세그먼트 저장 (mp3 프레임 + ciphertext 위치)
    await c.env.DB.prepare('DELETE FROM tl3_segments WHERE file_id=?').bind(fileId).run();
    let ctOffset = build.header.mp3.first_offset;
    for (let i=0;i<segments.length;i++) {
      const seg = segments[i];
      const ctLen = build.ctLens[i];
      await c.env.DB.prepare('INSERT INTO tl3_segments(file_id,segment_index,offset,length,duration_ms,ct_offset,ct_length) VALUES(?,?,?,?,?,?,?)')
        .bind(fileId, i, seg.offset, seg.length, seg.durationMs, ctOffset, ctLen).run();
      ctOffset += ctLen;
    }

    // ─ 토큰 체인 저장 (mp3)
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < build.mp3Tokens.length; i++) {
      stmts.push(
        c.env.DB.prepare('INSERT OR REPLACE INTO tl3_release_tokens(file_id, share_id, kind, segment_index, token) VALUES (?,?,?,?,?)')
          .bind(fileId, shareId, 'mp3', i, build.mp3Tokens[i])
      );
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }

    // ─ tl3_releases INSERT/UPDATE
    const hdr = build.header;
    // ★ LP 메타 + 차분 저장
    if (lpLicense && lpLicense.lp_enabled === true) {
      (hdr as any).lp_meta = {
        enabled: true,
        price_tl: Math.max(0, Math.floor(Number(lpLicense.lp_price_tl || 1000))),
        patent: String(lpLicense.lp_patent || '10-2025-0167813'),
        seed: Number(lpLicense.lp_seed || 0),
        g: lpLicense.lp_g || null,
        fs: Number(lpLicense.lp_fs || 0),
        n: Number(lpLicense.lp_n || 0),
        version: String(lpLicense.lp_version || 'lp-v1-runtime'),
        processing: 'player-realtime',
        audio_payload_bytes: 0
      };
    }
    await c.env.DB.prepare(`INSERT INTO tl3_releases
      (file_id,user_id,title,artist,price_tl,status,tl3_key,payload_offset,duration_ms,segment_count,
       fid,salt,lic_id,hash_mp3,hash_lp,header_json,mp3_token_root,mp3_token_latest,share_id,
       rights_confirmed,rights_confirmed_at)
      VALUES (?,?,?,?,?,'released',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET price_tl=excluded.price_tl,status='released',
      rights_confirmed=1,rights_confirmed_at=datetime('now'),
      tl3_key=excluded.tl3_key,payload_offset=excluded.payload_offset,duration_ms=excluded.duration_ms,
      segment_count=excluded.segment_count,fid=excluded.fid,salt=excluded.salt,lic_id=excluded.lic_id,
      hash_mp3=excluded.hash_mp3,hash_lp=excluded.hash_lp,header_json=excluded.header_json,
      mp3_token_root=excluded.mp3_token_root,mp3_token_latest=excluded.mp3_token_latest,
      share_id=excluded.share_id,
      updated_at=datetime('now')
    `).bind(
      fileId, user.id, file.title, file.artist, price, tl3Key, hdr.mp3.first_offset,
      durationMs, segments.length,
      hdr.fid, hdr.salt, hdr.lic_id, hdr.hash_mp3, lpHashed, JSON.stringify(hdr),
      build.mp3Tokens[0], build.mp3Tokens[build.mp3Tokens.length - 1], shareId,
      1, new Date().toISOString()
    ).run();

    const savedRelease = await c.env.DB.prepare('SELECT file_id,user_id,share_id FROM tl3_releases WHERE file_id=?').bind(fileId).first<any>();
    if (!savedRelease || Number(savedRelease.user_id)!==Number(user.id) || String(savedRelease.share_id)!==shareId) {
      return c.json({ok:false,error:'TL3 릴리스 저장 충돌이 발생했습니다. 기존 데이터는 보존했습니다.',code:'TL3_RELEASE_SAVE_CONFLICT'},409);
    }

    await c.env.DB.prepare("UPDATE tl_files SET file_type='audio/tl3', shared=1, shared_to_shareplace=1, updated_at=datetime('now') WHERE id=?").bind(fileId).run();
    if (shareIdParam) {
      await c.env.DB.prepare("UPDATE tl_shares SET file_type='audio/tl3' WHERE CAST(id AS TEXT)=? AND CAST(user_id AS INTEGER)=?")
        .bind(shareIdParam, Number(user.id)).run().catch(() => {});
    }
    return c.json({ok:true,file_id:fileId,share_id:shareId,price_tl:price,duration_sec:durationSec,status:'released',duration_ms:durationMs,segment_count:segments.length,tl3_key:tl3Key,version:3});
  } catch(e:any) { return c.json({ok:false,error:e.message||'TL3 release error'},500); }
});

// GET /api/v1/tl3/resolve/:shareId — shareId (sh_...) → file_id 조회

// ── TL3 Spine v4: 별도 제조 및 검증 가능한 보관본 생성 ──
// v3 릴리스/재생 경로는 변경하지 않는다. v4 플레이어 배포 전에는 공개 재생으로 노출하지 않는다.
app.post('/api/v1/tl3/spine/releases', async (c) => {
  try {
    let body:any;
    let sourceFile:File|null=null;
    const contentType=String(c.req.header('Content-Type')||'');
    if(contentType.includes('multipart/form-data')){
      const form=await c.req.parseBody();
      sourceFile=(form['file'] instanceof File)?form['file'] as File:null;
      try{ body=JSON.parse(String(form['metadata']||'{}')); }catch(_){ body={}; }
    }else{ body=await c.req.json<any>(); }
    if (body.rights_confirmed !== true) return c.json({ok:false,error:'저작권 또는 적법한 이용 권한 확인이 필요합니다.'},400);
    const fileId = Number(body.file_id || 0);
    const shareId = String(body.share_id || '');
    if (!Number.isSafeInteger(fileId) || fileId <= 0 || !shareId) return c.json({ok:false,error:'file_id와 share_id가 필요합니다.'},400);
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth,c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND is_active=1').bind(payload.sub).first<any>();
    if (!user) return c.json({ok:false,error:'사용자를 확인할 수 없습니다.'},401);
    const file = await c.env.DB.prepare('SELECT id,user_id,title,artist,stream_url FROM tl_files WHERE id=?').bind(fileId).first<any>();
    if (!file || Number(file.user_id)!==Number(user.id)) return c.json({ok:false,error:'본인의 음원만 TL3로 자산화할 수 있습니다.'},403);
    const lpLicense=body.lp_license||null;
    const lpPrice=lpLicense&&lpLicense.lp_enabled===true?Math.max(0,Math.floor(Number(lpLicense.lp_price_tl||1000))):0;
    let lpAlreadyCharged=false;
    const priorV4=await c.env.DB.prepare('SELECT header_json,status FROM tl3_spine_v4_releases WHERE file_id=?').bind(fileId).first<any>().catch(()=>null);
    if(priorV4){try{lpAlreadyCharged=JSON.parse(String(priorV4.header_json||'{}'))?.lp_meta?.enabled===true;}catch(_){}}
    if(lpPrice>0&&!lpAlreadyCharged){
      const wr=await c.env.DB.prepare('SELECT tl_p,tl_a,tl_b,tl_balance,tl,CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END p,COALESCE(tl_a,0) a,COALESCE(tl_b,0) b FROM users WHERE id=?').bind(user.id).first<any>();
      const wp=tlWalletParts(wr);
      if(wp.p+wp.a+wp.b<lpPrice)return c.json({ok:false,error:'LP 적용에 필요한 TL이 부족합니다.',code:'LP_INSUFFICIENT_TL',required:lpPrice,balance:wp.p+wp.a+wp.b},402);
    }
    let raw:Uint8Array;
    if(sourceFile){
      if(sourceFile.size<=0 || sourceFile.size>100*1024*1024) return c.json({ok:false,error:'TL3 원본은 100MB 이하만 지원합니다.'},413);
      raw=new Uint8Array(await sourceFile.arrayBuffer());
    }else{
      const sourceUrl=String(file.stream_url||'');
      if(!sourceUrl) return c.json({ok:false,error:'로컬 원본 MP3 전송이 필요합니다.'},400);
      const storagePath='/api/storage/';
      const storageIndex=sourceUrl.indexOf(storagePath);
      if(storageIndex>=0){
        const key=decodeURIComponent(sourceUrl.slice(storageIndex+storagePath.length).split('?')[0]);
        const meta=await getD1ObjectMeta(c.env.DB,key);
        if(!meta) return c.json({ok:false,error:'원본 음원을 찾을 수 없습니다.'},404);
        raw=await readD1Range(c.env.DB,key,0,meta.size);
      }else{
        const upstream=await fetch(sourceUrl);
        if(!upstream.ok) return c.json({ok:false,error:'원본 음원 가져오기 실패 (HTTP '+upstream.status+')'},502);
        raw=new Uint8Array(await upstream.arrayBuffer());
      }
    }
    if(raw.length>100*1024*1024) return c.json({ok:false,error:'TL3 음원은 100MB 이하만 지원합니다.'},413);
    const segments=parseMp3Segments(raw,1000); // TL3-SPINE-1 규격: 세그먼트 최대 1000ms
    const masterSecret=String((c.env as any).TL3_MASTER_SECRET||'');
    if(!masterSecret) return c.json({ok:false,error:'TL3_MASTER_SECRET not set'},500);
    const build=await buildTL3SpineV4({
      fileId,shareId,title:String(file.title),artist:String(file.artist),
      creatorId:Number(user.id),mp3Raw:raw,segments,masterSecret,
      licId:'k_2026_spine_1',rightsConfirmed:true,lpMeta:body.lp_license||null
    });
    const objectKey=`tl3/spine-v4/${fileId}/${Date.now()}.tl3`;
    await putD1Object(c.env.DB,objectKey,build.data,'application/octet-stream',String(file.title)+'.tl3');
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_spine_v4_releases (
      file_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, share_id TEXT NOT NULL,
      object_key TEXT NOT NULL, header_json TEXT NOT NULL, segment_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, spine_root TEXT NOT NULL, spine_latest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sealed', created_at TEXT DEFAULT (datetime('now'))
    )`).run();
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_spine_v4_tokens (
      file_id INTEGER NOT NULL, token_index INTEGER NOT NULL, token TEXT NOT NULL,
      PRIMARY KEY(file_id,token_index)
    )`).run();
    await c.env.DB.prepare('DELETE FROM tl3_spine_v4_tokens WHERE file_id=?').bind(fileId).run();
    const tokenStatements: D1PreparedStatement[] = build.spineTokens.map((token,index)=>
      c.env.DB.prepare('INSERT INTO tl3_spine_v4_tokens(file_id,token_index,token) VALUES(?,?,?)').bind(fileId,index,token)
    );
    for(let i=0;i<tokenStatements.length;i+=50) await c.env.DB.batch(tokenStatements.slice(i,i+50));
    await c.env.DB.prepare(`INSERT INTO tl3_spine_v4_releases
      (file_id,user_id,share_id,object_key,header_json,segment_count,duration_ms,spine_root,spine_latest,status)
      VALUES(?,?,?,?,?,?,?,?,?,'sealed')
      ON CONFLICT(file_id) DO UPDATE SET user_id=excluded.user_id,share_id=excluded.share_id,
      object_key=excluded.object_key,header_json=excluded.header_json,segment_count=excluded.segment_count,
      duration_ms=excluded.duration_ms,spine_root=excluded.spine_root,spine_latest=excluded.spine_latest,
      status='sealed',created_at=datetime('now')`
    ).bind(fileId,Number(user.id),shareId,objectKey,JSON.stringify(build.header),
      build.header.segment_count,build.header.duration_ms,build.header.spine_root,build.header.spine_latest).run();
    // Publish the v4 container through the existing metered segment/session ledger.
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, artist TEXT NOT NULL, price_tl INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'released', tl3_key TEXT, payload_offset INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0, segment_count INTEGER DEFAULT 0,
      header_json TEXT, share_id TEXT, rights_confirmed INTEGER NOT NULL DEFAULT 0, rights_confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
    for(const sql of ['ALTER TABLE tl3_releases ADD COLUMN header_json TEXT','ALTER TABLE tl3_releases ADD COLUMN share_id TEXT','ALTER TABLE tl3_releases ADD COLUMN rights_confirmed INTEGER NOT NULL DEFAULT 0','ALTER TABLE tl3_releases ADD COLUMN rights_confirmed_at TEXT','ALTER TABLE tl3_releases ADD COLUMN updated_at TEXT']) {
      try{ await c.env.DB.prepare(sql).run(); }catch(_){}
    }
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_segments (
      file_id INTEGER NOT NULL, segment_index INTEGER NOT NULL, offset INTEGER NOT NULL,
      length INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      PRIMARY KEY(file_id, segment_index)
    )`).run();
    for(const sql of ['ALTER TABLE tl3_segments ADD COLUMN ct_offset INTEGER','ALTER TABLE tl3_segments ADD COLUMN ct_length INTEGER']) {
      try{ await c.env.DB.prepare(sql).run(); }catch(_){}
    }
    const headerBytes=new TextEncoder().encode(JSON.stringify(build.header));
    const payloadOffset=9+headerBytes.length;
    await c.env.DB.prepare(`INSERT INTO tl3_releases
      (file_id,user_id,title,artist,price_tl,status,tl3_key,payload_offset,duration_ms,segment_count,header_json,share_id,rights_confirmed,rights_confirmed_at)
      VALUES(?,?,?,?,0,'released',?,?,?,?,?,?,1,datetime('now'))
      ON CONFLICT(file_id) DO UPDATE SET user_id=excluded.user_id,title=excluded.title,artist=excluded.artist,
      status='released',tl3_key=excluded.tl3_key,payload_offset=excluded.payload_offset,
      duration_ms=excluded.duration_ms,segment_count=excluded.segment_count,
      header_json=excluded.header_json,share_id=excluded.share_id,rights_confirmed=1,rights_confirmed_at=datetime('now'),updated_at=datetime('now')`
    ).bind(fileId,Number(user.id),String(file.title),String(file.artist),objectKey,payloadOffset,
      build.header.duration_ms,build.header.segment_count,JSON.stringify(build.header),shareId).run();
    await c.env.DB.prepare('DELETE FROM tl3_segments WHERE file_id=?').bind(fileId).run();
    let cipherOffset=payloadOffset,plainOffset=0;
    for(let i=0;i<segments.length;i++){
      const seg=segments[i],cipherLength=build.ciphertextLengths[i];
      await c.env.DB.prepare('INSERT INTO tl3_segments(file_id,segment_index,offset,length,duration_ms,ct_offset,ct_length) VALUES(?,?,?,?,?,?,?)')
        .bind(fileId,i,plainOffset,seg.length,build.header.segment_durations_ms[i],cipherOffset,cipherLength).run();
      plainOffset+=seg.length; cipherOffset+=cipherLength;
    }
    await c.env.DB.prepare("UPDATE tl_files SET file_type='audio/tl3',stream_url=?,shared=1,shared_to_shareplace=1,updated_at=datetime('now') WHERE id=?").bind('https://api.timelink.digital/api/v1/tl3/spine/header/'+fileId,fileId).run();
    if(lpPrice>0&&!lpAlreadyCharged){
      const walletRow=await c.env.DB.prepare('SELECT tl_p,tl_a,tl_b,tl_balance,tl,CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END p,COALESCE(tl_a,0) a,COALESCE(tl_b,0) b FROM users WHERE id=?').bind(user.id).first<any>();
      if(!walletRow)return c.json({ok:false,error:'LP 요금 결제 중 사용자 잔액 조회 실패'},500);
      const wallet=tlWalletParts(walletRow);
      if(wallet.p+wallet.a+wallet.b<lpPrice)return c.json({ok:false,error:'LP 요금 결제 중 잔액이 변경되었습니다.',code:'LP_INSUFFICIENT_TL'},402);
      let left=lpPrice;const takeP=Math.min(left,wallet.p);left=Number((left-takeP).toFixed(6));
      const takeA=Math.min(left,wallet.a);left=Number((left-takeA).toFixed(6));
      const takeB=Math.min(left,wallet.b);left=Number((left-takeB).toFixed(6));
      const debit=await c.env.DB.prepare(`UPDATE users SET
        tl_p=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END)-?,
        tl_a=COALESCE(tl_a,0)-?,tl_b=COALESCE(tl_b,0)-?,
        tl_balance=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END)-?,
        tl=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END)-?,
        total_tl_spent=COALESCE(total_tl_spent,0)+?,updated_at=datetime('now')
        WHERE id=? AND (CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END)>=?
        AND COALESCE(tl_a,0)>=? AND COALESCE(tl_b,0)>=?`)
        .bind(takeP,takeA,takeB,lpPrice,lpPrice,lpPrice,user.id,takeP,takeA,takeB).run();
      if(!debit.meta?.changes)return c.json({ok:false,error:'LP 요금 차감 충돌',code:'LP_DEBIT_CONFLICT'},409);
      try{await c.env.DB.prepare("INSERT INTO transactions (user_id,tx_type,amount,note,created_at) VALUES (?,'lp_charge',?,'LP 음질 향상',datetime('now'))").bind(user.id,-lpPrice).run();}catch(_){}
    }
    return c.json({ok:true,profile:'TL3-SPINE-1',version:4,file_id:fileId,share_id:shareId,
      status:'released',duration_ms:build.header.duration_ms,segment_count:build.header.segment_count,
      container_bytes:build.data.length,spine_root:build.header.spine_root,spine_latest:build.header.spine_latest,
      message:'TL3 v4 제조·무결성 체인 저장 및 Track 공개가 완료되었습니다.'});
  } catch(e:any) {
    return c.json({ok:false,error:e?.message||'TL3 Spine v4 변환 실패'},500);
  }
});

app.get('/api/v1/tl3/spine/:id/verify', async (c) => {
  try {
    const auth=c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    if(!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const rawId=String(c.req.param('id')||'');
    const fileId=Number(rawId);
    if(!Number.isSafeInteger(fileId)||fileId<=0||String(fileId)!==rawId) return c.json({ok:false,error:'잘못된 file_id'},400);
    const row=await c.env.DB.prepare('SELECT user_id,header_json,segment_count,status FROM tl3_spine_v4_releases WHERE file_id=?').bind(fileId).first<any>();
    if(!row) return c.json({ok:false,error:'Spine v4 자산을 찾을 수 없습니다.'},404);
    if(Number(row.user_id)!==Number(payload.sub)) return c.json({ok:false,error:'본인 자산만 검증할 수 있습니다.'},403);
    const header=JSON.parse(String(row.header_json||'{}'));
    const tokens=await c.env.DB.prepare('SELECT token_index,token FROM tl3_spine_v4_tokens WHERE file_id=? ORDER BY token_index ASC').bind(fileId).all<any>();
    const chain=(tokens.results||[]);
    const ordered=chain.every((item:any,index:number)=>Number(item.token_index)===index);
    const meta=await getD1ObjectMeta(c.env.DB,String((await c.env.DB.prepare(
      'SELECT object_key FROM tl3_spine_v4_releases WHERE file_id=?'
    ).bind(fileId).first<any>())?.object_key||''));
    if(!meta) return c.json({ok:false,valid:false,error:'TL3 Spine 컨테이너를 찾을 수 없습니다.'},404);
    const container=await readD1Range(c.env.DB,String((await c.env.DB.prepare(
      'SELECT object_key FROM tl3_spine_v4_releases WHERE file_id=?'
    ).bind(fileId).first<any>())?.object_key||''),0,meta.size);
    const result=ordered
      ? await verifyTL3SpineV4Container(container,header,chain.map((item:any)=>String(item.token)))
      : {valid:false,reason:'스파인 토큰 순서 오류'};
    return c.json({ok:true,valid:result.valid,reason:result.reason||null,
      profile:'TL3-SPINE-1',version:4,file_id:fileId,
      segment_count:Number(row.segment_count),spine_tokens:chain.length,
      status:result.valid?row.status:'integrity_error'});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'Spine 검증 실패'},500); }
});

// Public authenticated TL3 Spine v4 header consumed by the v4 Track player.
app.get('/api/v1/tl3/spine/header/:id', async (c) => {
  try {
    const auth=c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    if(!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const rawId=String(c.req.param('id')||'');
    const numeric=Number(rawId);
    const fileId=Number.isSafeInteger(numeric)&&numeric>0&&String(numeric)===rawId
      ? numeric : await resolveTL3FileId(c.env.DB,rawId);
    if(!fileId) return c.json({ok:false,error:'TL3 v4 자산을 찾을 수 없습니다.'},404);
    const row=await c.env.DB.prepare("SELECT header_json,segment_count,duration_ms,share_id,status FROM tl3_spine_v4_releases WHERE file_id=? AND status='sealed'").bind(fileId).first<any>();
    if(!row) return c.json({ok:false,error:'공개된 TL3 v4 자산이 없습니다.'},404);
    const header=JSON.parse(String(row.header_json||'{}'));
    const tokenRows=await c.env.DB.prepare('SELECT token_index,token FROM tl3_spine_v4_tokens WHERE file_id=? ORDER BY token_index').bind(fileId).all<any>();
    const tokens=(tokenRows.results||[]).map((x:any)=>String(x.token));
    if(tokens.length!==Number(row.segment_count)+1) return c.json({ok:false,error:'Spine token chain is incomplete.'},409);
    return c.json({ok:true,version:4,file_id:fileId,share_id:String(row.share_id),
      duration_ms:Number(row.duration_ms),segment_count:Number(row.segment_count),header,spine_tokens:tokens});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'TL3 v4 header error'},500); }
});

app.get('/api/v1/tl3/resolve/:shareId', async (c) => {
  try {
    const shareId = c.req.param('shareId');
    if (!shareId) return c.json({ok:false,error:'shareId 필요'},400);
    const numericFileId=Number(shareId);
    const fileId=Number.isSafeInteger(numericFileId)&&numericFileId>0&&String(numericFileId)===shareId
      ? numericFileId : await resolveTL3FileId(c.env.DB,shareId);
    if(!fileId) return c.json({ok:false,error:'해당 SharePlace 항목에 연결된 TL3 자산을 하나로 특정할 수 없습니다.',share_id:shareId},404);
    const row = await c.env.DB.prepare(
      "SELECT file_id,title,artist,duration_ms,segment_count,price_tl FROM tl3_releases WHERE file_id=? AND status='released'"
    ).bind(fileId).first<any>();
    if (!row) return c.json({ok:false,error:'TL3 release not found'},404);
    return c.json({ok:true, file_id:row.file_id, title:row.title, artist:row.artist, duration_ms:row.duration_ms, segment_count:row.segment_count, price_tl:row.price_tl});
  } catch(e:any) { return c.json({ok:false,error:e.message||'resolve error'},500); }
});

// GET /api/v1/tl3/lp-flac/:fileId — LP FLAC 다운로드 (LP_FLAC_ROUTE)
app.get('/api/v1/tl3/lp-flac/:fileId', async (c) => {
  try {
    const rawId = String(c.req.param('fileId') || '');
    const fileId = Number(rawId);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) {
      return c.json({ok:false,error:'유효한 file_id가 아닙니다.'},400);
    }

    // 릴리스 확인
    const row = await c.env.DB.prepare(
      "SELECT file_id,user_id,header_json FROM tl3_releases WHERE file_id=? AND status='released'"
    ).bind(fileId).first<any>();
    if (!row) return c.json({ok:false,error:'TL3 release not found'},404);

    // lp_meta 확인
    let hdr: any = {};
    try { hdr = JSON.parse(row.header_json || '{}'); } catch(_) {}
    const lpMeta = hdr.lp_meta;
    if (!lpMeta || !lpMeta.enabled) {
      return c.json({ok:false,error:'이 자산은 LP Enhanced가 활성화되지 않았습니다.'},404);
    }

    // D1 Object Storage에서 차분 로드
    const flacKey = `tl3/lp_flacs/${fileId}.flac`;
    const meta = await getD1ObjectMeta(c.env.DB, flacKey);
    if (!meta) return c.json({ok:false,error:'LP FLAC 파일을 찾을 수 없습니다.'},404);

    const bytes = await readD1Range(c.env.DB, flacKey, 0, meta.size);
    if (!bytes || !bytes.length) return c.json({ok:false,error:'LP FLAC 읽기 실패'},502);

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'X-LP-Codec': 'flac',
        'X-LP-N': String(lpMeta.flac_n || 0),
        'X-LP-FS': String(lpMeta.flac_fs || 44100),
        'X-LP-Patent': String(lpMeta.patent || '10-2025-0167813'),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch(e:any) {
    return c.json({ok:false,error:e?.message||'LP FLAC 로드 실패'},500);
  }
});

// GET /api/v1/tl3/file/:shareId — .tl3 파일 다운로드 (TL3_FILE_ROUTE)
app.get('/api/v1/tl3/file/:shareId', async (c) => {
  try {
    const shareId = c.req.param('shareId');
    if (!shareId) return c.json({ok:false,error:'shareId 필요'},400);
    const numericFileId=Number(shareId);
    const fileId=Number.isSafeInteger(numericFileId)&&numericFileId>0&&String(numericFileId)===shareId
      ? numericFileId : await resolveTL3FileId(c.env.DB,shareId);
    if(!fileId) return c.json({ok:false,error:'해당 SharePlace 항목에 연결된 TL3 자산을 하나로 특정할 수 없습니다.',share_id:shareId},404);
    const row = await c.env.DB.prepare(
      "SELECT file_id FROM tl3_releases WHERE file_id=? AND status='released'"
    ).bind(fileId).first<any>();
    if (!row) return c.json({ok:false,error:'TL3 release not found'},404);
    const key = `tl3/releases/${row.file_id}.tl3`;
    const meta = await getD1ObjectMeta(c.env.DB, key);
    if (!meta) return c.json({ok:false,error:'TL3 파일 없음: '+key},404);
    const tf = await c.env.DB.prepare('SELECT title FROM tl_files WHERE id=?').bind(row.file_id).first<any>();
    const titleRaw = String(tf?.title || shareId);
    const safeTitle = titleRaw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const bytes = await readD1Range(c.env.DB, key, 0, meta.size);
    const encodedTitle = encodeURIComponent(safeTitle) + '.tl3';
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': "attachment; filename=\"" + encodedTitle + "\"; filename*=UTF-8''" + encodedTitle,
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch(e:any) { return c.json({ok:false,error:e.message||'tl3 file error'},500); }
});

// GET /api/v1/tl3/header/:id — TL3 파일 헤더 (스파인 T_0~T_N 포함) 반환
app.get('/api/v1/tl3/header/:id', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    let fileId = Number(c.req.param('id') || 0);
    const rawId = String(c.req.param('id') || '');
    // 숫자가 아니면 shareId로 조회
    if (!fileId || isNaN(fileId) || String(fileId) !== rawId) {
      const resolvedFileId = await resolveTL3FileId(c.env.DB, rawId);
      if (!resolvedFileId) return c.json({ok:false,error:'공유 ID에 연결된 검증된 TL3 출시 파일을 찾을 수 없습니다.',share_id:rawId},404);
      fileId = resolvedFileId;
    }
    const row = await c.env.DB.prepare("SELECT header_json,title,artist,duration_ms,segment_count,price_tl,share_id FROM tl3_releases WHERE file_id=? AND status='released'").bind(fileId).first<any>();
    if (!row) return c.json({ok:false,error:'TL3 release not found'},404);
    var header: Record<string, any> = {};
    try { header = JSON.parse(String(row.header_json||'{}')); } catch(_){ }
    return c.json({
      ok: true,
      file_id: fileId,
      title: row.title,
      artist: row.artist,
      duration_ms: row.duration_ms,
      segment_count: row.segment_count,
      price_tl: row.price_tl,
      share_id: row.share_id,
      // The Track player consumes header.mp3.N before requesting segment zero.
      // Keep the original v4 header shape in the API response; old releases
      // may not contain every optional MP3 descriptor.
      mp3: header.mp3 || { N: Number(row.segment_count || 0), seg_bytes: 0, last_bytes: 0, first_offset: 0 },
      fid: header.fid,
      salt: header.salt,
      hash_mp3: header.hash_mp3,
      hash_lp: header.hash_lp,
      lic_id: header.lic_id,
      token_latest: header.token_latest,
      mp3_tokens: header.mp3_tokens || [],
      lp_opus: header.lp_opus || null,
      hash_lp_opus: header.hash_lp_opus || null,
      lp_tokens: header.lp_tokens || [],
      mp3_seg_lens: header.mp3_seg_lens || [],
      lp_seg_lens: header.lp_seg_lens || [],
      rights: header.rights || {},
      lp_meta: header.lp_meta || null
    });
  } catch(e:any) { return c.json({ok:false,error:e.message||'header error'},500); }
});

// GET /api/v1/tl3/segment/:id — ciphertext 반환 (복호화/차감은 클라이언트와 /code)
app.get('/api/v1/tl3/segment/:id', async (c) => {
  const corsHeaders: Record<string,string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-TL3-Segment-Index, X-TL3-Segment-Duration-Ms, X-TL3-Next-Segment',
    'Cache-Control': 'private, no-store'
  };
  const respond = (body:unknown,status:number,extra:Record<string,string>={}) =>
    new Response(JSON.stringify(body),{status,headers:{...corsHeaders,'Content-Type':'application/json',...extra}});
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return respond({ok:false,error:'로그인이 필요합니다.'},401);
    const userId=Number(payload.sub);
    if(!Number.isSafeInteger(userId)||userId<=0) return respond({ok:false,error:'인증 정보가 올바르지 않습니다.'},401);
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND is_active=1').bind(userId).first<any>();
    if (!u) return respond({ok:false,error:'사용자를 찾을 수 없습니다.'},401);

    const rawId=String(c.req.param('id')||'');
    let fileId=Number(rawId);
    if(!Number.isSafeInteger(fileId)||fileId<=0||String(fileId)!==rawId){
      fileId=await resolveTL3FileId(c.env.DB,rawId);
      if(!fileId) return respond({ok:false,error:'공유 ID에 연결된 검증된 TL3 출시 파일을 찾을 수 없습니다.',share_id:rawId},404);
    }
    const segmentIndex=Number(c.req.query('segment')||0);
    if(!Number.isSafeInteger(segmentIndex)||segmentIndex<0) return respond({ok:false,error:'세그먼트 번호가 올바르지 않습니다.'},400);

    // One indexed join replaces separate release and segment metadata queries.
    const row=await c.env.DB.prepare(`
      SELECT r.tl3_key,r.payload_offset,r.segment_count,
             s.offset,s.length,s.duration_ms,s.ct_offset,s.ct_length
      FROM tl3_releases r
      JOIN tl3_segments s ON s.file_id=r.file_id AND s.segment_index=?
      WHERE r.file_id=? AND r.status='released'
      LIMIT 1
    `).bind(segmentIndex,fileId).first<any>();
    if(!row) return respond({ok:false,error:'TL3 출시 파일 또는 세그먼트를 찾을 수 없습니다.'},404);
    if(segmentIndex>=Number(row.segment_count||0)) return respond({ok:false,error:'재생 종료'},416);

    const ctOffset=Number(row.ct_offset ?? (Number(row.payload_offset)+Number(row.offset)));
    const ctLength=Number(row.ct_length ?? row.length);
    if(!Number.isSafeInteger(ctOffset)||ctOffset<0||!Number.isSafeInteger(ctLength)||ctLength<=0){
      return respond({ok:false,error:'세그먼트 저장 범위가 올바르지 않습니다.'},502);
    }
    const ciphertext=await readD1RangeFast(c.env.DB,String(row.tl3_key),ctOffset,ctOffset+ctLength);
    if(!ciphertext.byteLength) return respond({ok:false,error:'TL3 세그먼트 데이터가 비어 있습니다.'},502);
    const headers=new Headers(corsHeaders);
    headers.set('Content-Type','application/octet-stream');
    headers.set('Content-Length',String(ciphertext.byteLength));
    headers.set('X-TL3-Segment-Index',String(segmentIndex));
    headers.set('X-TL3-Segment-Duration-Ms',String(row.duration_ms));
    headers.set('X-TL3-Next-Segment',String(segmentIndex+1));
    return new Response(ciphertext,{status:206,headers});
  } catch(e:any) {
    const message=String(e?.message||'TL3 segment error');
    const transient=/D1_ERROR|overload|temporar|unavailable|busy|internal error|service/i.test(message);
    console.error('[TL3_SEGMENT_READ_ERROR]',{file_id:c.req.param('id'),segment:c.req.query('segment'),transient,message});
    return respond(
      {ok:false,code:transient?'TL3_SEGMENT_TEMPORARY':'TL3_SEGMENT_ERROR',
       error:transient?'일시적인 음원 전송 지연입니다.':'TL3 세그먼트 처리에 실패했습니다.'},
      transient?503:500,
      transient?{'Retry-After':'1'}:{}
    );
  }
});

// TL3 자산 잔여 TL 조회: 곡 전체 재생시간에서 출발한 자산 자체의 TL 풀
app.get('/api/v1/tl3/asset/:id/tl', async (c) => {
  try {
    const rawId=String(c.req.param('id')||'');
    const fileId=Number(rawId);
    const resolvedId=fileId>0&&String(fileId)===rawId?fileId:await resolveTL3FileId(c.env.DB,rawId);
    const rel=resolvedId>0
      ? await c.env.DB.prepare("SELECT file_id,share_id FROM tl3_releases WHERE file_id=? AND status='released'").bind(resolvedId).first<any>()
      : null;
    if(!rel) return c.json({ok:false,error:'TL3 release not found'},404);
    const asset=await ensureTL3AssetTL(c.env.DB,Number(rel.file_id));
    if(!asset) return c.json({ok:false,error:'음원 TL 풀을 초기화할 수 없습니다.'},409);
    const auth=c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    let wallet_tl:null|number=null;
    if(payload){
      const w=await c.env.DB.prepare('SELECT tl_p,tl_a,tl_b,tl FROM users WHERE id=?').bind(Number(payload.sub)).first<any>();
      const p=tlWalletParts(w); wallet_tl=p.p+p.a+p.b;
    }
    return c.json({ok:true,file_id:Number(rel.file_id),share_id:String(rel.share_id),
      initial_tl:Number(asset.initial_tl),remaining_tl:Number(asset.remaining_tl),
      consumed_tl:Number(asset.consumed_tl),wallet_tl});
  }catch(e:any){return c.json({ok:false,error:e?.message||'자산 TL 조회 실패'},500);}
});

// GET /api/v1/tl3/code/:id — 라이선스만 발급한다. TL 차감은 실제 재생 시작 후 1회 처리한다.
app.get('/api/v1/tl3/code/:id', async (c) => {
  try {
    const auth=c.req.header('Authorization')?.replace(/^Bearer /,'').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    if(!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const u=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if(!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);
    const rawId=String(c.req.param('id')||'');
    let fileId=Number(rawId);
    if(!fileId||String(fileId)!==rawId) fileId=Number(await resolveTL3FileId(c.env.DB,rawId)||0);
    if(!fileId) return c.json({ok:false,error:'검증된 TL3 출시 파일을 찾을 수 없습니다.'},404);
    const segmentIndex=Math.max(0,Number(c.req.query('segment')||0));
    const release=await c.env.DB.prepare("SELECT segment_count,share_id FROM tl3_releases WHERE file_id=? AND status='released'").bind(fileId).first<any>();
    if(!release) return c.json({ok:false,error:'TL3 release not found'},404);
    if(!Number.isInteger(segmentIndex)||segmentIndex>=Number(release.segment_count||0)) return c.json({ok:false,error:'재생 구간 오류'},416);
    const segment=await c.env.DB.prepare('SELECT 1 FROM tl3_segments WHERE file_id=? AND segment_index=?').bind(fileId,segmentIndex).first<any>();
    if(!segment) return c.json({ok:false,error:'세그먼트 없음'},404);
    const masterSecret=c.env.TL3_MASTER_SECRET;
    if(!masterSecret) return c.json({ok:false,error:'TL3_MASTER_SECRET is not configured'},503);
    const lic=await deriveLicenseBytes(masterSecret,release.share_id||('tl3_'+fileId));
    return c.json({ok:true,lic_n:hex(lic),segment:segmentIndex,charging:'single_play_start'});
  }catch(e:any){return c.json({ok:false,error:e?.message||'license error'},500);}
});

// 재생 전 자산 길이와 지갑 잔액을 조회한다. 재생 시작 조건은 최소 1 TL이며 예약·차감은 하지 않는다.
app.post('/api/v1/tl3/play/preflight/:id', async (c) => {
  try {
    const auth=c.req.header('Authorization')?.replace(/^Bearer /,'').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    if(!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const user=await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if(!user) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);
    const rawId=String(c.req.param('id')||'');
    let fileId=Number(rawId);
    if(!fileId||String(fileId)!==rawId) fileId=Number(await resolveTL3FileId(c.env.DB,rawId)||0);
    if(!fileId) return c.json({ok:false,error:'TL3 자산을 찾을 수 없습니다.'},404);
    const file=await c.env.DB.prepare("SELECT f.user_id,f.revenue_held,r.share_id FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id WHERE f.id=? AND r.status='released'").bind(fileId).first<any>();
    if(!file||file.revenue_held) return c.json({ok:false,error:'재생할 수 없는 TL3 자산입니다.'},404);
    const duration=await c.env.DB.prepare('SELECT COALESCE(SUM(duration_ms),0) total_ms,COUNT(*) segment_count FROM tl3_segments WHERE file_id=?').bind(fileId).first<any>();
    const totalMs=Number(duration?.total_ms||0);
    if(totalMs<=0||Number(duration?.segment_count||0)<=0) return c.json({ok:false,error:'음원 재생시간 정보가 없습니다.'},409);
    const requiredTL=Math.ceil(totalMs/1000-1e-9);
    const w=tlWalletParts(user),balance=Number((w.p+w.a+w.b).toFixed(6));
    return c.json({ok:true,file_id:fileId,required_tl:requiredTL,duration_ms:totalMs,wallet_tl:balance,can_play:balance+1e-9>=1});
  }catch(e:any){return c.json({ok:false,error:e?.message||'재생 사전 확인 실패'},500);}
});

// 실제 재생 시간 누적 정산: 완전히 재생된 1초마다 1 TL 차감
app.post('/api/v1/tl3/play/meter/:id', async (c) => {
  try {
    const auth=c.req.header('Authorization')?.replace(/^Bearer /,'').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    if(!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const user=await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if(!user) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);
    const rawId=String(c.req.param('id')||'');
    let fileId=Number(rawId);
    if(!fileId||String(fileId)!==rawId) fileId=Number(await resolveTL3FileId(c.env.DB,rawId)||0);
    if(!fileId) return c.json({ok:false,error:'TL3 자산을 찾을 수 없습니다.'},404);
    const body=await c.req.json<any>().catch(()=>({}));
    const sessionId=String(body.session_id||'').slice(0,100);
    const playedMs=Number(body.played_ms);
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(sessionId)||!Number.isFinite(playedMs)||playedMs<0||playedMs>86400000)
      return c.json({ok:false,error:'재생 세션 또는 재생 시간 값이 올바르지 않습니다.'},400);
    const file=await c.env.DB.prepare("SELECT f.id,f.user_id,f.revenue_held,r.share_id FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id WHERE f.id=? AND r.status='released'").bind(fileId).first<any>();
    if(!file||file.revenue_held) return c.json({ok:false,error:'재생할 수 없는 TL3 자산입니다.'},404);
    // Playback charging uses the user's wallet only; do not initialize the
    // separate asset-TL pool on every one-second meter request.
    const duration=await c.env.DB.prepare('SELECT COALESCE(SUM(duration_ms),0) total_ms FROM tl3_segments WHERE file_id=?').bind(fileId).first<any>();
    const totalMs=Number(duration?.total_ms||0);
    if(totalMs<=0) return c.json({ok:false,error:'음원 재생시간 정보가 없습니다.'},409);
    const boundedPlayedMs=Math.min(playedMs,totalMs);
    const targetSeconds=boundedPlayedMs>=totalMs?Math.ceil(totalMs/1000):Math.floor(boundedPlayedMs/1000);
    // tl3_play_meter_sessions is provisioned by migration 0007, not at playback time.
    await c.env.DB.prepare('INSERT OR IGNORE INTO tl3_play_meter_sessions(session_id,user_id,file_id) VALUES(?,?,?)').bind(sessionId,user.id,fileId).run();
    const prior=await c.env.DB.prepare('SELECT user_id,file_id,billed_seconds,played_ms FROM tl3_play_meter_sessions WHERE session_id=?').bind(sessionId).first<any>();
    if(!prior||Number(prior.user_id)!==Number(user.id)||Number(prior.file_id)!==fileId)
      return c.json({ok:false,error:'재생 세션이 다른 사용자 또는 자산에 연결되어 있습니다.'},409);
    const already=Number(prior.billed_seconds||0);
    if(targetSeconds<=already){
      const fresh=await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first<any>();
      const w=tlWalletParts(fresh);
      return c.json({ok:true,billed_seconds:already,charged_tl:already,delta_tl:0,wallet_tl:Number((w.p+w.a+w.b).toFixed(6)),stop:false});
    }
    const wallet=tlWalletParts(user),balance=Number((wallet.p+wallet.a+wallet.b).toFixed(6));
    const delta=Math.min(targetSeconds-already,Math.floor(balance+1e-9));
    if(delta<=0) return c.json({ok:false,code:'TL_INSUFFICIENT',error:'보유 TL이 부족하여 재생을 중지합니다.',billed_seconds:already,charged_tl:already,wallet_tl:balance,stop:true},402);
    let left=delta;
    const takeA=Math.min(left,wallet.a);left=Number((left-takeA).toFixed(6));
    const takeB=Math.min(left,wallet.b);left=Number((left-takeB).toFixed(6));
    const takeP=Number(Math.max(0,left).toFixed(6));
    const chargedSeconds=already+delta;
    const creator=await c.env.DB.prepare('SELECT id,CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END p,COALESCE(tl_a,0) a,COALESCE(tl_b,0) b FROM users WHERE id=?').bind(file.user_id).first<any>();
    const revenue=Number((delta*0.7).toFixed(6));
    const creatorBefore=creator?Number(creator.p||0)+Number(creator.a||0)+Number(creator.b||0):0;
    const creatorAfter=creatorBefore-(Number(creator?.id)===Number(user.id)?delta:0)+revenue;
    const statements=[
      c.env.DB.prepare("UPDATE tl3_play_meter_sessions SET billed_seconds=?,played_ms=?,updated_at=datetime('now') WHERE session_id=? AND user_id=? AND file_id=? AND billed_seconds=?").bind(chargedSeconds,Math.min(playedMs,totalMs),sessionId,user.id,fileId,already),
      c.env.DB.prepare('INSERT INTO tl3_assertion_guard(ok) SELECT changes()'),
      c.env.DB.prepare('DELETE FROM tl3_assertion_guard'),
      c.env.DB.prepare("UPDATE users SET tl_p=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END)-?,tl_a=COALESCE(tl_a,0)-?,tl_b=COALESCE(tl_b,0)-?,tl_balance=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END)-?,tl=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END)-?,total_tl_spent=COALESCE(total_tl_spent,0)+?,updated_at=datetime('now') WHERE id=? AND (CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END)>=? AND COALESCE(tl_a,0)>=? AND COALESCE(tl_b,0)>=?").bind(takeP,takeA,takeB,delta,delta,delta,user.id,takeP,takeA,takeB),
      c.env.DB.prepare('INSERT INTO tl3_assertion_guard(ok) SELECT changes()'),
      c.env.DB.prepare('DELETE FROM tl3_assertion_guard')
    ];
    if(creator&&revenue>0){
      statements.push(c.env.DB.prepare("UPDATE users SET tl_p=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0) END)+?,tl=(CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END)+?,total_tl_earned=COALESCE(total_tl_earned,0)+?,updated_at=datetime('now') WHERE id=?").bind(revenue,revenue,revenue,creator.id));
      statements.push(c.env.DB.prepare("INSERT INTO transactions(user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note) VALUES(?,?,'earn',?,?,?,?)").bind(creator.id,fileId,revenue,creatorAfter,user.id,'TL3 실제 재생 시간 보상'));
    }
    statements.push(c.env.DB.prepare('INSERT INTO play_events(file_id,player_user_id,tl_deducted,revenue_credited,file_tl_after,play_duration_seconds,car_mode) VALUES(?,?,?,?,?,?,0)').bind(fileId,user.id,delta,revenue,null,delta));
    await c.env.DB.batch(statements);
    await c.env.DB.prepare("INSERT INTO poc_logs(user_id,mode,seconds,tl_spent,poc_gained) VALUES(?,'consume',?,?,?)")
      .bind(user.id,delta,takeP,takeP*0.01+(takeA+takeB)*0.0005).run().catch(()=>{});
    const fresh=await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first<any>();
    const after=tlWalletParts(fresh);
    const remaining=Number((after.p+after.a+after.b).toFixed(6));
    const stop=chargedSeconds<Math.ceil(totalMs/1000)&&(delta<(targetSeconds-already)||remaining<1);
    return c.json({ok:true,billed_seconds:chargedSeconds,charged_tl:chargedSeconds,delta_tl:delta,wallet_tl:remaining,creator_revenue:revenue,stop});
  }catch(e:any){
    const message=String(e?.message||'TL3 재생 시간 정산 실패');
    if(message.includes('CHECK constraint failed')) return c.json({ok:false,code:'METER_CONFLICT',error:'재생 정산이 겹쳤습니다. 다시 요청해 주세요.'},409);
    return c.json({ok:false,error:message},500);
  }
});

// 과거 전체 곡 일괄 차감 API는 중단한다. 신규 플레이어는 실제 재생 시간 정산 API를 사용한다.
app.post('/api/v1/tl3/play/charge/:id', async (c) => {
  return c.json({ok:false,code:'FULL_TRACK_CHARGE_DISABLED',error:'곡 전체 일괄 차감은 중단되었습니다. 실제 재생 시간 기준으로 정산합니다.'},410);
});

// 구형 구간별 정산 API는 더 이상 환불·부분 차감을 수행하지 않는다.
app.post('/api/v1/tl3/segment/confirm/:id', async (c) => {
  return c.json({ok:false,code:'LEGACY_METERING_DISABLED',error:'구형 구간 정산은 종료되었습니다. 실제 재생 시간 기준 정산 API를 사용하세요.'},410);
});
// ═══════════════════════════════════════════════════════════════
// TL3 오프라인 재생 라우트 (2026-10-09)
// ═══════════════════════════════════════════════════════════════

// POST /api/v1/tl3/offline/start — 오프라인 세션 시작 (선차감)
app.post('/api/v1/tl3/offline/start', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);

    const body = await c.req.json<any>().catch(()=>({}));
    const shareIdRaw = String(body.share_id || '').trim();
    const totalSegments = Math.max(1, Math.min(7200, Number(body.segments || 0)));
    if (!shareIdRaw) return c.json({ok:false,error:'share_id 필요'},400);

    let fileId = Number(shareIdRaw);
    if (!fileId || String(fileId) !== shareIdRaw) {
      const resolvedFileId = await resolveTL3FileId(c.env.DB, shareIdRaw);
      if (!resolvedFileId) return c.json({ok:false,error:'공유 ID에 연결된 TL3 출시 파일이 없습니다.',share_id:shareIdRaw},404);
      fileId = resolvedFileId;
    }

    const file = await c.env.DB.prepare("SELECT r.segment_count,r.status FROM tl3_releases r WHERE r.file_id=? AND r.status='released'").bind(fileId).first<any>();
    if (!file) return c.json({ok:false,error:'TL3 release not found'},404);
    const segCount = Number(file.segment_count || 0);
    const n = Math.min(totalSegments, segCount);
    if (n <= 0) return c.json({ok:false,error:'세그먼트 수 오류'},400);

    const segs = await c.env.DB.prepare('SELECT duration_ms FROM tl3_segments WHERE file_id=? ORDER BY segment_index ASC LIMIT ?').bind(fileId, n).all<any>();
    const totalMs = (segs.results || []).reduce((s:number, r:any) => s + Number(r.duration_ms || 0), 0);
    const reserveTl = Number((totalMs / 1000).toFixed(3));
    if (reserveTl <= 0) return c.json({ok:false,error:'세그먼트 길이 오류'},400);

    const debit = await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance-?,total_tl_spent=total_tl_spent+? WHERE id=? AND tl_balance>=?').bind(reserveTl,reserveTl,u.id,reserveTl).run();
    if (!debit.meta?.changes) return c.json({ok:false,error:'시간 포인트가 부족합니다.',required:reserveTl,balance:u.tl_balance},402);

    const sid = 'off_' + crypto.randomUUID().replace(/-/g,'');
    const deviceHint = String(body.device_hint || '').slice(0,32);
    const expiresAt = new Date(Date.now() + 7*24*3600*1000).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO tl3_offline_sessions(id,user_id,file_id,share_id,total_segments,reserved_tl,status,device_hint,expires_at)
       VALUES(?,?,?,?,?,?,'active',?,?)`
    ).bind(sid,u.id,fileId,shareIdRaw,n,reserveTl,deviceHint,expiresAt).run();

    return c.json({ok:true, offline_session_id:sid, total_segments:n, reserved_tl:reserveTl, expires_at:expiresAt, remaining_tl:Number(u.tl_balance)-reserveTl});
  } catch(e:any) { return c.json({ok:false,error:e.message||'offline start error'},500); }
});

// GET /api/v1/tl3/offline/lic/:session_id — lic 반환 (세션당 1회)
app.get('/api/v1/tl3/offline/lic/:session_id', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);

    const sid = String(c.req.param('session_id') || '');
    const ss = await c.env.DB.prepare('SELECT * FROM tl3_offline_sessions WHERE id=? AND user_id=?').bind(sid,u.id).first<any>();
    if (!ss) return c.json({ok:false,error:'세션을 찾을 수 없습니다.'},404);
    if (ss.status !== 'active') return c.json({ok:false,error:'활성 세션이 아닙니다.',status:ss.status},409);
    if (Number(ss.lic_delivered) === 1) return c.json({ok:false,error:'이미 lic이 전달된 세션입니다.'},409);
    if (new Date(ss.expires_at).getTime() < Date.now()) return c.json({ok:false,error:'세션이 만료되었습니다.'},410);

    const masterSecret = c.env.TL3_MASTER_SECRET;
    if (!masterSecret) return c.json({ ok: false, error: 'TL3_MASTER_SECRET is not configured' }, 503);
    const lic = await deriveLicenseBytes(masterSecret, ss.share_id);
    await c.env.DB.prepare("UPDATE tl3_offline_sessions SET lic_delivered=1,updated_at=datetime('now') WHERE id=?").bind(sid).run();
    return c.json({ok:true, lic:hex(lic), share_id:ss.share_id, total_segments:Number(ss.total_segments)});
  } catch(e:any) { return c.json({ok:false,error:e.message||'offline lic error'},500); }
});

// POST /api/v1/tl3/offline/settle — 오프라인 재생 로그 정산 (미재생분 환급)
app.post('/api/v1/tl3/offline/settle', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);

    const body = await c.req.json<any>().catch(()=>({}));
    const sid = String(body.offline_session_id || '');
    const playedLog = Array.isArray(body.played_log) ? body.played_log : [];
    if (!sid) return c.json({ok:false,error:'offline_session_id 필요'},400);

    const ss = await c.env.DB.prepare('SELECT * FROM tl3_offline_sessions WHERE id=? AND user_id=?').bind(sid,u.id).first<any>();
    if (!ss) return c.json({ok:false,error:'세션을 찾을 수 없습니다.'},404);
    if (ss.status === 'settled') return c.json({ok:true, already_settled:true, refund:0, remaining_tl:Number(u.tl_balance)});

    let playedSec = 0;
    for (const entry of playedLog) {
      const s = Number(entry && entry.played_seconds || 0);
      if (s > 0) playedSec += s;
    }
    const reserved = Number(ss.reserved_tl || 0);
    const used = Math.min(reserved, Number(playedSec.toFixed(3)));
    const refund = Number(Math.max(0, reserved - used).toFixed(3));

    if (refund > 0) {
      await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance+?,total_tl_spent=total_tl_spent-? WHERE id=?').bind(refund,refund,u.id).run();
    }
    await c.env.DB.prepare("UPDATE tl3_offline_sessions SET status='settled',settled_tl=?,refunded_tl=?,settled_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(used,refund,sid).run();

    const fresh = await c.env.DB.prepare('SELECT tl_balance FROM users WHERE id=?').bind(u.id).first<any>();
    return c.json({ok:true, played_seconds:Number(playedSec.toFixed(3)), used_tl:used, refund, remaining_tl:Number(fresh?.tl_balance||0)});
  } catch(e:any) { return c.json({ok:false,error:e.message||'offline settle error'},500); }
});

// POST /api/v1/tl3/spend — 오프라인 파일 재생 후 직접 차감/분배 (TL3_SPEND_ROUTE)
app.post('/api/v1/tl3/spend', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    
    const u = await c.env.DB.prepare(
      'SELECT id, COALESCE(tl_p,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b, COALESCE(tl_balance,0) as tl_balance FROM users WHERE id=? AND is_active=1'
    ).bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);

    const body = await c.req.json<any>().catch(()=>({}));
    const fileId = Number(body.file_id || 0);
    const seconds = Math.max(0, Math.min(Number(body.seconds || 0), 3600));
    const rate = Number(body.rate || 1.0);
    const source = String(body.source || 'offline_player').slice(0, 40);
    if (!fileId || seconds <= 0) return c.json({ok:false,error:'file_id, seconds 필요'},400);

    const file = await c.env.DB.prepare(`
      SELECT f.id, f.user_id, f.title, f.revenue_held, f.price_per_sec,
             f.promo_rate AS f_promo_rate,
             f.file_tl, f.duration_seconds,
             r.duration_ms AS r_dur_ms, r.price_tl AS r_price_tl
      FROM tl_files f
      LEFT JOIN tl3_releases r ON r.file_id = f.id
      WHERE f.id=?
    `).bind(fileId).first<any>();
    if (!file) return c.json({ok:false,error:'파일 없음'},404);
    if (file.revenue_held) return c.json({ok:false,error:'수익 보류 상태'},403);

    // SERVER_RATE_V4: promo_rate 반영 (유저 > 파일 > 기본 1.0)
    let serverRate = 1.0;
    const rPriceTL = Number(file.r_price_tl || 0);
    const rDurMs   = Number(file.r_dur_ms || 0);
    if (rPriceTL > 0 && rDurMs > 0) {
      serverRate = rPriceTL / (rDurMs / 1000);
    } else {
      const pps = Number(file.price_per_sec || 0);
      if (pps > 0) serverRate = pps;
    }
    // promo_rate 반영
    const uPromoRow = await c.env.DB.prepare('SELECT promo_rate FROM users WHERE id=?').bind(Number(payload.sub)).first<any>();
    const uPromo = Number(uPromoRow?.promo_rate || 0);
    const fPromo = Number(file.f_promo_rate || 0);
    if (uPromo > 0 && uPromo !== 1.0) serverRate = serverRate * uPromo;
    else if (fPromo > 0 && fPromo !== 1.0) serverRate = serverRate * fPromo;
    if (Math.abs(serverRate - 1.0) < 0.02) serverRate = 1.0;

    const cost = Number((seconds * serverRate).toFixed(3));
    if (cost <= 0) return c.json({ok:false,error:'cost 0'},400);

    const total = Number(u.tl_p) + Number(u.tl_a) + Number(u.tl_b);
    if (total < cost) return c.json({ok:false,code:'TL_EMPTY',error:'TL 부족',balance:total},402);

    let remaining = cost;
    let new_a = Number(u.tl_a), new_b = Number(u.tl_b), new_p = Number(u.tl_p);
    if (remaining > 0 && new_a > 0) { const d = Math.min(remaining, new_a); new_a -= d; remaining -= d; }
    if (remaining > 0 && new_b > 0) { const d = Math.min(remaining, new_b); new_b -= d; remaining -= d; }
    if (remaining > 0 && new_p > 0) { const d = Math.min(remaining, new_p); new_p -= d; remaining -= d; }
    const newTotal = new_a + new_b + new_p;

    await c.env.DB.prepare(
      'UPDATE users SET tl=?, tl_p=?, tl_a=?, tl_b=?, total_tl_spent=COALESCE(total_tl_spent,0)+? WHERE id=?'
    ).bind(newTotal, new_p, new_a, new_b, cost, u.id).run();

    const revenue = Number((cost * 0.7).toFixed(3));
    const creator = await c.env.DB.prepare(
      'SELECT id, COALESCE(tl_balance,0) as tl_balance FROM users WHERE id=?'
    ).bind(file.user_id).first<any>();
    if (creator && revenue > 0) {
      await c.env.DB.prepare(
        'UPDATE users SET tl_balance=tl_balance+?, total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?'
      ).bind(revenue, revenue, creator.id).run();
      try {
        await c.env.DB.prepare(
          "INSERT INTO transactions(user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note) VALUES (?,?,'earn',?,?,?,?)"
        ).bind(creator.id, fileId, revenue, Number(creator.tl_balance) + revenue, u.id, 'TL3 오프라인 정산 '+seconds+'초').run();
      } catch(_){}
    }

    try {
      await c.env.DB.prepare(
        "INSERT INTO transactions(user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note) VALUES (?,?,'spend',?,?,?,?)"
      ).bind(u.id, fileId, -cost, newTotal, file.user_id, 'TL3 '+source+' '+seconds+'초').run();
    } catch(_){}

    try {
      await c.env.DB.prepare(
        'INSERT INTO play_events(file_id,player_user_id,tl_deducted,revenue_credited,file_tl_after,play_duration_seconds,car_mode) VALUES(?,?,?,?,?,?,?)'
      ).bind(fileId, u.id, cost, revenue, null, Math.round(seconds), 0).run();
    } catch(_){}

    return c.json({
      ok: true,
      spent: cost,
      seconds,
      source,
      balance: { tl_p: new_p, tl_a: new_a, tl_b: new_b, total: newTotal },
      creator_revenue: revenue,
      platform_share: Number((cost - revenue).toFixed(3))
    });
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('spend', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(ee){}
    return c.json({ok:false,error:e.message||'spend error'},500);
  }
});

// POST /api/v1/tl3/settle-offline — 오프라인 로컬 로그 일괄 정산 (TL3_SETTLE_OFFLINE_ROUTE)
app.post('/api/v1/tl3/settle-offline', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);

    const body = await c.req.json<any>().catch(()=>({}));
    const log = Array.isArray(body.played_log) ? body.played_log : [];
    if (!log.length) return c.json({ok:true, spent_total:0, entries_processed:0, message:'빈 로그'});

    // 로그 항목 검증 및 file_id별 집계
    const perFile: Record<string, { seconds: number, rate: number, user_id: number }> = {};
    let totalSeconds = 0;
    let totalCost = 0;

    for (const entry of log) {
      const fileId = Number(entry && entry.file_id || 0);
      const seconds = Math.max(0, Math.min(Number(entry && entry.seconds || 0), 3600));
      const rate = Number(entry && entry.rate || 1.0);
      if (!fileId || seconds <= 0) continue;

      const file = await c.env.DB.prepare(`
        SELECT f.id, f.user_id, f.revenue_held, f.price_per_sec,
               f.promo_rate AS f_promo_rate,
               f.file_tl, f.duration_seconds,
               r.duration_ms AS r_dur_ms, r.price_tl AS r_price_tl
        FROM tl_files f
        LEFT JOIN tl3_releases r ON r.file_id = f.id
        WHERE f.id=?
      `).bind(fileId).first<any>();
      if (!file || file.revenue_held) continue;

      // SERVER_RATE_V4: promo_rate 반영 (settle은 파일 우선, 유저는 정산 시 별도)
      let serverRate = 1.0;
      const rPriceTL = Number(file.r_price_tl || 0);
      const rDurMs   = Number(file.r_dur_ms || 0);
      if (rPriceTL > 0 && rDurMs > 0) {
        serverRate = rPriceTL / (rDurMs / 1000);
      } else {
        const pps = Number(file.price_per_sec || 0);
        if (pps > 0) serverRate = pps;
      }
      const fPromo2 = Number(file.f_promo_rate || 0);
      if (fPromo2 > 0 && fPromo2 !== 1.0) serverRate = serverRate * fPromo2;
      if (Math.abs(serverRate - 1.0) < 0.02) serverRate = 1.0;

      const key = String(fileId);
      if (!perFile[key]) perFile[key] = { seconds: 0, rate: serverRate, user_id: Number(file.user_id) };
      perFile[key].seconds += seconds;
      totalSeconds += seconds;
      totalCost += seconds * serverRate;
    }

    if (totalCost <= 0) return c.json({ok:true, spent_total:0, entries_processed:0});

    totalCost = Number(totalCost.toFixed(3));

    // 유저 잔액 확인
    const u = await c.env.DB.prepare(
      'SELECT id, COALESCE(tl_p,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=? AND is_active=1'
    ).bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자 없음'},401);

    const totalBalance = Number(u.tl_p) + Number(u.tl_a) + Number(u.tl_b);
    if (totalBalance < totalCost) {
      return c.json({ok:false, code:'TL_EMPTY', error:'TL 부족', balance: totalBalance, needed: totalCost}, 402);
    }

    // 차감: tl_a → tl_b → tl_p
    let remaining = totalCost;
    let new_a = Number(u.tl_a), new_b = Number(u.tl_b), new_p = Number(u.tl_p);
    if (remaining > 0 && new_a > 0) { const d = Math.min(remaining, new_a); new_a -= d; remaining -= d; }
    if (remaining > 0 && new_b > 0) { const d = Math.min(remaining, new_b); new_b -= d; remaining -= d; }
    if (remaining > 0 && new_p > 0) { const d = Math.min(remaining, new_p); new_p -= d; remaining -= d; }
    const newTotal = new_a + new_b + new_p;

    await c.env.DB.prepare(
      'UPDATE users SET tl=?, tl_p=?, tl_a=?, tl_b=?, total_tl_spent=COALESCE(total_tl_spent,0)+? WHERE id=?'
    ).bind(newTotal, new_p, new_a, new_b, totalCost, u.id).run();

    // file별 크리에이터 분배
    let creatorTotal = 0;
    const results: any[] = [];
    for (const [fileIdStr, info] of Object.entries(perFile)) {
      const fileId = Number(fileIdStr);
      const cost = Number((info.seconds * info.rate).toFixed(3));
      const revenue = Number((cost * 0.7).toFixed(3));
      creatorTotal += revenue;

      try {
        const creator = await c.env.DB.prepare(
          'SELECT id, COALESCE(tl_balance,0) as tl_balance FROM users WHERE id=?'
        ).bind(info.user_id).first<any>();
        if (creator && revenue > 0) {
          await c.env.DB.prepare(
            'UPDATE users SET tl_balance=tl_balance+?, total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?'
          ).bind(revenue, revenue, creator.id).run();
          await c.env.DB.prepare(
            "INSERT INTO transactions(user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note) VALUES (?,?,'earn',?,?,?,?)"
          ).bind(creator.id, fileId, revenue, Number(creator.tl_balance)+revenue, u.id, 'TL3 오프라인 정산 '+info.seconds+'초').run().catch(()=>{});
        }
        await c.env.DB.prepare(
          "INSERT INTO transactions(user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note) VALUES (?,?,'spend',?,?,?,?)"
        ).bind(u.id, fileId, -cost, newTotal, info.user_id, 'TL3 settle-offline '+info.seconds+'초').run().catch(()=>{});

        await c.env.DB.prepare(
          'INSERT INTO play_events(file_id,player_user_id,tl_deducted,revenue_credited,file_tl_after,play_duration_seconds,car_mode) VALUES(?,?,?,?,?,?,?)'
        ).bind(fileId, u.id, cost, revenue, null, Math.round(info.seconds), 0).run().catch(()=>{});

        results.push({ file_id: fileId, seconds: info.seconds, cost, revenue });
      } catch(e) { /* skip */ }
    }

    return c.json({
      ok: true,
      spent_total: totalCost,
      seconds_total: totalSeconds,
      entries_processed: Object.keys(perFile).length,
      creator_revenue_total: Number(creatorTotal.toFixed(3)),
      balance: { tl_p: new_p, tl_a: new_a, tl_b: new_b, total: newTotal },
      details: results
    });
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('settle-offline', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(_){}
    return c.json({ok:false,error:e.message||'settle-offline error'},500);
  }
});

// GET /api/v1/tl3/file-meta/:file_id — 파일 메타 정보 (FILE_META_ROUTE_V1)
app.get('/api/v1/tl3/file-meta/:file_id', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);

    // SHARE_ID_META_V1: file_id 또는 share_id(sh_xxx) 지원
    const rawId = String(c.req.param('file_id') || '').trim();
    let fileId = Number(rawId);
    if (!fileId || String(fileId) !== rawId) {
      // share_id로 조회
      const row = await c.env.DB.prepare(
        "SELECT file_id FROM tl3_releases WHERE share_id=? LIMIT 1"
      ).bind(rawId).first<any>();
      if (!row) return c.json({ok:false,error:'file_id/share_id 없음'},404);
      fileId = Number(row.file_id);
    }
    if (!fileId) return c.json({ok:false,error:'file_id 필요'},400);

    const file = await c.env.DB.prepare(`
      SELECT f.id, f.title, f.artist, f.user_id, f.revenue_held,
             f.price_per_sec, f.promo_rate AS f_promo_rate,
             f.duration_seconds, f.cover_image AS cover_url,  -- COVER_FIX_V1
             r.duration_ms AS r_dur_ms, r.price_tl AS r_price_tl,
             r.segment_count, r.header_json,
             (SELECT c.cert_no FROM tl_asset_certs c
              JOIN tl_assets a ON a.asset_id = c.asset_id
              WHERE a.file_id = f.id AND c.status = 'active'
              LIMIT 1) AS cert_no,
             (SELECT a.asset_id FROM tl_assets a
              WHERE a.file_id = f.id LIMIT 1) AS asset_id,
             (SELECT c.issued_at FROM tl_asset_certs c
              JOIN tl_assets a ON a.asset_id = c.asset_id
              WHERE a.file_id = f.id AND c.status = 'active'
              LIMIT 1) AS cert_issued_at,
             (SELECT c.cert_hash FROM tl_asset_certs c
              JOIN tl_assets a ON a.asset_id = c.asset_id
              WHERE a.file_id = f.id AND c.status = 'active'
              LIMIT 1) AS cert_hash,
             (SELECT a.genre FROM tl_assets a
              WHERE a.file_id = f.id LIMIT 1) AS asset_genre,
             (SELECT a.composer FROM tl_assets a
              WHERE a.file_id = f.id LIMIT 1) AS asset_composer,
             (SELECT a.lyricist FROM tl_assets a
              WHERE a.file_id = f.id LIMIT 1) AS asset_lyricist,
             (SELECT a.producer FROM tl_assets a
              WHERE a.file_id = f.id LIMIT 1) AS asset_producer,
             (SELECT a.owner_user_id FROM tl_assets a
              WHERE a.file_id = f.id LIMIT 1) AS asset_owner_user_id
      FROM tl_files f
      LEFT JOIN tl3_releases r ON r.file_id = f.id
      WHERE f.id=?
    `).bind(fileId).first<any>();
    if (!file) return c.json({ok:false,error:'파일 없음'},404);
    if (file.revenue_held) return c.json({ok:false,error:'수익 보류 상태'},403);

    const u = await c.env.DB.prepare(
      'SELECT promo_rate FROM users WHERE id=?'
    ).bind(Number(payload.sub)).first<any>();

    let durSec = 0;
    const rDurMs = Number(file.r_dur_ms || 0);
    if (rDurMs > 0) durSec = rDurMs / 1000;
    else durSec = Number(file.duration_seconds || 0);

    let rate = 1.0;
    const uRate = Number(u?.promo_rate || 0);
    const fRate = Number(file.f_promo_rate || 0);
    const pps   = Number(file.price_per_sec || 0);
    if (uRate > 0 && uRate !== 1.0) rate = uRate;
    else if (fRate > 0 && fRate !== 1.0) rate = fRate;
    else if (pps > 0) rate = pps;
    if (Math.abs(rate - 1.0) < 0.02) rate = 1.0;

    const maxTl = Number((durSec * rate).toFixed(3));

    // FILE_META_CERT_V1: 증명서 여부 판단
    const certNo = file.cert_no || null;
    const assetId = file.asset_id || null;
    const isCertified = !!certNo;

    // 증명서 신청 가능 여부 (본인 곡 & 미인증)
    const userId = Number(payload.sub || 0);
    const isOwner = Number(file.user_id) === userId;
    const canCertify = isOwner && !isCertified;

    return c.json({
      ok: true,
      file_id: fileId,
      title: file.title,
      artist: file.artist,
      cover_url: file.cover_url || '',
      creator_id: file.user_id,
      duration_sec: Number(durSec.toFixed(3)),
      rate: rate,
      max_tl: maxTl,
      has_release: rDurMs > 0,
      segment_count: Number(file.segment_count || 0),
      // ★ 증명서 상태
      certified: isCertified,
      cert_no: certNo,
      asset_id: assetId,
      cert_issued_at: file.cert_issued_at || null,
      cert_hash: file.cert_hash || null,
      // ★ 자산 메타 (증명서 있을 때)
      asset_genre: file.asset_genre || null,
      asset_composer: file.asset_composer || null,
      asset_lyricist: file.asset_lyricist || null,
      asset_producer: file.asset_producer || null,
      asset_owner_user_id: file.asset_owner_user_id || null,
      // ★ 증명서 신청 가능 여부
      is_owner: isOwner,
      can_certify: canCertify
    });
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('file-meta', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(_){}
    return c.json({ok:false,error:e.message||'file-meta error'},500);
  }
});

// ═══════════════════════════════════════════════════════════════
// ASSETS_ROUTES_V1 — 디지털 자산 원장
// ═══════════════════════════════════════════════════════════════

// Spotify 주요 장르 (하드코딩, 추후 확장)
const SPOTIFY_GENRES = [
  'k-pop','k-hip-hop','k-rnb','k-indie','k-rock','k-ballad','k-trot',
  'pop','hip-hop','rnb','rock','metal','punk','indie','alternative',
  'jazz','classical','electronic','dance','edm','house','techno',
  'folk','country','blues','soul','funk','reggae','latin','world',
  'ambient','soundtrack','acoustic','instrumental','lo-fi','trap','drill'
];

// 자산 ID / 증명서 번호 생성
async function nextAssetId(db: D1Database): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = 'A-' + year + '-';
  const row = await db.prepare(
    "SELECT asset_id FROM tl_assets WHERE asset_id LIKE ? ORDER BY id DESC LIMIT 1"
  ).bind(prefix + '%').first<any>();
  let n = 1;
  if (row && row.asset_id) {
    const parts = String(row.asset_id).split('-');
    n = (Number(parts[2]) || 0) + 1;
  }
  return prefix + String(n).padStart(5, '0');
}
async function nextCertNo(db: D1Database): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = 'C-' + year + '-';
  const row = await db.prepare(
    "SELECT cert_no FROM tl_asset_certs WHERE cert_no LIKE ? ORDER BY id DESC LIMIT 1"
  ).bind(prefix + '%').first<any>();
  let n = 1;
  if (row && row.cert_no) {
    const parts = String(row.cert_no).split('-');
    n = (Number(parts[2]) || 0) + 1;
  }
  return prefix + String(n).padStart(5, '0');
}

// 자산 전용 해시 (SHA-256 of string)
async function assetHash256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// POST /api/v1/assets — 자산 등록
app.post('/api/v1/assets', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);

    const body = await c.req.json<any>().catch(()=>({}));

    // ASSETS_SHAREID_V1: file_id 또는 share_id 지원
    let fileId = Number(body.file_id || 0);
    const shareIdRaw = String(body.share_id || '').trim();

    if (!fileId && shareIdRaw) {
      // share_id로 file_id 조회
      const relRow = await c.env.DB.prepare(
        'SELECT file_id FROM tl3_releases WHERE share_id=? LIMIT 1'
      ).bind(shareIdRaw).first<any>();
      if (!relRow) return c.json({ok:false,error:'share_id를 찾을 수 없습니다'},404);
      fileId = Number(relRow.file_id);
    }
    if (!fileId) return c.json({ok:false,error:'file_id 또는 share_id 필요'},400);

    const file = await c.env.DB.prepare(
      'SELECT id, user_id, title, artist FROM tl_files WHERE id=?'
    ).bind(fileId).first<any>();
    if (!file) return c.json({ok:false,error:'파일 없음'},404);
    if (Number(file.user_id) !== Number(payload.sub)) {
      return c.json({ok:false,error:'본인 파일만 자산 등록 가능'},403);
    }

    // 기존 자산 확인
    const exist = await c.env.DB.prepare(
      'SELECT asset_id FROM tl_assets WHERE file_id=?'
    ).bind(fileId).first<any>();
    if (exist) return c.json({ok:true, asset_id: exist.asset_id, already: true});

    const assetId = await nextAssetId(c.env.DB);
    const title = String(body.title || file.title || '').slice(0, 200);
    const artist = String(body.artist || file.artist || '').slice(0, 200);
    const album = String(body.album || '').slice(0, 200);
    const genre = String(body.genre || '').toLowerCase().slice(0, 50);
    const releaseDate = String(body.release_date || '').slice(0, 20);
    const composer = String(body.composer || '').slice(0, 500);
    const lyricist = String(body.lyricist || '').slice(0, 500);
    const lyrics = String(body.lyrics || '').slice(0, 20000);
    const producer = String(body.producer || '').slice(0, 500);
    const durationSec = Number(body.duration_sec || 0);
    const assetType = String(body.asset_type || 'music').slice(0, 20);
    const assetHash = String(body.asset_hash || '').slice(0, 100);
    const headerJson = String(body.header_json || '').slice(0, 50000);
    const coOwners = JSON.stringify(body.co_owners || []);
    const ownershipJson = JSON.stringify(body.ownership_json || {owner_user_id: Number(payload.sub), share: 1.0});

    await c.env.DB.prepare(`
      INSERT INTO tl_assets (asset_id, file_id, owner_user_id, title, artist, album, genre,
        release_date, duration_sec, composer, lyricist, lyrics, producer,
        asset_type, asset_hash, header_json, co_owners, ownership_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      assetId, fileId, Number(payload.sub), title, artist, album, genre,
      releaseDate, durationSec, composer, lyricist, lyrics, producer,
      assetType, assetHash, headerJson, coOwners, ownershipJson
    ).run();

    // 이벤트 기록
    await c.env.DB.prepare(
      "INSERT INTO tl_asset_events (asset_id, event_type, event_data, actor_user_id) VALUES (?, 'created', ?, ?)"
    ).bind(assetId, JSON.stringify({file_id: fileId, title}), Number(payload.sub)).run().catch(()=>{});

    return c.json({ok: true, asset_id: assetId, file_id: fileId});
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('assets-create', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(_){}
    return c.json({ok:false,error:e.message||'assets create error'},500);
  }
});

// GET /api/v1/assets/mine — 내 자산 목록
app.get('/api/v1/assets/mine', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);

    const rs = await c.env.DB.prepare(`
      SELECT asset_id, file_id, title, artist, album, genre, duration_sec,
             lifetime_revenue_tl, lifetime_plays, valuation_tl,
             collateral_status, status, created_at
      FROM tl_assets WHERE owner_user_id=? ORDER BY id DESC LIMIT 100
    `).bind(Number(payload.sub)).all<any>();

    return c.json({ok: true, assets: rs.results || []});
  } catch(e:any) {
    return c.json({ok:false,error:e.message||'error'},500);
  }
});

// GET /api/v1/assets/:asset_id — 자산 조회
app.get('/api/v1/assets/:asset_id', async (c) => {
  try {
    const assetId = String(c.req.param('asset_id') || '').trim();
    if (!assetId) return c.json({ok:false,error:'asset_id 필요'},400);

    const a = await c.env.DB.prepare(`
      SELECT a.*, u.username AS owner_name,
        (SELECT cert_no FROM tl_asset_certs WHERE asset_id=a.asset_id AND status='active' ORDER BY id DESC LIMIT 1) AS cert_no
      FROM tl_assets a
      LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.asset_id=?
    `).bind(assetId).first<any>();

    if (!a) return c.json({ok:false,error:'자산 없음'},404);

    // 공개용 필드만 (개인정보 제외)
    return c.json({
      ok: true,
      asset: {
        asset_id: a.asset_id,
        file_id: a.file_id,
        title: a.title,
        artist: a.artist,
        album: a.album,
        genre: a.genre,
        release_date: a.release_date,
        duration_sec: a.duration_sec,
        composer: a.composer,
        lyricist: a.lyricist,
        producer: a.producer,
        asset_type: a.asset_type,
        asset_hash: a.asset_hash,
        lifetime_revenue_tl: a.lifetime_revenue_tl,
        lifetime_plays: a.lifetime_plays,
        valuation_tl: a.valuation_tl,
        collateral_status: a.collateral_status,
        status: a.status,
        owner_name: a.owner_name,
        cert_no: a.cert_no,
        created_at: a.created_at
      }
    });
  } catch(e:any) {
    return c.json({ok:false,error:e.message||'error'},500);
  }
});

// POST /api/v1/assets/:asset_id/certify — 증명서 발행
app.post('/api/v1/assets/:asset_id/certify', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);

    const assetId = String(c.req.param('asset_id') || '').trim();
    const a = await c.env.DB.prepare('SELECT * FROM tl_assets WHERE asset_id=?').bind(assetId).first<any>();
    if (!a) return c.json({ok:false,error:'자산 없음'},404);
    if (Number(a.owner_user_id) !== Number(payload.sub)) {
      return c.json({ok:false,error:'본인 자산만 증명서 발행 가능'},403);
    }

    // 이미 활성 증명서 있는지
    const existCert = await c.env.DB.prepare(
      "SELECT cert_no FROM tl_asset_certs WHERE asset_id=? AND status='active' LIMIT 1"
    ).bind(assetId).first<any>();
    if (existCert) return c.json({ok:true, cert_no: existCert.cert_no, already: true});

    // CERT_FEE_V1: 증명서 발행 수수료 5,000 TL
    const CERT_FEE = 5000;

    const u = await c.env.DB.prepare(
      'SELECT tl, tl_a, tl_b, tl_p FROM users WHERE id=? AND is_active=1'
    ).bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자 없음'},401);

    const tlA = Number(u.tl_a || 0), tlB = Number(u.tl_b || 0), tlP = Number(u.tl_p || 0);
    const totalBal = tlA + tlB + tlP;
    if (totalBal < CERT_FEE) {
      return c.json({
        ok: false,
        code: 'TL_INSUFFICIENT',
        error: 'TL 부족',
        required: CERT_FEE,
        balance: totalBal,
        breakdown: { tl_a: tlA, tl_b: tlB, tl_p: tlP }
      }, 402);
    }

    // 차감: tl_a → tl_b → tl_p
    let remain = CERT_FEE;
    let fromA = 0, fromB = 0, fromP = 0;
    if (remain > 0 && tlA > 0) { fromA = Math.min(tlA, remain); remain -= fromA; }
    if (remain > 0 && tlB > 0) { fromB = Math.min(tlB, remain); remain -= fromB; }
    if (remain > 0 && tlP > 0) { fromP = Math.min(tlP, remain); remain -= fromP; }
    const totalPaid = fromA + fromB + fromP;
    const newA = tlA - fromA, newB = tlB - fromB, newP = tlP - fromP;
    const newTotal = newA + newB + newP;

    // users 업데이트
    await c.env.DB.prepare(`
      UPDATE users SET
        tl_a = ?, tl_b = ?, tl_p = ?, tl = ?,
        total_tl_spent = COALESCE(total_tl_spent,0) + ?
      WHERE id=?
    `).bind(newA, newB, newP, newTotal, totalPaid, Number(payload.sub)).run();

    // transactions 기록
    try {
      await c.env.DB.prepare(`
        INSERT INTO transactions(user_id, file_id, tx_type, amount, balance_after, note)
        VALUES (?, ?, 'cert_fee', ?, ?, ?)
      `).bind(
        Number(payload.sub), a.file_id, -totalPaid, newTotal,
        `증명서 발행 수수료 (a:${fromA} b:${fromB} p:${fromP})`
      ).run();
    } catch(_){}

    const certNo = await nextCertNo(c.env.DB);

    // 스냅샷 (발행 시점 고정)
    const snapshot = {
      asset_id: a.asset_id,
      file_id: a.file_id,
      title: a.title,
      artist: a.artist,
      album: a.album,
      genre: a.genre,
      release_date: a.release_date,
      duration_sec: a.duration_sec,
      composer: a.composer,
      lyricist: a.lyricist,
      producer: a.producer,
      asset_type: a.asset_type,
      asset_hash: a.asset_hash,
      owner_user_id: a.owner_user_id,
      issued_at: new Date().toISOString()
    };
    const snapshotJson = JSON.stringify(snapshot);
    const certHash = await assetHash256(snapshotJson);

    const origin = new URL(c.req.url).origin;
    const verifyUrl = origin + '/api/v1/certs/' + certNo + '/verify';
    const qrData = 'https://timelink.digital/cert/' + certNo;

    await c.env.DB.prepare(`
      INSERT INTO tl_asset_certs (cert_no, asset_id, snapshot_json, asset_hash,
        valuation_at_issue, revenue_at_issue, plays_at_issue,
        issued_by, verify_url, qr_data, cert_hash,
        fee_tl, fee_paid_from, fee_breakdown)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      certNo, assetId, snapshotJson, String(a.asset_hash||''),
      Number(a.valuation_tl||0), Number(a.lifetime_revenue_tl||0), Number(a.lifetime_plays||0),
      Number(payload.sub), verifyUrl, qrData, certHash,
      totalPaid,
      `a:${fromA},b:${fromB},p:${fromP}`,
      JSON.stringify({tl_a:fromA, tl_b:fromB, tl_p:fromP, total: totalPaid})
    ).run();

    // 이벤트
    await c.env.DB.prepare(
      "INSERT INTO tl_asset_events (asset_id, cert_no, event_type, event_data, actor_user_id) VALUES (?,?,'certified',?,?)"
    ).bind(assetId, certNo, JSON.stringify({cert_hash: certHash, fee_paid: totalPaid, fee_breakdown:{tl_a:fromA,tl_b:fromB,tl_p:fromP}}), Number(payload.sub)).run().catch(()=>{});

    return c.json({
      ok: true,
      cert_no: certNo,
      asset_id: assetId,
      cert_hash: certHash,
      verify_url: verifyUrl,
      qr_data: qrData,
      issued_at: new Date().toISOString(),
      fee_paid: totalPaid,
      fee_breakdown: { tl_a: fromA, tl_b: fromB, tl_p: fromP },
      balance: { tl_a: newA, tl_b: newB, tl_p: newP, total: newTotal }
    });
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('assets-certify', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(_){}
    return c.json({ok:false,error:e.message||'certify error'},500);
  }
});

// GET /api/v1/certs/:cert_no — 증명서 조회
app.get('/api/v1/certs/:cert_no', async (c) => {
  try {
    const certNo = String(c.req.param('cert_no') || '').trim();
    if (!certNo) return c.json({ok:false,error:'cert_no 필요'},400);

    const cert = await c.env.DB.prepare(`
      SELECT c.*, u.username AS issuer_name
      FROM tl_asset_certs c
      LEFT JOIN users u ON u.id = c.issued_by
      WHERE c.cert_no=?
    `).bind(certNo).first<any>();
    if (!cert) return c.json({ok:false,error:'증명서 없음'},404);

    let snapshot:any = {};
    try { snapshot = JSON.parse(cert.snapshot_json); } catch(_){}

    return c.json({
      ok: true,
      cert: {
        cert_no: cert.cert_no,
        asset_id: cert.asset_id,
        snapshot: snapshot,
        asset_hash: cert.asset_hash,
        valuation_at_issue: cert.valuation_at_issue,
        revenue_at_issue: cert.revenue_at_issue,
        plays_at_issue: cert.plays_at_issue,
        cert_hash: cert.cert_hash,
        issued_at: cert.issued_at,
        issuer_name: cert.issuer_name,
        verify_url: cert.verify_url,
        qr_data: cert.qr_data,
        chain_status: cert.chain_status,
        chain_tx_hash: cert.chain_tx_hash,
        chain_network: cert.chain_network,
        status: cert.status
      }
    });
  } catch(e:any) {
    return c.json({ok:false,error:e.message||'error'},500);
  }
});

// GET /api/v1/certs/:cert_no/verify — 검증 (해시 재계산)
app.get('/api/v1/certs/:cert_no/verify', async (c) => {
  try {
    const certNo = String(c.req.param('cert_no') || '').trim();
    const cert = await c.env.DB.prepare(
      'SELECT snapshot_json, cert_hash, status, chain_status, chain_tx_hash, chain_network FROM tl_asset_certs WHERE cert_no=?'
    ).bind(certNo).first<any>();
    if (!cert) return c.json({ok:false, valid:false, error:'증명서 없음'},404);

    const recomputed = await assetHash256(cert.snapshot_json);
    const valid = recomputed === cert.cert_hash && cert.status === 'active';

    return c.json({
      ok: true,
      valid: valid,
      cert_no: certNo,
      cert_hash: cert.cert_hash,
      recomputed_hash: recomputed,
      status: cert.status,
      chain_status: cert.chain_status,
      chain_tx_hash: cert.chain_tx_hash,
      chain_network: cert.chain_network,
      verified_at: new Date().toISOString()
    });
  } catch(e:any) {
    return c.json({ok:false,error:e.message||'error'},500);
  }
});

// ═══════════════════════════════════════════════════════════════
// CERT_DOWNLOAD_V1 — 증명서 다운로드 (1,000 TL / 365일)
// ═══════════════════════════════════════════════════════════════

const CERT_DOWNLOAD_FEE = 1000;
const CERT_DOWNLOAD_DAYS = 365;

// POST /api/v1/certs/:cert_no/download — 1,000 TL 결제 + 토큰 발급
app.post('/api/v1/certs/:cert_no/download', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);

    const certNo = String(c.req.param('cert_no') || '').trim();
    if (!certNo) return c.json({ok:false,error:'cert_no 필요'},400);

    const cert = await c.env.DB.prepare(
      "SELECT cert_no, asset_id, status FROM tl_asset_certs WHERE cert_no=?"
    ).bind(certNo).first<any>();
    if (!cert) return c.json({ok:false,error:'증명서 없음'},404);
    if (cert.status !== 'active') return c.json({ok:false,error:'비활성 증명서'},403);

    const userId = Number(payload.sub);

    // 이미 유효한 다운로드 토큰이 있으면 재사용
    const now = new Date().toISOString();
    const existing = await c.env.DB.prepare(`
      SELECT token, expires_at, download_count
      FROM tl_cert_downloads
      WHERE cert_no=? AND user_id=? AND status='active' AND expires_at > ?
      ORDER BY id DESC LIMIT 1
    `).bind(certNo, userId, now).first<any>();

    if (existing) {
      return c.json({
        ok: true,
        already: true,
        cert_no: certNo,
        download_token: existing.token,
        expires_at: existing.expires_at,
        download_count: Number(existing.download_count || 0),
        fee_charged: 0
      });
    }

    // TL 잔액 확인 + 차감 (tl_a → tl_b → tl_p)
    const u = await c.env.DB.prepare(
      'SELECT tl, tl_a, tl_b, tl_p FROM users WHERE id=? AND is_active=1'
    ).bind(userId).first<any>();
    if (!u) return c.json({ok:false,error:'사용자 없음'},401);

    const tlA = Number(u.tl_a || 0), tlB = Number(u.tl_b || 0), tlP = Number(u.tl_p || 0);
    const totalBal = tlA + tlB + tlP;
    if (totalBal < CERT_DOWNLOAD_FEE) {
      return c.json({
        ok: false,
        code: 'TL_INSUFFICIENT',
        error: 'TL 부족',
        required: CERT_DOWNLOAD_FEE,
        balance: totalBal
      }, 402);
    }

    let remain = CERT_DOWNLOAD_FEE;
    let fromA = 0, fromB = 0, fromP = 0;
    if (remain > 0 && tlA > 0) { fromA = Math.min(tlA, remain); remain -= fromA; }
    if (remain > 0 && tlB > 0) { fromB = Math.min(tlB, remain); remain -= fromB; }
    if (remain > 0 && tlP > 0) { fromP = Math.min(tlP, remain); remain -= fromP; }
    const totalPaid = fromA + fromB + fromP;
    const newA = tlA - fromA, newB = tlB - fromB, newP = tlP - fromP;
    const newTotal = newA + newB + newP;

    await c.env.DB.prepare(`
      UPDATE users SET
        tl_a = ?, tl_b = ?, tl_p = ?, tl = ?,
        total_tl_spent = COALESCE(total_tl_spent,0) + ?
      WHERE id=?
    `).bind(newA, newB, newP, newTotal, totalPaid, userId).run();

    // transactions
    try {
      await c.env.DB.prepare(`
        INSERT INTO transactions(user_id, tx_type, amount, balance_after, note)
        VALUES (?, 'cert_download', ?, ?, ?)
      `).bind(userId, -totalPaid, newTotal, `증명서 다운로드 ${certNo} (a:${fromA} b:${fromB} p:${fromP})`).run();
    } catch(_){}

    // 토큰 생성
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2,'0')).join('');

    // 365일 후 만료
    const expiresAt = new Date(Date.now() + CERT_DOWNLOAD_DAYS*24*3600*1000).toISOString();

    await c.env.DB.prepare(`
      INSERT INTO tl_cert_downloads (cert_no, user_id, token, fee_tl, fee_breakdown, expires_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      certNo, userId, token, totalPaid,
      JSON.stringify({tl_a:fromA, tl_b:fromB, tl_p:fromP, total: totalPaid}),
      expiresAt
    ).run();

    // 이벤트
    await c.env.DB.prepare(
      "INSERT INTO tl_asset_events (asset_id, cert_no, event_type, event_data, actor_user_id) VALUES (?,?,'downloaded',?,?)"
    ).bind(cert.asset_id, certNo, JSON.stringify({fee: totalPaid, expires_at: expiresAt}), userId).run().catch(()=>{});

    return c.json({
      ok: true,
      cert_no: certNo,
      download_token: token,
      expires_at: expiresAt,
      fee_paid: totalPaid,
      fee_breakdown: { tl_a: fromA, tl_b: fromB, tl_p: fromP },
      balance: { tl_a: newA, tl_b: newB, tl_p: newP, total: newTotal }
    });
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('cert-download', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(_){}
    return c.json({ok:false,error:e.message||'download error'},500);
  }
});

// CERT3_ROUTE_V1: POST /api/v1/certs/:cert_no/file.tl3 — 이미지 → TL3 래핑
app.post('/api/v1/certs/:cert_no/file.tl3', async (c) => {
  try {
    const certNo = String(c.req.param('cert_no') || '').trim();
    if (!certNo) return c.json({ok:false,error:'cert_no 필요'},400);

    const body = await c.req.json<any>().catch(()=>({}));
    const token = String(body.token || '').trim();
    const imageB64 = String(body.image_b64 || '').trim();
    if (!token || !imageB64) return c.json({ok:false,error:'token과 image_b64 필요'},400);
    if (imageB64.length > 8 * 1024 * 1024) return c.json({ok:false,error:'이미지가 너무 큽니다 (8MB 제한)'},413);

    const now = new Date().toISOString();
    const dl = await c.env.DB.prepare(`
      SELECT id, user_id, expires_at, status, download_count
      FROM tl_cert_downloads
      WHERE cert_no=? AND token=?
    `).bind(certNo, token).first<any>();
    if (!dl) return c.json({ok:false,error:'유효하지 않은 토큰'},403);
    if (dl.status !== 'active') return c.json({ok:false,error:'비활성 토큰'},403);
    if (dl.expires_at <= now) return c.json({ok:false,error:'만료된 토큰'},410);

    const cert = await c.env.DB.prepare(`
      SELECT c.*, u.username AS issuer_name
      FROM tl_asset_certs c
      LEFT JOIN users u ON u.id = c.issued_by
      WHERE c.cert_no=?
    `).bind(certNo).first<any>();
    if (!cert) return c.json({ok:false,error:'증명서 없음'},404);

    let snapshot:any = {};
    try { snapshot = JSON.parse(cert.snapshot_json); } catch(_){}

    let imageBytes: Uint8Array;
    try {
      const bin = atob(imageB64);
      imageBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) imageBytes[i] = bin.charCodeAt(i);
    } catch(e:any) {
      return c.json({ok:false,error:'이미지 디코딩 실패: ' + e.message},400);
    }

    const tl3 = await buildCertTL3(imageBytes, {
      cert_no: certNo,
      asset_id: cert.asset_id,
      title: snapshot.title || '',
      artist: snapshot.artist || '',
      snapshot: snapshot,
      cert_hash: cert.cert_hash,
      issued_at: cert.issued_at,
      issuer: cert.issuer_name || 'Taolee'
    });

    await c.env.DB.prepare(`
      UPDATE tl_cert_downloads
      SET download_count = download_count + 1,
          last_downloaded_at = datetime('now')
      WHERE id=?
    `).bind(dl.id).run();

    try {
      await c.env.DB.prepare(
        "INSERT INTO tl_asset_events (asset_id, cert_no, event_type, event_data, actor_user_id) VALUES (?,?,'tl3_downloaded',?,?)"
      ).bind(cert.asset_id, certNo, JSON.stringify({size: tl3.length, img_size: imageBytes.length}), dl.user_id).run();
    } catch(_){}

    const filename = certNo + '.tl3';
    const headers = new Headers();
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment; filename="' + filename + '"');
    headers.set('Content-Length', String(tl3.length));
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition');

    return new Response(tl3, { status: 200, headers });
  } catch(e:any) {
    try {
      await c.env.DB.prepare('INSERT INTO tl3_debug_logs(route,error,stack,created_at) VALUES(?,?,?,?)')
        .bind('cert3-file', String(e.message||''), String(e.stack||'').slice(0,2000), new Date().toISOString()).run();
    } catch(_){}
    return c.json({ok:false,error:e.message||'cert3 error'},500);
  }
});

// GET /api/v1/certs/:cert_no/file?token=xxx — 토큰 검증 후 JSON 다운로드
app.get('/api/v1/certs/:cert_no/file', async (c) => {
  try {
    const certNo = String(c.req.param('cert_no') || '').trim();
    const token = String(c.req.query('token') || '').trim();
    if (!certNo || !token) return c.json({ok:false,error:'cert_no와 token 필요'},400);

    const now = new Date().toISOString();
    const dl = await c.env.DB.prepare(`
      SELECT id, user_id, expires_at, status, download_count
      FROM tl_cert_downloads
      WHERE cert_no=? AND token=?
    `).bind(certNo, token).first<any>();
    if (!dl) return c.json({ok:false,error:'유효하지 않은 토큰'},403);
    if (dl.status !== 'active') return c.json({ok:false,error:'비활성 토큰'},403);
    if (dl.expires_at <= now) return c.json({ok:false,error:'만료된 토큰',expired_at:dl.expires_at},410);

    // 증명서 조회
    const cert = await c.env.DB.prepare(`
      SELECT c.*, u.username AS issuer_name
      FROM tl_asset_certs c
      LEFT JOIN users u ON u.id = c.issued_by
      WHERE c.cert_no=?
    `).bind(certNo).first<any>();
    if (!cert) return c.json({ok:false,error:'증명서 없음'},404);

    let snapshot:any = {};
    try { snapshot = JSON.parse(cert.snapshot_json); } catch(_){}

    // 다운로드 횟수 증가
    await c.env.DB.prepare(`
      UPDATE tl_cert_downloads
      SET download_count = download_count + 1,
          last_downloaded_at = datetime('now')
      WHERE id=?
    `).bind(dl.id).run();

    const origin = new URL(c.req.url).origin;

    // 응답 (JSON 다운로드)
    const payload = {
      _type: 'timelink_digital_asset_certificate',
      _version: '1.0',
      cert_no: cert.cert_no,
      asset_id: cert.asset_id,
      snapshot: snapshot,
      asset_hash: cert.asset_hash,
      cert_hash: cert.cert_hash,
      valuation_at_issue: cert.valuation_at_issue,
      revenue_at_issue: cert.revenue_at_issue,
      plays_at_issue: cert.plays_at_issue,
      issued_at: cert.issued_at,
      issuer_name: cert.issuer_name,
      verify_url: origin + '/api/v1/certs/' + certNo + '/verify',
      chain_status: cert.chain_status,
      chain_tx_hash: cert.chain_tx_hash,
      chain_network: cert.chain_network,
      downloaded_at: new Date().toISOString(),
      download_expires_at: dl.expires_at
    };

    return c.json({
      ok: true,
      certificate: payload,
      download_count: Number(dl.download_count || 0) + 1,
      expires_at: dl.expires_at
    });
  } catch(e:any) {
    return c.json({ok:false,error:e.message||'file error'},500);
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

// 무료 MP3 기출시/중복 검증
app.post('/api/music/verify-release', async (c) => {
  try {
    const auth=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
    const payload=await verifyToken(auth,c.env.JWT_SECRET);
    if(!payload?.sub) return c.json({error:'인증 필요'},401);
    const body=await c.req.json<any>().catch(()=>({}));
    const title=String(body.title||'').trim(), artist=String(body.artist||'').trim();
    const duration=Number(body.duration||0), originHash=String(body.origin_hash||'').trim().toLowerCase();
    if(!title) return c.json({error:'title 필요'},400);
    await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS tl_shares (id TEXT PRIMARY KEY)").run().catch(()=>{});
    await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN origin_hash TEXT DEFAULT ''").run().catch(()=>{});
    await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN release_check TEXT DEFAULT ''").run().catch(()=>{});
    if(originHash){
      const same=await c.env.DB.prepare("SELECT id,title,artist FROM tl_shares WHERE lower(COALESCE(origin_hash,''))=? LIMIT 1").bind(originHash).first<any>().catch(()=>null);
      if(same) return c.json({blocked:true,reason:'timelink_duplicate',message:'동일한 원본 파일이 이미 TimeLink에 등록되어 있습니다.',existing:same});
    }
    const env=c.env as any;
    if(!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET)
      return c.json({blocked:false,verification:'unavailable',message:'Spotify 외부 검증 키가 설정되지 않았습니다.'});
    const spToken=await getSpotifyToken(c.env);
    const q=[title,artist].filter(Boolean).join(' ');
    const r=await fetch('https://api.spotify.com/v1/search?q='+encodeURIComponent(q)+'&type=track&limit=10&market=KR',{headers:{Authorization:'Bearer '+spToken}});
    if(!r.ok) return c.json({blocked:false,verification:'unavailable',message:'외부 음악 카탈로그 확인을 완료하지 못했습니다.'});
    const d:any=await r.json();
    const norm=(v:any)=>String(v||'').toLowerCase().normalize('NFKC').replace(/\s+/g,' ').trim();
    const nt=norm(title),na=norm(artist);
    const matches=(d.tracks?.items||[]).map((t:any)=>{
      const ta=(t.artists||[]).map((a:any)=>a.name).join(', ');
      const tm=norm(t.name)===nt, am=na ? (norm(ta)===na || (t.artists||[]).some((a:any)=>norm(a.name)===na)) : true;
      const dm=!duration || !t.duration_ms || Math.abs(Number(t.duration_ms)/1000-duration)<=5;
      return {t,ta,tm,am,dm};
    }).filter((x:any)=>x.tm&&x.am&&x.dm);
    if(matches.length){
      const x=matches[0],t=x.t;
      return c.json({blocked:true,verification:'spotify_match',message:'Spotify에서 동일 곡으로 확인되어 무료 MP3 공개를 차단합니다.',match:{id:t.id,title:t.name,artist:x.ta,duration:Math.round((t.duration_ms||0)/1000),spotify_url:t.external_urls?.spotify||'',release_date:t.album?.release_date||''}});
    }
    return c.json({blocked:false,verification:'spotify_no_match',message:'Spotify에서 동일 조건의 기출시 곡을 확인하지 못했습니다.'});
  } catch(e:any) {
    return c.json({blocked:false,verification:'unavailable',message:'외부 검증 중 오류가 발생했습니다. 창작자 확인 절차로 진행할 수 있습니다.'});
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
function parseJWT(token: string): { userId: number; username: string; id?: number; sub?: number } {
  if (token.split('.').length === 3) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('Token expired');
      return {
        userId: Number(payload.userId || payload.id || payload.sub),
        id: Number(payload.id || 0),
        sub: Number(payload.sub || 0),
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
// CERT_MARK_V1: /api/shares에 cert_no 포함
app.get('/api/shares', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT s.*,
        COALESCE(u.username, s.username, 'User') as username,
        COALESCE(u.email, '') as user_email,
        'share' as source_table,
        NULL as cert_no
      FROM tl_shares s
      LEFT JOIN users u ON CAST(s.user_id AS TEXT) = CAST(u.id AS TEXT)
      WHERE EXISTS (SELECT 1 FROM tl_files f WHERE (f.stream_url=s.stream_url OR f.file_url=s.stream_url) AND LOWER(f.file_type)='audio/tl3' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 AND EXISTS (SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.rights_confirmed=1))
      UNION ALL
      SELECT
        CAST(f.id AS TEXT) as id, f.user_id, u.username as username,
        f.title, f.artist, '' as album, 0 as duration, f.file_tl,
        'Music' as category, f.file_type, '' as category_type,
        '' as description, 'A' as plan, '' as spotify_id, '' as spotify_url,
        '' as cover_url, '' as preview_url, COALESCE(NULLIF(f.stream_url,''),f.file_url) as stream_url,
        f.country, '' as content_lang, f.auth_status, f.shared,
        f.revenue, f.hold_revenue, f.revenue_held, f.pulse, f.play_count,
        f.created_at, f.updated_at,
        CASE WHEN lower(f.file_type)='audio/tl3' THEN 'tl3'
             WHEN lower(f.file_type) LIKE '%mp3%' OR lower(f.file_type) LIKE 'audio/%' THEN 'mp3'
             ELSE 'file' END as content_kind,
        'tl_file' as source_table,
        (SELECT c.cert_no FROM tl_asset_certs c
         JOIN tl_assets a ON a.asset_id = c.asset_id
         WHERE a.file_id = f.id AND c.status = 'active'
         LIMIT 1) AS cert_no
      FROM tl_files f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE LOWER(f.file_type)='audio/tl3' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 AND EXISTS (SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.rights_confirmed=1)
      ORDER BY created_at DESC LIMIT 200
    `).all();
    const origin=new URL(c.req.url).origin;
    const shares=(results||[]).map((r:any)=>{
      const isLegacy=r.source_table==='tl_file';
      const id=String(r.id);
      const contentKind=isLegacy?'tl3':(r.content_kind||shareKind(r));
      return {
        id,user_id:Number(r.user_id||0),username:String(r.username||'User'),
        title:String(r.title||''),artist:String(r.artist||''),album:String(r.album||''),
        duration:Number(r.duration||0),file_tl:Number(r.file_tl||0),
        category:String(r.category||'Music'),file_type:String(r.file_type||''),
        category_type:String(r.category_type||''),description:String(r.description||''),
        plan:String(r.plan||'FREE'),spotify_id:r.spotify_id||null,spotify_url:r.spotify_url||null,
        cover_url:r.cover_url||null,country:String(r.country||'KR'),content_lang:String(r.content_lang||'ko'),
        pulse:Number(r.pulse||0),play_count:Number(r.play_count||0),created_at:r.created_at,
        content_kind:contentKind,shared:1,auth_status:'verified',revenue_held:0,
        source_table:isLegacy?'tl_file':'share',
        stream_url:origin+(isLegacy?'/api/legacy-stream/':'/api/stream/')+encodeURIComponent(id)
      };
    });
    return c.json({shares});
  } catch (e: any) {
    return c.json({ shares: [], _note: e.message });
  }
});

// 🔥 POST /api/shares - 새 파일 공유
app.post('/api/shares', async (c) => {
  const auth=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  if(!auth) return c.json({error:'인증 필요'},401);
  let payload:any;
  try { payload=await verifyToken(auth,c.env.JWT_SECRET); } catch { return c.json({error:'Invalid token'},401); }
  const userId=Number(payload?.sub||0);
  if(!userId) return c.json({error:'인증 사용자 확인 불가'},401);
  const body=await c.req.json<any>().catch(()=>({}));
  if(!body.title) return c.json({error:'title 필요'},400);
  const userRow=await c.env.DB.prepare('SELECT id,username,email,is_active,account_forfeited FROM users WHERE id=?').bind(userId).first<any>();
  if(!userRow) return c.json({error:'유저 없음'},404);
  if(Number(userRow.is_active)===0||Number(userRow.account_forfeited||0)===1)return c.json({error:'비활성 계정은 공유할 수 없습니다.'},403);

  await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_shares (
    id TEXT PRIMARY KEY, user_id TEXT, username TEXT, title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '',
    duration INTEGER DEFAULT 0, file_tl INTEGER DEFAULT 0, category TEXT DEFAULT 'Music', file_type TEXT DEFAULT '',
    category_type TEXT DEFAULT '', description TEXT DEFAULT '', plan TEXT DEFAULT 'A', spotify_id TEXT, spotify_url TEXT,
    cover_url TEXT, preview_url TEXT, stream_url TEXT DEFAULT '', country TEXT DEFAULT 'KR', content_lang TEXT DEFAULT 'ko',
    pulse INTEGER DEFAULT 0, created_at INTEGER NOT NULL
  )`).run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN release_mode TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN storage_mode TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN origin_hash TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN release_check TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN content_kind TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN price_per_sec REAL DEFAULT 1").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN composer TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN lyricist TEXT DEFAULT ''").run().catch(()=>{});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN lyrics TEXT DEFAULT ''").run().catch(()=>{});

  const releaseMode=String(body.release_mode||'').toLowerCase();
  const fileType=String(body.file_type||'').toLowerCase();
  if(releaseMode.startsWith('free_mp3')||fileType==='audio/mp3'||fileType==='audio/mpeg')
    return c.json({error:'MP3 원본은 비공개 소스 자산입니다. TL3로 변환한 뒤 공유해 주세요.'},400);
  if(releaseMode!=='tl3'||fileType!=='audio/tl3')
    return c.json({error:'정식 TL3 디지털 자산만 공유할 수 있습니다.'},400);
  if(body.rights_confirmed!==true)return c.json({error:'창작자 권리 확인이 필요합니다.'},400);
  const streamUrl=String(body.stream_url||'').trim();
  let storageKey=streamUrl;
  if(streamUrl.includes('/api/storage/'))storageKey=decodeURIComponent(streamUrl.split('/api/storage/')[1].split('?')[0]);
  const ownedKey=storageKey.match(/^tracks\/u(\d+)\/[A-Za-z0-9_-]{1,160}\.tl3$/i);
  if(!ownedKey||Number(ownedKey[1])!==userId)return c.json({error:'TL3 저장 자산의 소유권을 확인할 수 없습니다.'},403);
  const stored=await getD1ObjectMeta(c.env.DB,storageKey);
  if(!stored)return c.json({error:'완료된 TL3 저장 자산을 찾을 수 없습니다.'},404);
  const prefix=await readD1Range(c.env.DB,storageKey,0,Math.min(stored.size,7));
  if(prefix.byteLength<7||prefix[0]!==0x54||prefix[1]!==0x4c||prefix[2]!==0x4e||prefix[3]!==0x4b||prefix[4]!==0x02)return c.json({error:'유효한 TL3 v2 컨테이너가 아닙니다.'},400);
  const headerLength=(prefix[5]<<8)|prefix[6];
  if(headerLength<=0||7+headerLength>stored.size)return c.json({error:'TL3 메타데이터가 손상되었습니다.'},400);
  const headerBytes=await readD1Range(c.env.DB,storageKey,7,headerLength);
  let header:any;
  try{header=JSON.parse(new TextDecoder().decode(headerBytes));}catch{return c.json({error:'TL3 메타데이터 JSON이 올바르지 않습니다.'},400);}
  if(String(header.cid||'')!==String(userId))return c.json({error:'TL3 창작자 ID가 로그인 사용자와 일치하지 않습니다.'},403);
  const approvedFile=await c.env.DB.prepare(
    "SELECT f.id FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id WHERE f.user_id=? AND LOWER(f.file_type)='audio/tl3' AND (f.stream_url=? OR f.file_url=?) AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 AND r.status='released' AND r.rights_confirmed=1 LIMIT 1"
  ).bind(userId,streamUrl,streamUrl).first();
  if(!approvedFile)return c.json({error:'창작자 권리 확인을 마친 TL3 자산을 먼저 발행해야 합니다.'},403);
  const originHash=String(body.origin_hash||'').trim().toLowerCase();
  if(originHash){
    const same=await c.env.DB.prepare("SELECT id,title,artist FROM tl_shares WHERE lower(COALESCE(origin_hash,''))=? LIMIT 1").bind(originHash).first<any>().catch(()=>null);
    if(same)return c.json({error:'동일한 원본 자산이 이미 등록되어 있습니다.',existing:same},409);
  }
  const isFreeMp3=false;

  const tlP=Number((await c.env.DB.prepare('SELECT COALESCE(tl_p,tl,0) v FROM users WHERE id=?').bind(userId).first<any>())?.v||0);
  const tlA=Number((await c.env.DB.prepare('SELECT COALESCE(tl_a,0) v FROM users WHERE id=?').bind(userId).first<any>())?.v||0);
  const tlB=Number((await c.env.DB.prepare('SELECT COALESCE(tl_b,0) v FROM users WHERE id=?').bind(userId).first<any>())?.v||0);
  const currentTL=tlP+tlA+tlB;
  if(!isFreeMp3 && currentTL<5000) return c.json({error:'TL 부족',required:5000,current:currentTL},402);
  if(!isFreeMp3){
    let rem=5000,a=tlA,b=tlB,p=tlP;
    const da=Math.min(rem,a);a-=da;rem-=da;
    const db=Math.min(rem,b);b-=db;rem-=db;
    const dp=Math.min(rem,p);p-=dp;rem-=dp;
    if(rem>0) return c.json({error:'TL 잔액이 부족합니다.',required:5000,current:currentTL},402);
    await c.env.DB.prepare('UPDATE users SET tl=?,tl_p=?,tl_a=?,tl_b=?,total_tl_spent=COALESCE(total_tl_spent,0)+5000 WHERE id=?').bind(a+b+p,p,a,b,userId).run();
  }

  const id='sh_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
  const fileTl=isFreeMp3?0:Number(body.file_tl||5000);
  await c.env.DB.prepare(`INSERT INTO tl_shares
    (id,user_id,username,title,artist,album,duration,file_tl,category,file_type,category_type,description,plan,
     spotify_id,spotify_url,cover_url,preview_url,stream_url,country,content_lang,pulse,created_at,price_per_sec,
     composer,lyricist,lyrics,release_mode,storage_mode,origin_hash,release_check)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`).bind(
      id,String(userId),userRow.username||'User',String(body.title),String(body.artist||''),String(body.album||''),
      Number(body.duration||0),fileTl,String(body.category||'Music'),String(body.file_type||''),String(body.category_type||''),
      String(body.description||''),String(body.plan||'A'),body.spotify_id||null,body.spotify_url||null,body.cover_url||null,
      body.preview_url||null,String(body.stream_url||''),String(body.country||'KR'),String(body.content_lang||'ko'),Date.now(),
      Number(body.price_per_sec||1),String(body.composer||''),String(body.lyricist||''),String(body.lyrics||''),
      String(body.release_mode||''),String(body.storage_mode||''),String(body.origin_hash||''),String(body.release_check||'')
    ).run();

  await c.env.DB.prepare('INSERT OR IGNORE INTO tl_user_files (user_id,share_id,tl_balance,total_charged,created_at) VALUES (?,?,?,?,datetime(\'now\'))')
    .bind(userId,id,fileTl,fileTl).run().catch(()=>{});
  await c.env.DB.prepare('UPDATE tl_shares SET content_kind=? WHERE id=?').bind(isFreeMp3?'mp3':'tl3',id).run().catch(()=>{});
  return c.json({ok:true,id,tl_remaining:currentTL-(isFreeMp3?0:5000)});
});

// ── MP3/TL3 분류: 서버 단일 기준 (프론트는 content_kind만 신뢰) ──
function shareKind(r:any):'mp3'|'tl3'{
  const ft=String(r?.file_type||'').toLowerCase();
  const ck=String(r?.content_kind||'').toLowerCase();
  const rm=String(r?.release_mode||'').toLowerCase();
  const su=String(r?.stream_url||'').toLowerCase();
  if(ft==='audio/mpeg'||ft==='audio/mp3'||rm.startsWith('free_mp3')||ck==='mp3') return 'mp3';
  if(rm==='tl3'||ck==='tl3'||ft==='audio/tl3'||/\.(tl3|tl4|tlg|tlf)(\?|$)/.test(su)) return 'tl3';
  // 표시 없는 옛 곡: TL 가격(file_tl)이 붙어 있으면 TL 콘텐츠, 없으면 무료
  return Number(r?.file_tl||0)>0 ? 'tl3' : 'mp3';
}

async function ensureShareTLBalances(db: D1Database){
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tl_user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      share_id TEXT NOT NULL,
      tl_balance REAL DEFAULT 0,
      total_charged REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, share_id)
    )
  `).run();
}
async function ensureTL3AssetTL(db:D1Database,fileId:number){
  await db.prepare(`CREATE TABLE IF NOT EXISTS tl3_assertion_guard (ok INTEGER NOT NULL CHECK(ok=1))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS tl3_asset_tl (
    file_id INTEGER PRIMARY KEY, share_id TEXT NOT NULL,
    initial_tl REAL NOT NULL DEFAULT 0, remaining_tl REAL NOT NULL DEFAULT 0,
    consumed_tl REAL NOT NULL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS tl3_stream_sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, file_id INTEGER NOT NULL, share_id TEXT NOT NULL,
    next_segment INTEGER NOT NULL DEFAULT 0, last_segment_at INTEGER DEFAULT 0,
    pending_segment INTEGER DEFAULT NULL, pending_cost REAL DEFAULT 0,
    pending_duration_ms INTEGER DEFAULT 0, pending_delivered_at INTEGER DEFAULT 0,
    pending_tl_p REAL DEFAULT 0, pending_tl_a REAL DEFAULT 0, pending_tl_b REAL DEFAULT 0,
    prefetch_segment INTEGER DEFAULT NULL, prefetch_cost REAL DEFAULT 0,
    prefetch_tl_p REAL DEFAULT 0, prefetch_tl_a REAL DEFAULT 0, prefetch_tl_b REAL DEFAULT 0,
    prefetch_duration_ms INTEGER DEFAULT 0, prefetch_delivered_at INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN pending_tl_p REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN pending_tl_a REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN pending_tl_b REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_segment INTEGER DEFAULT NULL").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_cost REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_tl_p REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_tl_a REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_tl_b REAL DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_duration_ms INTEGER DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl3_stream_sessions ADD COLUMN prefetch_delivered_at INTEGER DEFAULT 0").run().catch(()=>{});
  await db.prepare(`
    INSERT OR IGNORE INTO tl3_asset_tl(file_id,share_id,initial_tl,remaining_tl,consumed_tl)
    SELECT r.file_id,r.share_id,
      COALESCE(SUM(s.duration_ms),0)/1000.0,
      COALESCE(SUM(s.duration_ms),0)/1000.0,0
    FROM tl3_releases r JOIN tl3_segments s ON s.file_id=r.file_id
    WHERE r.file_id=? AND r.status='released'
    GROUP BY r.file_id,r.share_id
  `).bind(fileId).run();
  return await db.prepare('SELECT * FROM tl3_asset_tl WHERE file_id=?').bind(fileId).first<any>();
}
function tlWalletParts(user:any){
  const p=Number(user?.tl_p||0),a=Number(user?.tl_a||0),b=Number(user?.tl_b||0);
  // Prefer the normalized SQL alias when present. Numeric zero must be treated
  // as empty: legacy columns can arrive as the string "0", which is truthy in JS.
  if(p+a+b>0) return {p,a,b};
  const candidates=[user?.p,user?.tl_balance,user?.tl].map((v:any)=>Number(v));
  const legacy=candidates.find((v:number)=>Number.isFinite(v)&&v>0) ?? 0;
  return {p:Math.max(0,legacy),a:0,b:0};
}
async function shareAuthUser(c:any){
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  if(!token) return null;
  const payload=await verifyToken(token,c.env.JWT_SECRET).catch(()=>null);
  if(!payload?.sub) return null;
  const userId=Number(payload.sub);
  return Number.isSafeInteger(userId)&&userId>0 ? userId : null;
}

// 개인 보관함: tl_shares와 구형 tl_files를 읽기 전용으로 함께 조회한다.
// 원본 파일 주소, 스트림 주소, OAuth 증빙 경로는 반환하지 않는다.
app.get('/api/shares/my', async (c) => {
  const userId=await shareAuthUser(c);
  if(!userId) return c.json({error:'인증 필요'},401);
  const limit=Math.max(1,Math.min(Number(c.req.query('limit')||100),200));
  const offset=Math.max(0,Number(c.req.query('offset')||0));
  try {
    const [shares,files]=await Promise.all([
      c.env.DB.prepare(
        "SELECT id,title,artist,album,duration,file_tl,category,file_type,category_type,description,cover_url,content_kind,release_mode,storage_mode,origin_hash,release_check,pulse,created_at FROM tl_shares WHERE CAST(user_id AS INTEGER)=? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).bind(userId,limit,offset).all(),
      c.env.DB.prepare(
        "SELECT id,title,artist,genre,file_type,file_size_bytes,duration_seconds,auth_status,shared,play_count,created_at,updated_at FROM tl_files WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).bind(userId,limit,offset).all()
    ]);
    return c.json({shares:shares.results||[],files:files.results||[],limit,offset});
  } catch(e:any) {
    return c.json({error:e?.message||'개인 파일 목록 조회 실패'},500);
  }
});

// ── 유저의 특정 곡 TL 잔액 조회 ──
app.get('/api/shares/:id/my-tl', async (c) => {
  const userId=await shareAuthUser(c);
  if(!userId) return c.json({error:'인증 필요'},401);
  let requestedId=String(c.req.param('id')||'').trim();
  let canonicalShareId=requestedId;
  try{
    await ensureShareTLBalances(c.env.DB);

    // First resolve a normal share. Do not assume tl3_releases.share_id exists:
    // older production schemas may predate that additive column.
    const share=await c.env.DB.prepare(
      'SELECT id,file_tl FROM tl_shares WHERE id=? LIMIT 1'
    ).bind(requestedId).first<any>();

    if(!share && /^\d+$/.test(requestedId)){
      const fileId=Number(requestedId);
      const release=await c.env.DB.prepare(
        "SELECT file_id FROM tl3_releases WHERE file_id=? AND status='released' LIMIT 1"
      ).bind(fileId).first<any>();
      if(!release) return c.json({error:'파일 없음'},404);

      // share_id is optional across deployed schema generations. Read it only
      // after confirming the release exists, and fall back to the numeric ID
      // when the column is not present in the returned row.
      let releaseWithShare:any=release;
      try{
        releaseWithShare=await c.env.DB.prepare(
          "SELECT file_id,share_id FROM tl3_releases WHERE file_id=? AND status='released' LIMIT 1"
        ).bind(fileId).first<any>() || release;
      }catch(_){}
      canonicalShareId=String(releaseWithShare?.share_id||fileId);
    }else if(!share){
      return c.json({error:'파일 없음'},404);
    }

    let row=await c.env.DB.prepare(
      'SELECT tl_balance,total_charged FROM tl_user_files WHERE user_id=? AND share_id=?'
    ).bind(userId,canonicalShareId).first<any>();
    if(!row){
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO tl_user_files (user_id,share_id,tl_balance,total_charged) VALUES (?,?,0,0)'
      ).bind(userId,canonicalShareId).run();
      row={tl_balance:0,total_charged:0};
    }
    return c.json({
      ok:true,
      tl_balance:Number(row.tl_balance||0),
      total_charged:Number(row.total_charged||0),
      file_tl:Number(share?.file_tl||0),
      share_id:canonicalShareId
    });
  }catch(e:any){
    console.error('[SHARE_MY_TL_ERROR]',{requested_id:requestedId,user_id:userId,error:String(e?.message||e)});
    return c.json({error:'TL 잔액 조회에 실패했습니다.',code:'SHARE_TL_LOOKUP_FAILED'},500);
  }
});

// ── TL3 전용 TL 충전: 사용자의 공용 TL을 특정 파일 잔액으로 이동 ──
app.post('/api/shares/:id/charge', async (c) => {
  const userId=await shareAuthUser(c);
  if(!userId) return c.json({error:'인증 필요'},401);
  let shareId=c.req.param('id');
  try{
    const body=await c.req.json<any>().catch(()=>({}));
    const amount=Math.floor(Number(body.amount||0));
    if(!Number.isFinite(amount)||amount<=0) return c.json({error:'충전 TL은 1 이상이어야 합니다.'},400);
    await ensureShareTLBalances(c.env.DB);
    let share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    let tl3Release=await c.env.DB.prepare("SELECT * FROM tl3_releases WHERE share_id=? AND status='released'").bind(shareId).first<any>();

    // ★ 핵심: shareId가 숫자(file_id)로 들어온 경우 -> share_id로 변환
    if (!share && !tl3Release && /^\d+$/.test(shareId)) {
      const numericId = Number(shareId);
      // 1. tl3_releases에서 file_id로 진짜 share_id 찾기
      const releaseByFileId = await c.env.DB.prepare("SELECT * FROM tl3_releases WHERE file_id=? AND status='released'").bind(numericId).first<any>();
      if (releaseByFileId) {
        tl3Release = releaseByFileId;
        shareId = releaseByFileId.share_id; // 변수 업데이트
      }

    }

    if(!share && !tl3Release) return c.json({error:'파일 없음'},404);
    if(share){
      const isMp3=shareKind(share)==='mp3';
      if(isMp3) return c.json({error:'MP3는 무료 재생이며 TL 충전 대상이 아닙니다.'},400);
    }

    const user=await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first<any>();
    if(!user) return c.json({error:'유저 없음'},404);
    // 구매/보너스/광고 TL을 합산한 실제 공용 잔액을 사용한다.
    // 결제 시스템은 tl + tl_p/tl_a/tl_b 구조를 사용하므로 레거시 tl_balance에만 의존하지 않는다.
    const tlP=Number(user.tl_p ?? user.tl ?? user.tl_balance ?? 0);
    const tlA=Number(user.tl_a ?? 0);
    const tlB=Number(user.tl_b ?? 0);
    const current=tlP+tlA+tlB;
    if(current<amount) return c.json({error:'TL 잔액이 부족합니다.',required:amount,current,tl:current,tl_balance:current},402);

    // 소비 우선순위는 광고/보너스(TL_A/TL_B) → 구매 TL(TL_P)로 맞춰
    // 구매 TL을 가능한 한 보존한다.
    let rem=amount;
    const takeA=Math.min(rem,tlA); rem-=takeA;
    const takeB=Math.min(rem,tlB); rem-=takeB;
    const takeP=rem;
    const newA=tlA-takeA;
    const newB=tlB-takeB;
    const newP=tlP-takeP;
    const newTotal=newP+newA+newB;

    const batch=await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE users SET tl=?, tl_p=?, tl_a=?, tl_b=?, total_tl_spent=COALESCE(total_tl_spent,0)+? WHERE id=? AND (COALESCE(tl_p,tl,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0))>=?'
      ).bind(newTotal,newP,newA,newB,amount,userId,amount),
      c.env.DB.prepare(`
        INSERT INTO tl_user_files (user_id,share_id,tl_balance,total_charged)
        VALUES (?,?,?,?)
        ON CONFLICT(user_id,share_id) DO UPDATE SET
          tl_balance=tl_user_files.tl_balance+excluded.tl_balance,
          total_charged=tl_user_files.total_charged+excluded.total_charged,
          updated_at=datetime('now')
      `).bind(userId,shareId,amount,amount)
    ]);
    if(Number(batch[0]?.meta?.changes||0)!==1) return c.json({error:'TL 충전에 실패했습니다. 잔액이 변경되었을 수 있으니 다시 확인해주세요.'},409);

    const freshUser=await c.env.DB.prepare(
      'SELECT COALESCE(tl,0) as tl, COALESCE(tl_p,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=?'
    ).bind(userId).first<any>();
    const freshFile=await c.env.DB.prepare('SELECT tl_balance,total_charged FROM tl_user_files WHERE user_id=? AND share_id=?').bind(userId,shareId).first<any>();
    const freshTotal=Number(freshUser?.tl_p||0)+Number(freshUser?.tl_a||0)+Number(freshUser?.tl_b||0);
    return c.json({ok:true,amount,user_tl:freshTotal,tl_balance:Number(freshFile?.tl_balance||0),total_charged:Number(freshFile?.total_charged||0),tl_p:Number(freshUser?.tl_p||0),tl_a:Number(freshUser?.tl_a||0),tl_b:Number(freshUser?.tl_b||0)});
  }catch(e:any){
    return c.json({error:e?.message||'TL 충전 실패'},500);
  }
});

// ── TL3 재생 시간 소비: 파일 잔액에서 차감하고 창작자 수익 정산 ──
app.post('/api/shares/:id/consume', async (c) => {
  const userId=await shareAuthUser(c);
  if(!userId) return c.json({error:'인증 필요'},401);
  let shareId=c.req.param('id');
  try{
    const body=await c.req.json<any>().catch(()=>({}));
    const seconds=Math.max(1,Math.min(30,Math.floor(Number(body.seconds||0))));
    await ensureShareTLBalances(c.env.DB);
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);
    const isMp3=shareKind(share)==='mp3';
    if(isMp3) return c.json({ok:true,consumed:0,user_tl:0,tl_balance:0,free:true});

    const row=await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?')
      .bind(userId,shareId).first<any>();
    let before=Number(row?.tl_balance||0);

    // ⭐ 지갑 잔액 확인
    const u=await c.env.DB.prepare('SELECT COALESCE(tl,0) as tl, COALESCE(tl_p,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=?').bind(userId).first<any>();
    let walletP=Number(u?.tl_p||0);
    const walletA=Number(u?.tl_a||0);
    const walletB=Number(u?.tl_b||0);
    let walletTotal=walletP+walletA+walletB;

    // ⭐ 지갑도 부족하면 402
    if(walletTotal<seconds) return c.json({ok:false,error:'TL이 부족합니다. 충전해주세요.',need_charge:true,required:seconds,current:before,wallet:walletTotal,user_tl:before,tl_balance:before},402);

    // ⭐ 파일 tl_balance도 부족하면 지갑에서 자동 충전
    if(before<seconds){
      const need=seconds-before;
      // 지갑에서 차감 (A→B→P 순)
      let rem=need;
      const takeA=Math.min(rem,walletA); rem-=takeA;
      const takeB=Math.min(rem,walletB); rem-=takeB;
      const takeP=rem;
      const newA=walletA-takeA;
      const newB=walletB-takeB;
      const newP=walletP-takeP;
      const newTotal=newP+newA+newB;
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE users SET tl=?, tl_p=?, tl_a=?, tl_b=? WHERE id=?').bind(newTotal,newP,newA,newB,userId),
        c.env.DB.prepare("INSERT INTO tl_user_files (user_id,share_id,tl_balance,total_charged) VALUES (?,?,?,?) ON CONFLICT(user_id,share_id) DO UPDATE SET tl_balance=tl_user_files.tl_balance+excluded.tl_balance, total_charged=tl_user_files.total_charged+excluded.total_charged, updated_at=datetime('now')").bind(userId,shareId,need,need)
      ]);
      before += need;
      walletP = newP;
      walletTotal = newTotal;
    }

    const revenue=seconds*0.7;
    const creatorId=Number(share.user_id||0);
    const creator=creatorId?await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(creatorId).first<any>():null;
    const creatorCol='tl_balance';

    const statements=[
      // 1) 파일 tl_balance 차감
      c.env.DB.prepare('UPDATE tl_user_files SET tl_balance=tl_balance-?,updated_at=datetime("now") WHERE user_id=? AND share_id=? AND tl_balance>=?').bind(seconds,userId,shareId,seconds),
      // 2) ⭐ 지갑에서도 동시 차감 (tl_p → tl_a → tl_b 순으로 우선)
      c.env.DB.prepare('UPDATE users SET tl=COALESCE(tl,0)-?, tl_p=COALESCE(tl_p,0)-?, total_tl_spent=COALESCE(total_tl_spent,0)+? WHERE id=? AND COALESCE(tl_p,0)>=?').bind(seconds,seconds,seconds,userId,seconds),
      // 3) pulse 증가
      c.env.DB.prepare('UPDATE tl_shares SET pulse=COALESCE(pulse,0)+? WHERE id=?').bind(seconds,shareId)
    ];
    if(creator) statements.push(
      c.env.DB.prepare('UPDATE users SET '+creatorCol+'='+creatorCol+'+?, total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?').bind(revenue,revenue,creatorId)
    );
    const batch=await c.env.DB.batch(statements);
    if(Number(batch[0]?.meta?.changes||0)!==1) return c.json({ok:false,error:'TL 소비 처리에 실패했습니다.'},409);

    const fresh=await c.env.DB.prepare('SELECT tl_balance,total_charged FROM tl_user_files WHERE user_id=? AND share_id=?').bind(userId,shareId).first<any>();
    const freshWallet=await c.env.DB.prepare('SELECT COALESCE(tl_p,0) as tl_p, COALESCE(tl_a,0) as tl_a, COALESCE(tl_b,0) as tl_b FROM users WHERE id=?').bind(userId).first<any>(); const walletNow=Number(freshWallet?.tl_p||0)+Number(freshWallet?.tl_a||0)+Number(freshWallet?.tl_b||0); return c.json({ok:true,consumed:seconds,revenue_credited:revenue,user_tl:Number(fresh?.tl_balance||0),tl_balance:Number(fresh?.tl_balance||0),total_charged:Number(fresh?.total_charged||0),wallet_tl:walletNow,tl_p:Number(freshWallet?.tl_p||0)});
  }catch(e:any){
    return c.json({ok:false,error:e?.message||'TL 소비 실패'},500);
  }
});

// ── 단일 share 조회 ──
app.get('/api/shares/:id', async (c) => {
  const id=c.req.param('id'),origin=new URL(c.req.url).origin;
  const row=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(id).first<any>();
  const viewerId=await playbackUserId(c);
  if(row){
    const isOwner=viewerId>0&&Number(row.user_id)===viewerId;
    const isPublic=await isPublicPlaybackShare(c.env.DB,row);
    if(!isOwner&&!isPublic)return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);
      // 2026-10-16: D1 content_kind/release_mode 우선 (v3 호환)
      const _ck = String(row.content_kind||'').toLowerCase();
      const _rm = String(row.release_mode||'').toLowerCase();
      const _ft = String(row.file_type||'').toLowerCase();
      const _kind = (_ck==='tl3' || _rm==='tl3' || _ft==='audio/tl3') ? 'tl3' : shareKind(row);
    return c.json({
      id:String(row.id),user_id:Number(row.user_id||0),username:String(row.username||'User'),
      title:String(row.title||''),artist:String(row.artist||''),album:String(row.album||''),
      duration:Number(row.duration||0),file_tl:Number(row.file_tl||0),category:String(row.category||'Music'),
      file_type:String(row.file_type||''),category_type:String(row.category_type||''),description:String(row.description||''),
      plan:String(row.plan||'FREE'),spotify_id:row.spotify_id||null,spotify_url:row.spotify_url||null,
      cover_url:row.cover_url||null,country:String(row.country||'KR'),content_lang:String(row.content_lang||'ko'),
      content_kind:_kind,
      release_mode:String(row.release_mode||''),
      stream_url:origin+'/api/stream/'+encodeURIComponent(String(row.id))
    });
  }
  const file=await c.env.DB.prepare('SELECT * FROM tl_files WHERE CAST(id AS TEXT)=?').bind(id).first<any>();
  if(!file)return c.json({error:'not found'},404);
  const isOwner=viewerId>0&&Number(file.user_id)===viewerId;
  const release=await c.env.DB.prepare("SELECT price_tl,share_id FROM tl3_releases WHERE file_id=? AND status='released'").bind(file.id).first<any>().catch(()=>null);
  // 2026-10-16: 승인 게이트 제거 (공유=공개)
  const isPublic = Number(file.shared) === 1;
  if(!isOwner&&!isPublic)return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);
  return c.json({
    id:String(file.id),file_id:Number(file.id),share_id:release?.share_id||null,user_id:Number(file.user_id||0),username:String(file.username||'User'),
    title:String(file.title||''),artist:String(file.artist||''),album:'',duration:Number(file.duration_seconds||0),
    file_tl:Number(file.file_tl||0),price_tl:Number(release?.price_tl||0),category:String(file.genre||'Music'),file_type:String(file.file_type||''),
    category_type:'audio',description:'',plan:'A',cover_url:file.cover_image||null,pulse:Number(file.pulse||0),
    play_count:Number(file.play_count||0),created_at:file.created_at,
    content_kind:release?'tl3':'mp3',
    stream_url:origin+'/api/legacy-stream/'+encodeURIComponent(String(file.id))
  });
});


// ══════════════════════════════════════════════════════════
// PATCH /api/shares/:id — 창작자 정보 편집 (곡명 불변)
// ══════════════════════════════════════════════════════════
app.patch('/api/shares/:id', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  let userId: number;
  try {
    const p = parseJWT(auth);
    userId = Number(p.userId ?? p.id ?? p.sub ?? 0);
    if (!userId) throw new Error('no userId');
  } catch {
    return c.json({ error: '토큰 오류' }, 401);
  }

  const shareId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id, user_id, title FROM tl_shares WHERE id=?'
  ).bind(shareId).first() as any;
  if (!existing) return c.json({ error: '파일 없음' }, 404);
  if (String(existing.user_id) !== String(userId)) return c.json({ error: '권한 없음' }, 403);

  const body = await c.req.json<any>().catch(() => ({}));

  // 새 컬럼 자동 생성
  const newCols = [
    "ALTER TABLE tl_shares ADD COLUMN creation_story TEXT DEFAULT ''",
    "ALTER TABLE tl_shares ADD COLUMN mood_tags TEXT DEFAULT '[]'",
    "ALTER TABLE tl_shares ADD COLUMN musical_key TEXT DEFAULT ''",
    "ALTER TABLE tl_shares ADD COLUMN credits TEXT DEFAULT ''",
    "ALTER TABLE tl_shares ADD COLUMN social_links TEXT DEFAULT '{}'",
    "ALTER TABLE tl_shares ADD COLUMN gallery_images TEXT DEFAULT '[]'",
    "ALTER TABLE tl_shares ADD COLUMN production_note TEXT DEFAULT ''",
    "ALTER TABLE tl_shares ADD COLUMN origin_hash TEXT DEFAULT ''",
  ];
  for (const sql of newCols) {
    await c.env.DB.prepare(sql).run().catch(() => {});
  }

  // 수정 가능 필드 (title 제외 — 불변)
  const allowed: Record<string, string> = {
    artist:'artist', album:'album', category:'category',
    description:'description', composer:'composer', lyricist:'lyricist',
    lyrics:'lyrics', cover_url:'cover_url', creation_story:'creation_story',
    production_note:'production_note', musical_key:'musical_key',
    credits:'credits', mood_tags:'mood_tags', social_links:'social_links',
    gallery_images:'gallery_images',
    release_mode:'release_mode', content_kind:'content_kind', stream_url:'stream_url', file_type:'file_type', file_tl:'file_tl', storage_mode:'storage_mode', origin_hash:'origin_hash',
  };

  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      updates.push(`${col}=?`);
      values.push(typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]);
    }
  }

  if (updates.length === 0) return c.json({ ok: true, message: '변경 없음' });

  values.push(shareId);
  await c.env.DB.prepare(
    `UPDATE tl_shares SET ${updates.join(',')} WHERE id=?`
  ).bind(...values).run();

  const updated = await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first();
  return c.json({ ok: true, share: updated });
});

app.delete('/api/shares/:id', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({error:'인증 필요'},401);
    
    const shareId = String(c.req.param('id') || '');
    const userId = Number(payload.sub);
    
    // 1) tl_shares에서 찾기 (기존 로직)
    let share = await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    
    // 2) tl_shares에 없으면 tl3_releases에서 찾기 (V4 자산)
    if (!share) {
      const release = await c.env.DB.prepare("SELECT * FROM tl3_releases WHERE share_id=? OR CAST(file_id AS TEXT)=?").bind(shareId, shareId).first<any>();
      if (release) {
        if (Number(release.user_id) !== userId) {
          return c.json({error:'권한 없음'},403);
        }
        // V4 자산 삭제 (tl3_releases, tl3_segments, tl3_release_tokens)
        await c.env.DB.prepare('DELETE FROM tl3_segments WHERE file_id=?').bind(release.file_id).run().catch(()=>{});
        await c.env.DB.prepare('DELETE FROM tl3_release_tokens WHERE file_id=?').bind(release.file_id).run().catch(()=>{});
        await c.env.DB.prepare('DELETE FROM tl3_releases WHERE file_id=?').bind(release.file_id).run();
        await c.env.DB.prepare('DELETE FROM tl_files WHERE id=?').bind(release.file_id).run().catch(()=>{});
        return c.json({ok:true, deleted:'tl3_release', file_id:release.file_id});
      }
      return c.json({error:'파일 없음'},404);
    }
    
    // 3) tl_shares가 있으면 기존 로직 (소유권 확인)
    if (Number(share.user_id) !== userId) {
      return c.json({error:'권한 없음'},403);
    }
    
    // 기존 삭제 로직 (tl_shares + 관련 자산)
    await c.env.DB.prepare('DELETE FROM tl_shares WHERE id=?').bind(shareId).run();
    return c.json({ok:true, deleted:'share', id:shareId});
  } catch(e:any) {
    return c.json({error:e.message||'삭제 실패'},500);
  }
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
    const nameExists = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first();
    if (nameExists) return c.json({ error: '이미 사용 중인 닉네임(상호명)입니다' }, 409);
    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    const hashedPw = await hashPassword(password);
    await c.env.DB.prepare(
      'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at, is_advertiser, biz_reg_num, business_name) VALUES (?,?,?,?,?,0,?,?,?,?)'
    ).bind(email, username, hashedPw, isAdvertiser?300000:42500, isAdvertiser?300000:42500, now, isAdvertiser?1:0, bizRegNum||'', businessName||username).run();
    const user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    const token = await makeAccessToken(Number((user as any).id), c.env.JWT_SECRET);
    return c.json({ ok: true, token, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});


// 이메일 인증 코드 발송
app.post('/api/auth/send-code', async (c) => {
  try {
    const { email, username } = await c.req.json() as any;
    if (!email) return c.json({ error: 'email 필요' }, 400);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL, code TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(()=>{});
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE email=?').bind(email).run();
    await c.env.DB.prepare(
      'INSERT INTO email_verifications (email, code, expires_at) VALUES (?,?,?)'
    ).bind(email, code, expiresAt).run();
    await sendVerificationEmail(c.env, email, username||'', code);
    return c.json({ ok: true, message: '인증 코드를 발송했습니다' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 이메일 인증 코드 확인
// ── 프론트 호환 alias ──
app.post('/api/auth/verify', async (c) => {
  try {
    const { email, code, password, username } = await c.req.json() as any;
    if (!email || !code) return c.json({ error: 'email/code 필요' }, 400);
    const row = await c.env.DB.prepare(
      'SELECT * FROM email_verifications WHERE email=? AND code=?'
    ).bind(email, code).first() as any;
    if (!row) return c.json({ error: '인증 코드가 올바르지 않습니다' }, 400);
    if (new Date(row.expires_at) < new Date()) return c.json({ error: '인증 코드가 만료되었습니다' }, 400);
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE email=?').bind(email).run();
    // 사용자 생성 (아직 없으면)
    let user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    if (!user) {
      const now = new Date().toISOString().replace('T',' ').substring(0,19);
      await c.env.DB.prepare(
        'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at) VALUES (?,?,?,42500,42500,0,?)'
      ).bind(email, username||email, password||'', now).run();
      user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    }
    const token = await makeAccessToken(Number((user as any).id), c.env.JWT_SECRET);
    return c.json({ ok: true, token, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/auth/resend', async (c) => {
  try {
    const { email, username } = await c.req.json() as any;
    if (!email) return c.json({ error: 'email 필요' }, 400);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE email=?').bind(email).run();
    await c.env.DB.prepare(
      'INSERT INTO email_verifications (email, code, expires_at) VALUES (?,?,?)'
    ).bind(email, code, expiresAt).run();
    await sendVerificationEmail(c.env, email, username||'', code);
    return c.json({ ok: true, message: '인증 코드를 재발송했습니다' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});


app.post('/api/auth/verify-code', async (c) => {
  try {
    const { email, code } = await c.req.json() as any;
    if (!email || !code) return c.json({ error: 'email/code 필요' }, 400);
    const row = await c.env.DB.prepare(
      'SELECT * FROM email_verifications WHERE email=? AND code=?'
    ).bind(email, code).first() as any;
    if (!row) return c.json({ error: '인증 코드가 올바르지 않습니다' }, 400);
    if (new Date(row.expires_at) < new Date()) return c.json({ error: '인증 코드가 만료되었습니다' }, 400);
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE email=?').bind(email).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
// 로그인
app.post('/api/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) return c.json({ error: '이메일/비밀번호 필요' }, 400);
    const user = await c.env.DB.prepare(
      `SELECT id,email,username,password_hash,COALESCE(tl_balance,0) as tl,COALESCE(tl_p,0) as tl_p,COALESCE(tl_a,0) as tl_a,COALESCE(tl_b,0) as tl_b,COALESCE(tlc_balance,0) as tlc,COALESCE(is_advertiser,0) as is_advertiser,COALESCE(biz_reg_num,'') as biz_reg_num,COALESCE(business_name,'') as business_name FROM users WHERE email=?`
    ).bind(email.trim()).first<any>();
    if (!user) return c.json({ error: '이메일 또는 비밀번호가 틀렸습니다' }, 401);
    const storedPw = String(user.password_hash || '');
    const valid = storedPw.includes(':') ? await verifyPassword(password, storedPw) : (password === storedPw);
    if (!valid) return c.json({ error: '이메일 또는 비밀번호가 틀렸습니다' }, 401);
    const token = await makeAccessToken(Number(user.id), c.env.JWT_SECRET);
    return c.json({ ok: true, access_token: token, token, token_type: 'bearer', user_id: Number(user.id),
      user: { id:Number(user.id), email:user.email, username:user.username, tl:Number(user.tl||0), tl_p:Number(user.tl_p||0), tl_a:Number(user.tl_a||0), tl_b:Number(user.tl_b||0), tlc:Number(user.tlc||0), is_advertiser:Number(user.is_advertiser||0), biz_reg_num:user.biz_reg_num||'', business_name:user.business_name||'' } });
  } catch (e: any) {
    return c.json({ error: e.message || '로그인 처리 실패' }, 500);
  }
});

// ── 공지 조회 (공개, 인증 불필요) ──
app.get('/api/notice/active', async (c) => {
  try {
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(()=>{});
    
    const row = await c.env.DB.prepare(
      "SELECT value FROM tl_settings WHERE key='free_upload'"
    ).first<any>();
    
    if(!row || !row.value) return c.json({ active: false });
    
    let s: any = null;
    try { s = JSON.parse(row.value); } catch(e) { return c.json({ active: false }); }
    if(!s) return c.json({ active: false });
    
    // mode 체크 (on이 아니면 비활성)
    if(s.mode !== 'on') return c.json({ active: false });
    
    // until 체크
    if(s.until && new Date(s.until) < new Date()) return c.json({ active: false });
    
    return c.json({ 
      active: true, 
      message: s.message, 
      until: s.until, 
      style: s.style || 'default',
      mode: s.mode
    });
  } catch(e: any){
    return c.json({ active: false, error: String(e?.message || e) });
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

// 회원가입 (signup) - 이메일 인증 코드 발송
app.post('/api/auth/signup', async (c) => {
  try {
    const { email, password, username, business_name: businessName, biz_reg_num: bizRegNum, is_advertiser: isAdvertiser, verify_code: verifyCode } = await c.req.json();
    if (!email || !username) return c.json({ error: '필수 항목 누락' }, 400);
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (exists) return c.json({ error: '이미 가입된 이메일입니다. 로그인을 이용해 주세요.' }, 409);
    const nameExists = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first();
    if (nameExists) return c.json({ error: '이미 사용 중인 닉네임입니다.' }, 409);

    // 인증 코드 검증
    if (verifyCode) {
      await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL, code TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
      )`).run().catch(()=>{});
      const row = await c.env.DB.prepare(
        'SELECT * FROM email_verifications WHERE email=? AND code=?'
      ).bind(email, verifyCode).first() as any;
      if (!row) return c.json({ error: '인증 코드가 올바르지 않습니다' }, 400);
      if (new Date(row.expires_at) < new Date()) return c.json({ error: '인증 코드가 만료되었습니다' }, 400);
      await c.env.DB.prepare('DELETE FROM email_verifications WHERE email=?').bind(email).run();
      const now = new Date().toISOString().replace('T',' ').substring(0,19);
      const hashedPw2 = await hashPassword(password||'');
      await c.env.DB.prepare(
        'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at, is_advertiser, biz_reg_num, business_name) VALUES (?,?,?,?,?,0,?,?,?,?)'
      ).bind(email, username, hashedPw2, isAdvertiser?300000:42500, isAdvertiser?300000:42500, now, isAdvertiser?1:0, bizRegNum||'', businessName||username).run();
      const user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
      const token = await makeAccessToken(Number((user as any).id), c.env.JWT_SECRET);
      return c.json({ ok: true, token, user });
    }

    // 인증 코드 발송
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL, code TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    )`).run().catch(()=>{});
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE email=?').bind(email).run();
    await c.env.DB.prepare(
      'INSERT INTO email_verifications (email, code, expires_at) VALUES (?,?,?)'
    ).bind(email, code, expiresAt).run();
    await sendVerificationEmail(c.env, email, username, code);
    return c.json({ ok: true, step: 'verify', message: '인증 코드를 이메일로 발송했습니다' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 오디오 프록시
app.get('/api/legacy-stream/:fileId',async(c)=>{
  try{
    const fileId=c.req.param('fileId');
    const file=await c.env.DB.prepare(
      'SELECT f.*,u.username FROM tl_files f LEFT JOIN users u ON u.id=f.user_id WHERE CAST(f.id AS TEXT)=?'
    ).bind(fileId).first<any>();
    if(!file)return c.json({error:'파일 없음'},404);
    const viewerId=await playbackUserId(c);
    const isOwner=viewerId>0&&Number(file.user_id)===viewerId;
    const isPublic = Number(file.shared) === 1;
    if(!isOwner&&!isPublic)return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);
    if(!isOwner&&Number(file.file_tl||0)>0){
      if(!viewerId)return c.json({error:'TL3 재생은 로그인이 필요합니다.'},401);
      if(!await hasPlaybackBalance(c.env.DB,viewerId))return c.json({error:'재생에 필요한 TL 잔액이 없습니다.'},402);
    }

    const source=String(file.stream_url||file.file_url||'').trim();
    if(!source)return c.json({error:'원본 저장 위치가 없습니다.'},404);
    if(/127\.0\.0\.1|localhost/i.test(source))return c.json({error:'창작자 PC의 Local Agent에서 재생해야 하는 자산입니다.'},409);
    let key='';
    if(source.startsWith('tracks/')||source.startsWith('tl/'))key=source;
    else if(source.includes('/api/storage/'))key=decodeURIComponent(source.split('/api/storage/')[1].split('?')[0]);
    else if(source.includes('/api/audio/')){
      const parsed=new URL(source,c.req.url);
      const filename=parsed.pathname.split('/').pop()||'';
      if(!/^[A-Za-z0-9._-]{1,180}$/.test(filename))return c.json({error:'잘못된 저장 파일 경로'},400);
      key='tracks/'+filename;
    }
    const cors:Record<string,string>={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range, Content-Type, Authorization','Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length','Accept-Ranges':'bytes','Cache-Control':'private, no-store'};
    const range=c.req.header('Range')||'';
    if(key){
      const scoped=key.match(/^(?:tracks|tl)\/u(\d+)\//);
      if(scoped&&Number(scoped[1])!==Number(file.user_id))return c.json({error:'파일 소유권 연결이 올바르지 않습니다.'},403);
      const meta=await getD1ObjectMeta(c.env.DB,key);
      if(!meta)return c.json({error:'저장된 원본을 찾을 수 없습니다.'},404);
      let start=0,end=meta.size-1,status=200;
      if(range){
        const match=range.match(/bytes=(\d+)-(\d*)/);
        if(!match)return new Response('Invalid Range',{status:416,headers:cors});
        start=Number(match[1]);end=match[2]!==''?Math.min(Number(match[2]),meta.size-1):Math.min(start+D1_CHUNK_SIZE-1,meta.size-1);status=206;
      }
      if(start<0||start>=meta.size||end<start)return new Response('Range Not Satisfiable',{status:416,headers:cors});
      const bytes=await readD1Range(c.env.DB,key,start,end-start+1);
      const headers:Record<string,string>={...cors,'Content-Type':meta.content_type||file.file_type||'application/octet-stream','Content-Length':String(bytes.byteLength)};
      if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${meta.size}`;
      return new Response(bytes,{status,headers});
    }
    if(!/^https?:\/\//i.test(source))return c.json({error:'지원하지 않는 저장 위치입니다.'},400);
    const upstreamHeaders:Record<string,string>={};if(range)upstreamHeaders.Range=range;
    const upstream=await fetch(source,{headers:upstreamHeaders});
    const headers=new Headers(cors);
    for(const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges']){
      const value=upstream.headers.get(name);if(value)headers.set(name,value);
    }
    return new Response(upstream.body,{status:upstream.status,headers});
  }catch(e:any){return c.json({error:e?.message||'재생 스트림 처리 실패'},500);}
});
app.options('/api/audio/:filename', (c) => new Response(null, { headers: {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
}}));

app.get('/api/audio/:filename',async(c)=>{
  try{
    await ensureD1Storage(c.env.DB);
    const filename=c.req.param('filename');
    if(!/^[A-Za-z0-9._-]{1,180}$/.test(filename)) return c.json({error:'잘못된 파일명'},400);
    const key=`tracks/${filename}`;
    const meta=await getD1ObjectMeta(c.env.DB,key);
    if(!meta) return c.json({error:'Not found'},404);
    const viewerId=await playbackUserId(c);
    const canonical=`https://api.timelink.digital/api/audio/${encodeURIComponent(filename)}`;
    const shares=await c.env.DB.prepare(
      'SELECT * FROM tl_shares WHERE stream_url IN (?,?,?) OR stream_url LIKE ?'
    ).bind(canonical,key,'/api/audio/'+filename,'%'+filename).all<any>().catch(()=>({results:[]}));
    let isPublic=false;
    const owners=new Set<number>();
    for(const share of (shares.results||[])){
      const uid=Number(share.user_id||0);if(uid>0)owners.add(uid);
      if(await isPublicPlaybackShare(c.env.DB,share))isPublic=true;
    }
    const files=await c.env.DB.prepare(
      "SELECT f.user_id FROM tl_files f WHERE (f.stream_url IN (?,?) OR f.file_url IN (?,?)) AND LOWER(f.file_type)='audio/tl3' AND f.shared=1 AND COALESCE(f.revenue_held,0)=0 AND EXISTS (SELECT 1 FROM tl3_releases r WHERE r.file_id=f.id AND r.status='released' AND r.rights_confirmed=1)"
    ).bind(canonical,key,canonical,key).all<any>().catch(()=>({results:[]}));
    for(const file of (files.results||[])){owners.add(Number(file.user_id));isPublic=true;}
    const isOwner=viewerId>0&&owners.has(viewerId);
    if(!isOwner&&!isPublic)return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);
    const cors:Record<string,string>={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range, Content-Type, Authorization','Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length','Accept-Ranges':'bytes','Cache-Control':isPublic?'public, max-age=300':'private, no-store'};
    const range=c.req.header('Range')||'';
    let start=0,end=meta.size-1,status=200;
    if(range){
      const match=range.match(/bytes=(\d+)-(\d*)/);
      if(!match)return new Response('Invalid Range',{status:416,headers:cors});
      start=Number(match[1]);end=match[2]!==''?Math.min(Number(match[2]),meta.size-1):Math.min(start+D1_CHUNK_SIZE-1,meta.size-1);status=206;
    }
    if(start<0||start>=meta.size||end<start)return new Response('Range Not Satisfiable',{status:416,headers:cors});
    const bytes=await readD1Range(c.env.DB,key,start,end-start+1);
    const headers:Record<string,string>={...cors,'Content-Type':meta.content_type||'audio/mpeg','Content-Length':String(bytes.byteLength)};
    if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${meta.size}`;
    return new Response(bytes,{status,headers});
  }catch(e:any){return c.json({error:e?.message||'오디오 읽기 실패'},500);}
});
app.options('/api/audio/:filename',(c)=>new Response(null,{status:204}));
var API_STREAM_BASE = 'https://api.timelink.digital/api/stream/';

app.get('/api/stream/:shareId/info', async (c) => {
  const shareId=c.req.param('shareId');
  try {
    const share=await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);
    const userId=await playbackUserId(c);
    const isOwner=userId>0&&Number(share.user_id)===userId;
    const isPublic=await isPublicPlaybackShare(c.env.DB,share);
    if(!isOwner&&!isPublic) return c.json({error:'공개 승인되지 않았거나 접근 권한이 없습니다.'},403);
    const user=userId?await c.env.DB.prepare(
      'SELECT COALESCE(tl_p,tl,0) as tl_p,COALESCE(tl_a,0) as tl_a,COALESCE(tl_b,0) as tl_b FROM users WHERE id=?'
    ).bind(userId).first<any>():null;
    const totalTL=Number(user?.tl_p||0)+Number(user?.tl_a||0)+Number(user?.tl_b||0);
    const canPlay=isOwner||shareKind(share)==='mp3'||totalTL>0;
    return c.json({
      share:{id:share.id,title:share.title,artist:share.artist,duration:share.duration},
      tl:{total:totalTL,tl_p:user?.tl_p||0,tl_a:user?.tl_a||0,tl_b:user?.tl_b||0},
      can_play:canPlay
    });
  }catch(e:any){return c.json({error:e.message||'재생 정보 조회 실패'},500);}
});

app.options('/api/stream/:shareId', async (c) => new Response(null, {
  status: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
  },
}));

app.get('/api/stream/:shareId',async(c)=>{
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim() || c.req.query('tk') || '';
  const userId=await playbackUserId(c);
  const shareId = c.req.param('shareId');
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, X-TL-Balance',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store'
  };

  try {
    await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN storage_object_id INTEGER").run().catch(() => {});
    await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN storage_provider TEXT DEFAULT ''").run().catch(() => {});
    const share = await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id = ?').bind(shareId).first<any>();
    if (!share) return new Response(JSON.stringify({ error: '파일 없음' }), { status: 404, headers: cors });

    const ownerId = Number(share.user_id || 0);
    const isOwner = userId > 0 && userId === ownerId;
    const isPublic = await isPublicPlaybackShare(c.env.DB, share);
    if(!isOwner&&!isPublic){
      return new Response(JSON.stringify({ error: '공개 승인되지 않았거나 접근 권한이 없습니다.' }), { status: 403, headers: cors });
    }
    if(!isOwner&&shareKind(share)==='tl3'){
      if (!userId) return new Response(JSON.stringify({ error: 'TL3 재생은 로그인이 필요합니다.' }), { status: 401, headers: cors });
      if (!await hasPlaybackBalance(c.env.DB, userId)) {
        return new Response(JSON.stringify({ error: '재생에 필요한 TL 잔액이 없습니다.' }), { status: 402, headers: cors });
      }
    }

    const source = String(share.stream_url || '');
    if (/^https?:\/\//i.test(source) && !source.includes('/api/storage/')) {
      const headers: Record<string, string> = {};
      const range = c.req.header('Range') || '';
      if (range) headers.Range = range;
      let isAgentHost = false;
      try { isAgentHost = new URL(source).hostname.toLowerCase() === 'agent.timelink.digital'; } catch {}
      if (isAgentHost && c.env.CF_ACCESS_CLIENT_ID && c.env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = c.env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = c.env.CF_ACCESS_CLIENT_SECRET;
      }
      const upstream = await fetch(source, { headers });
      const contentType = upstream.headers.get('Content-Type') || '';
      if (upstream.status === 302 || upstream.status === 401 || upstream.status === 403 || /text\/html/i.test(contentType)) {
        return new Response(JSON.stringify({ error: '원본 파일 접근 인증 실패 (Cloudflare Access 확인 필요)' }), {
          status: 502, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const responseHeaders = new Headers(cors);
      for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    if (share.storage_object_id) {
      const object = await c.env.DB.prepare(
        "SELECT id, user_id FROM storage_objects WHERE id = ? AND status = 'active'"
      ).bind(Number(share.storage_object_id)).first<any>();
      if(!object||Number(object.user_id)!==ownerId){
        return new Response(JSON.stringify({ error: '저장소 소유권 연결이 올바르지 않습니다.' }), { status: 403, headers: cors });
      }
      const upstream = await externalStream(c.env.DB, c.env, Number(share.storage_object_id), c.req.header('Range') || '');
      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges,Content-Length');
      headers.set('Cache-Control', 'private, no-store');
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    let key = '';
    if (source.includes('/api/storage/')) key = decodeURIComponent(source.split('/api/storage/')[1].split('?')[0]);
    else if (source.startsWith('tracks/') || source.startsWith('tl/')) key = source;
    else if (/^https?:\/\//i.test(source)) {
      const filename = source.split('/').pop()?.split('?')[0] || '';
      key = filename.endsWith('.tl') ? 'tl/' + filename : 'tracks/' + filename;
    } else key = source;
    if (!key) return new Response(JSON.stringify({ error: '스트림 없음' }), { status: 404, headers: cors });

    const scoped = key.match(/^(?:tracks|tl)\/u(\d+)\//);
    if(scoped&&Number(scoped[1])!==ownerId){
      return new Response(JSON.stringify({ error: '저장소 소유권 연결이 올바르지 않습니다.' }), { status: 403, headers: cors });
    }
    const meta = await getD1ObjectMeta(c.env.DB, key);
    if (!meta) return new Response(JSON.stringify({ error: 'D1 파일 없음' }), { status: 404, headers: cors });
    const range = c.req.header('Range') || '';
    let start = 0;
    let end = meta.size - 1;
    let status = 200;
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) return new Response('Invalid Range', { status: 416, headers: cors });
      start = Number(match[1]);
      end = match[2] !== '' ? Math.min(Number(match[2]), meta.size - 1) : Math.min(start + D1_CHUNK_SIZE - 1, meta.size - 1);
      status = 206;
    }
    if (start < 0 || start >= meta.size || end < start) {
      return new Response('Range Not Satisfiable', { status: 416, headers: cors });
    }
    const bytes = await readD1Range(c.env.DB, key, start, end - start + 1);
    const responseHeaders: Record<string, string> = {
      ...cors,
      'Content-Type': meta.content_type || 'audio/mpeg',
      'Content-Length': String(bytes.byteLength)
    };
    if (status === 206) responseHeaders['Content-Range'] = 'bytes ' + start + '-' + end + '/' + meta.size;
    return new Response(bytes, { status, headers: responseHeaders });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || '스트림 처리 실패' }), { status: 500, headers: cors });
  }
});

// TL 차감 tick
app.post('/api/stream/:shareId/tick', async (c) => {
  const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const userId = parseTokenUserId(token);
  const shareId = c.req.param('shareId');
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  try {
    const _sh = await c.env.DB.prepare('SELECT * FROM tl_shares WHERE id=?').bind(shareId).first() as any;
    if (_sh && shareKind(_sh)==='mp3') return c.json({ ok:true, free:true, consumed:0, can_play:true });
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
    h = (Math.imul(h, 0x01000193)) >>>0;
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

app.post('/api/upload/tl',async(c)=>{const session=await storageUser(c),uid=Number(session?.sub||0),secret=c.env.TL_SECRET||'';if(!Number.isSafeInteger(uid)||uid<=0)return c.json({ok:false,error:'인증 필요'},401);if(!secret)return c.json({ok:false,error:'TL_SECRET 설정이 필요합니다.'},503);try{await ensureD1Storage(c.env.DB);const f=await c.req.parseBody(),file=f['file'] as File,shareId=String(f['shareId']||('s_'+Date.now())),meta=JSON.parse((f['meta'] as string)||'{}');if(!file||file.size<=0)return c.json({ok:false,error:'유효한 파일이 필요합니다.'},400);if(file.size>D1_MAX_FILE_SIZE)return c.json({ok:false,error:'100MB 초과'},413);if(!/^[A-Za-z0-9_-]{1,100}$/.test(shareId))return c.json({ok:false,error:'유효하지 않은 shareId'},400);const raw=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(raw),ext=(file.name.split('.').pop()||'bin').toLowerCase(),tlPerSec=Number(meta.tl_per_sec||1),duration=Number(meta.duration||0),fileTL=Math.ceil(duration*tlPerSec)||3600,xorKey=shareId+secret+'TIMELINK_v1',header={shareId,creatorId:uid,creatorName:String(meta.creatorName||''),title:String(meta.title||file.name.replace(/\\.[^.]+$/, '')),artist:String(meta.artist||''),fileType:file.type||'application/octet-stream',ext,duration,tl_per_sec:tlPerSec,plan:String(meta.plan||'A'),tl_balance:fileTL,tl_max:fileTL,xorKey,uploadedAt:new Date().toISOString(),contentHash:hash,platform:'timelink.digital',version:1},tlData=buildTLFile(header,raw,secret),key=`tl/u${uid}/${shareId}.tl`;await putD1Object(c.env.DB,key,tlData,'application/octet-stream',`${shareId}.tl`);return c.json({ok:true,key,shareId,size:tlData.length,hash,storage_mode:'d1',url:`https://api.timelink.digital/api/storage/${encodeURIComponent(key)}`});}catch(e:any){return c.json({ok:false,error:e.message},500);}});
app.get('/api/download/:shareId', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  const userId=parseTokenUserId(token);
  const shareId=c.req.param('shareId');
  if(!userId) return c.json({error:'인증 필요'},401);
  try{
    const share=await c.env.DB.prepare(
      'SELECT * FROM tl_shares WHERE id=?'
    ).bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);

    const fileType=String(share.file_type||'').toLowerCase();
    if(shareKind(share)==='mp3') return c.json({error:'MP3는 무료 재생 전용이며 TL3 다운로드 대상이 아닙니다.'},400);

    const safeTitle=String(share.title||'file').replace(/[<>:"\/\\|?*]/g,'_');
    const downloadName=safeTitle+(fileType==='audio/tl3'?'.tl3':fileType.startsWith('video/')?'.tl4':fileType.startsWith('image/')?'.tlg':'.tlf');

    if(share.storage_object_id){
      const r=await externalStream(c.env.DB,c.env,Number(share.storage_object_id),'');
      if(!r.ok) return c.json({error:'외부 저장소 파일을 가져오지 못했습니다.'},502);
      const h=new Headers(r.headers);
      h.set('Content-Disposition',`attachment; filename="${downloadName}"`);
      h.set('Content-Type','application/octet-stream');
      h.set('Cache-Control','no-store');
      return new Response(r.body,{status:200,headers:h});
    }

    const streamUrl=String(share.stream_url||'');
    if(/127\.0\.0\.1|localhost/i.test(streamUrl)){
      return c.json({error:'이 파일은 창작자 PC에 저장되어 있습니다. 창작자 PC의 Local Agent에서 다운로드하세요.'},409);
    }

    let rawKey='';
    if(streamUrl.includes('/api/storage/')) rawKey=decodeURIComponent(streamUrl.split('/api/storage/')[1].split('?')[0]);
    else if(streamUrl.startsWith('tracks/')||streamUrl.startsWith('tl/')) rawKey=streamUrl;
    else if(streamUrl.startsWith('http')){
      const fn=streamUrl.split('/').pop()?.split('?')[0]||'';
      rawKey=fn.endsWith('.tl3')?'tl3/'+fn:fn.endsWith('.tl')?'tl/'+fn:'tracks/'+fn;
    }else rawKey=streamUrl;
    if(!rawKey) return c.json({error:'다운로드 파일 경로가 없습니다.'},404);

    const meta=await getD1ObjectMeta(c.env.DB,rawKey);
    if(!meta) return c.json({error:'원본 파일 없음'},404);
    const bytes=await readD1Range(c.env.DB,rawKey,0,meta.size);
    return new Response(bytes,{
      status:200,
      headers:{
        'Content-Type':meta.content_type||'application/octet-stream',
        'Content-Length':String(bytes.byteLength),
        'Content-Disposition':`attachment; filename="${downloadName}"`,
        'Cache-Control':'no-store',
        'Access-Control-Allow-Origin':'*',
        'Access-Control-Expose-Headers':'Content-Disposition, Content-Length'
      }
    });
  }catch(e:any){
    return c.json({error:e?.message||'다운로드 실패'},500);
  }
});

export default app;