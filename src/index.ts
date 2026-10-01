import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { verifyToken, makeAccessToken } from './auth';

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
import { sendVerificationEmail, sendPayoutEmail } from './email';
import { ensureD1Storage, initD1Upload, writeD1UploadPart, completeD1Upload, putD1Object, getD1ObjectMeta, readD1Range, D1_OBJECT_CHUNK_SIZE, D1_MAX_OBJECT_SIZE } from './d1-storage';
import sunoVerifyRouter from './routes/suno-verify';
import { ensureStorageTables, beginStorageConnect, finishStorageConnect, createUploadSession, finalizeUpload, registerObject, externalStream, disconnectStorage } from './storage';


const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.options('*', (c) => c.text('', 204));

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
  try { return c.json({ok:true,upload:await createUploadSession(c.env.DB,c.env,Number(u.sub),provider,name,size,mime)}); }
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
    await ensureStorageTables(c.env.DB);
    const linked=await c.env.DB.prepare('SELECT id FROM tl_shares WHERE storage_object_id=? LIMIT 1').bind(objectId).first();
    if(!linked){
      const u=await storageUser(c);
      const own= u ? await c.env.DB.prepare('SELECT id FROM storage_objects WHERE id=? AND user_id=?').bind(objectId,Number(u.sub)).first() : null;
      if(!own) return c.json({error:'접근 권한 없음'},403);
    }
    const r=await externalStream(c.env.DB,c.env,objectId,c.req.header('Range')||'');
    const h=new Headers(r.headers);h.set('Access-Control-Allow-Origin','*');h.set('Access-Control-Expose-Headers','Content-Range,Accept-Ranges,Content-Length');
    return new Response(r.body,{status:r.status,headers:h});
  } catch(e:any){return c.json({error:e.message},404);}
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

// ── 인증된 TL3 컨테이너 저장 ──
// 브라우저에서 생성한 TLNK v2 컨테이너를 D1 Object Storage에 저장한다.
// share 생성 전용 단계이며 파일명/경로는 서버가 결정한다.
app.post('/api/upload/tl3', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\\s+/i,'').trim();
  const user=token ? await verifyToken(token,c.env.JWT_SECRET).catch(()=>null) : null;
  const userId=Number(user?.sub||0);
  if(!userId) return c.json({ok:false,error:'인증 필요'},401);
  try{
    await ensureD1Storage(c.env.DB);
    const form=await c.req.parseBody({limit:D1_MAX_FILE_SIZE});
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
    const key='tracks/'+shareId+'.tl3';
    await putD1Object(c.env.DB,key,raw,'application/octet-stream',shareId+'.tl3');
    return c.json({ok:true,shareId,key,stream_url:'https://api.timelink.digital/api/storage/'+encodeURIComponent(key),size:raw.length,storage_mode:'timelink_d1',release_mode:'tl3'});
  }catch(e:any){ return c.json({ok:false,error:e?.message||'TL3 저장 실패'},500); }
});

// ── TL3 / 파일 업로드 — R2 없는 D1 Object Storage
const D1_CHUNK_SIZE=D1_OBJECT_CHUNK_SIZE,D1_MAX_FILE_SIZE=D1_MAX_OBJECT_SIZE;
app.post('/api/upload/init',async(c)=>{try{await ensureD1Storage(c.env.DB);const b=await c.req.json<any>(),id=String(b.trackId||'').trim(),name=String(b.fileName||`${id}.tl3`),size=Number(b.totalSize||0);if(!id)return c.json({ok:false,error:'trackId 필수'},400);if(size>D1_MAX_FILE_SIZE)return c.json({ok:false,error:'무료 저장소는 파일당 100MB까지 지원합니다.'},413);const key=`tracks/${id}.tl3`;await initD1Upload(c.env.DB,key,name,size,'application/octet-stream');return c.json({ok:true,key,uploadId:id,chunkSize:D1_CHUNK_SIZE,storage_mode:'d1'});}catch(e:any){return c.json({ok:false,error:e?.message||'TL3 업로드 초기화 실패'},500);}});
app.put('/api/upload/part',async(c)=>{try{await ensureD1Storage(c.env.DB);const key=String(c.req.query('key')||''),pn=Number(c.req.query('partNumber')||0);if(!key||!Number.isInteger(pn)||pn<1)return c.json({ok:false,error:'key, partNumber 필수'},400);const data=await c.req.arrayBuffer();if(!data.byteLength)return c.json({ok:false,error:'빈 청크'},400);if(data.byteLength>D1_CHUNK_SIZE)return c.json({ok:false,error:'청크가 너무 큽니다.',max_chunk_size:D1_CHUNK_SIZE},413);await writeD1UploadPart(c.env.DB,key,pn,new Uint8Array(data));return c.json({ok:true,partNumber:pn,etag:`d1-${pn}-${data.byteLength}`,storage_mode:'d1'});}catch(e:any){return c.json({ok:false,error:e?.message||'TL3 청크 업로드 실패'},500);}});
app.post('/api/upload/complete',async(c)=>{try{await ensureD1Storage(c.env.DB);const b=await c.req.json<any>(),key=String(b.key||'');if(!key)return c.json({ok:false,error:'key 필수'},400);const meta=await completeD1Upload(c.env.DB,key),url=`https://api.timelink.digital/api/storage/${encodeURIComponent(key)}`;return c.json({ok:true,url,stream_url:url,key,trackId:key.split('/').pop()?.replace(/\\.tl3$/,''),file_type:'audio/tl3',release_mode:'tl3',size:meta.size,storage_mode:'d1'});}catch(e:any){return c.json({ok:false,error:e?.message||'TL3 업로드 완료 실패'},500);}});
app.get('/api/storage/:key{.+}',async(c)=>{try{await ensureD1Storage(c.env.DB);const key=decodeURIComponent(c.req.param('key')),meta=await getD1ObjectMeta(c.env.DB,key);if(!meta)return c.json({error:'파일 없음'},404);const cors:any={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range, Content-Type, Authorization','Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'};const rh=c.req.header('Range')||'';let start=0,end=meta.size-1,status=200;if(rh){const m=rh.match(/bytes=(\\d+)-(\\d*)/);if(!m)return new Response('Invalid Range',{status:416,headers:cors});start=Number(m[1]);end=m[2]!==''?Math.min(Number(m[2]),meta.size-1):Math.min(start+D1_CHUNK_SIZE-1,meta.size-1);status=206;}if(start<0||start>=meta.size||end<start)return new Response('Range Not Satisfiable',{status:416,headers:cors});const bytes=await readD1Range(c.env.DB,key,start,end-start+1);const h:any={...cors,'Content-Type':meta.content_type||'application/octet-stream','Content-Length':String(bytes.byteLength)};if(status===206)h['Content-Range']=`bytes ${start}-${end}/${meta.size}`;return new Response(bytes,{status,headers:h});}catch(e:any){return c.json({error:e?.message||'파일 읽기 실패'},500);}});
app.options('/api/storage/:key{.+}',()=>new Response(null,{status:204}));
app.post('/api/upload',async(c)=>{try{await ensureD1Storage(c.env.DB);const f=await c.req.parseBody({limit:D1_MAX_FILE_SIZE}),file=f['file'] as File,id=String(f['trackId']||'').trim(),mode=String(f['release_mode']||'').trim().toLowerCase(),isTl3=String(f['isTl3']||'').toLowerCase()==='true';if(!file||!id)return c.json({ok:false,error:'file, trackId 필수'},400);if(file.size>D1_MAX_FILE_SIZE)return c.json({ok:false,error:'무료 저장소는 파일당 100MB까지 지원합니다.'},413);if(isTl3){if(file.size<7)return c.json({ok:false,error:'잘못된 TL3 파일입니다.'},400);const h=new Uint8Array(await file.slice(0,7).arrayBuffer());if(h[0]!==0x54||h[1]!==0x4c||h[2]!==0x4e||h[3]!==0x4b||h[4]!==0x02)return c.json({ok:false,error:'TL3 v2 헤더가 아닙니다.'},400);}const ext=isTl3?'tl3':(mode==='free_mp3'?'mp3':(file.name.split('.').pop()||'bin').toLowerCase()),key=`tracks/${id}.${ext}`,ct=isTl3?'application/octet-stream':(mode==='free_mp3'?'audio/mpeg':(file.type||'application/octet-stream'));await putD1Object(c.env.DB,key,new Uint8Array(await file.arrayBuffer()),ct,file.name||key);const url=`https://api.timelink.digital/api/storage/${encodeURIComponent(key)}`;return c.json({ok:true,url,stream_url:url,key,trackId:id,file_type:isTl3?'audio/tl3':ct,release_mode:isTl3?'tl3':(mode||'original'),size:file.size,storage_mode:'d1'});}catch(e:any){return c.json({ok:false,error:e?.message||'D1 파일 저장 실패'},500);}});
// ── TL3 시간 세그먼트: MP3 프레임 경계 기반 ─────────────────────────
const TL3_XOR_KEY = 'TIMELINK_XOR_KEY_2026_SECURE';

function tl3Xor(data: Uint8Array): Uint8Array {
  const key = new TextEncoder().encode(TL3_XOR_KEY);
  const out = new Uint8Array(data.length);
  for (let i=0;i<data.length;i++) out[i] = data[i] ^ key[i % key.length];
  return out;
}

function parseMp3Segments(data: Uint8Array, targetMs=5000): Array<{offset:number,length:number,durationMs:number}> {
  const bitrateV1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const bitrateV2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const sampleBase = [44100,48000,32000,0];
  const frames: Array<{offset:number,length:number,durationMs:number}> = [];
  let p = 0;
  if (data.length >= 10 && data[0]===0x49 && data[1]===0x44 && data[2]===0x33) {
    const sz = ((data[6]&0x7f)<<21)|((data[7]&0x7f)<<14)|((data[8]&0x7f)<<7)|(data[9]&0x7f);
    p = 10 + sz + ((data[5]&0x10) ? 10 : 0);
  }
  while (p + 4 <= data.length) {
    if (data[p]!==0xff || (data[p+1]&0xe0)!==0xe0) { p++; continue; }
    const version = (data[p+1]>>3)&3;
    const layer = (data[p+1]>>1)&3;
    const bi = (data[p+2]>>4)&15;
    const si = (data[p+2]>>2)&3;
    const padding = (data[p+2]>>1)&1;
    if (layer!==1 || version===1 || bi===0 || bi===15 || si===3) { p++; continue; }
    const sr0 = sampleBase[si];
    const sampleRate = version===3 ? sr0 : Math.floor(sr0/(version===2?2:4));
    const kbps = version===3 ? bitrateV1[bi] : bitrateV2[bi];
    const frameLength = Math.floor((version===3 ? 144000 : 72000) * kbps / sampleRate) + padding;
    if (frameLength < 24 || p + frameLength > data.length) { p++; continue; }
    const samples = version===3 ? 1152 : 576;
    frames.push({offset:p,length:frameLength,durationMs:(samples*1000)/sampleRate});
    p += frameLength;
  }
  if (!frames.length) throw new Error('지원되는 MP3 프레임을 찾지 못했습니다.');
  const out:Array<{offset:number,length:number,durationMs:number}> = [];
  let start = frames[0].offset, length = 0, durationMs = 0;
  for (const fr of frames) {
    if (durationMs > 0 && durationMs + fr.durationMs > targetMs) {
      out.push({offset:start,length,durationMs:Math.round(durationMs)});
      start = fr.offset; length = 0; durationMs = 0;
    }
    length += fr.length; durationMs += fr.durationMs;
  }
  if (length > 0) out.push({offset:start,length,durationMs:Math.round(durationMs)});
  return out;
}

function buildTL3V2(meta: Record<string,any>, raw: Uint8Array): {data:Uint8Array,payloadOffset:number} {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  if (metaBytes.length > 65535) throw new Error('TL3 메타데이터가 너무 큽니다.');
  const enc = tl3Xor(raw);
  const out = new Uint8Array(7 + metaBytes.length + enc.length);
  out.set([0x54,0x4c,0x4e,0x4b,0x02,(metaBytes.length>>8)&255,metaBytes.length&255],0);
  out.set(metaBytes,7);
  out.set(enc,7+metaBytes.length);
  return {data:out,payloadOffset:7+metaBytes.length};
}

// TL3 정식 출시: 크리에이터가 가격을 직접 설정한다.
app.post('/api/v1/tl3/releases', async (c) => {
  try {
    const body = await c.req.json<any>();
    const fileId = Number(body.file_id || 0);
    const price = Math.max(0, Math.floor(Number(body.price_tl || 0)));
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
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_segments (
      file_id INTEGER NOT NULL, segment_index INTEGER NOT NULL, offset INTEGER NOT NULL,
      length INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      PRIMARY KEY(file_id, segment_index)
    )`).run();

    const upstream = await fetch(source.toString());
    if (!upstream.ok) return c.json({ok:false,error:'원본 MP3를 가져오지 못했습니다.'},502);
    const raw = new Uint8Array(await upstream.arrayBuffer());
    if (raw.length > 100*1024*1024) return c.json({ok:false,error:'TL3 출시용 음원은 100MB 이하만 지원합니다.'},413);
    const segments = parseMp3Segments(raw,5000);
    const durationMs = segments.reduce((n,x)=>n+x.durationMs,0);
    const hashBuf = await crypto.subtle.digest('SHA-256', raw);
    const hash = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const meta = {version:2,format:'TL3',file_id:fileId,title:file.title,artist:file.artist,duration_ms:durationMs,segment_count:segments.length,contentHash:hash,platform:'timelink.digital'};
    const container = buildTL3V2(meta,raw);
    const tl3Key = `tl3/releases/${fileId}.tl3`;
    await putD1Object(c.env.DB,tl3Key,container.data,'application/octet-stream',`${file.title}.tl3`);

    await c.env.DB.prepare('DELETE FROM tl3_segments WHERE file_id=?').bind(fileId).run();
    for (let i=0;i<segments.length;i++) {
      const seg=segments[i];
      await c.env.DB.prepare('INSERT INTO tl3_segments(file_id,segment_index,offset,length,duration_ms) VALUES(?,?,?,?,?)')
        .bind(fileId,i,seg.offset,seg.length,seg.durationMs).run();
    }
    await c.env.DB.prepare(`INSERT INTO tl3_releases
      (file_id,user_id,title,artist,price_tl,status,tl3_key,payload_offset,duration_ms,segment_count)
      VALUES (?,?,?,?,?,'released',?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET price_tl=excluded.price_tl,status='released',
      tl3_key=excluded.tl3_key,payload_offset=excluded.payload_offset,duration_ms=excluded.duration_ms,
      segment_count=excluded.segment_count,updated_at=datetime('now')
    `).bind(fileId,user.id,file.title,file.artist,price,tl3Key,container.payloadOffset,durationMs,segments.length).run();
    await c.env.DB.prepare("UPDATE tl_files SET shared=1, shared_to_shareplace=1, updated_at=datetime('now') WHERE id=?").bind(fileId).run();
    return c.json({ok:true,file_id:fileId,price_tl:price,status:'released',duration_ms:durationMs,segment_count:segments.length,tl3_key:tl3Key});
  } catch(e:any) { return c.json({ok:false,error:e.message||'TL3 release error'},500); }
});

// GET /api/v1/tl3/segment/:id — 실제 MP3 프레임 기준 약 5초 세그먼트
app.get('/api/v1/tl3/segment/:id', async (c) => {
  try {
    const auth = c.req.header('Authorization')?.replace('Bearer ','').trim() || '';
    const payload = auth ? await verifyToken(auth, c.env.JWT_SECRET) : null;
    if (!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if (!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);
    const fileId = Number(c.req.param('id') || 0);
    const segmentIndex = Math.max(0,Number(c.req.query('segment')||0));
    const sessionId = String(c.req.query('session_id')||'').slice(0,80);
    if (!fileId || !sessionId) return c.json({ok:false,error:'재생 세션이 필요합니다.'},400);
    const file = await c.env.DB.prepare(`SELECT f.id,f.user_id,f.revenue_held,r.status AS tl3_status,r.tl3_key,r.payload_offset,r.segment_count
      FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id WHERE f.id=? AND r.status='released'`).bind(fileId).first<any>();
    if (!file) return c.json({ok:false,error:'TL3 release not found'},404);
    if (file.revenue_held) return c.json({ok:false,error:'File under dispute'},400);
    if (segmentIndex >= Number(file.segment_count||0)) return c.json({ok:false,error:'재생 종료'},416);
    const seg = await c.env.DB.prepare('SELECT offset,length,duration_ms FROM tl3_segments WHERE file_id=? AND segment_index=?')
      .bind(fileId,segmentIndex).first<any>();
    if (!seg) return c.json({ok:false,error:'세그먼트 없음'},404);

    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS tl3_stream_sessions (
      id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,file_id INTEGER NOT NULL,next_segment INTEGER NOT NULL DEFAULT 0,
      last_segment_at INTEGER NOT NULL DEFAULT 0,pending_segment INTEGER, pending_cost REAL DEFAULT 0, pending_duration_ms INTEGER DEFAULT 0, pending_delivered_at INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
    for (const sql of [
      "ALTER TABLE tl3_stream_sessions ADD COLUMN next_segment INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tl3_stream_sessions ADD COLUMN pending_segment INTEGER",
      "ALTER TABLE tl3_stream_sessions ADD COLUMN pending_cost REAL DEFAULT 0",
      "ALTER TABLE tl3_stream_sessions ADD COLUMN pending_duration_ms INTEGER DEFAULT 0",
      "ALTER TABLE tl3_stream_sessions ADD COLUMN pending_delivered_at INTEGER DEFAULT 0"
    ]) { try { await c.env.DB.prepare(sql).run(); } catch (_) {} }
    const now=Math.floor(Date.now()/1000);
    let ss=await c.env.DB.prepare('SELECT * FROM tl3_stream_sessions WHERE id=? AND user_id=? AND file_id=?').bind(sessionId,u.id,fileId).first<any>();
    if (!ss) {
      if (segmentIndex!==0) return c.json({ok:false,error:'첫 세그먼트부터 요청해야 합니다.'},409);
      await c.env.DB.prepare('INSERT INTO tl3_stream_sessions(id,user_id,file_id,next_segment,last_segment_at) VALUES(?,?,?,?,0)').bind(sessionId,u.id,fileId,0).run();
      ss={next_segment:0,last_segment_at:0};
    }
    if (Number(ss.next_segment)!==segmentIndex) return c.json({ok:false,error:'순차 재생 세그먼트만 허용됩니다.',expected_segment:Number(ss.next_segment)},409);
    if (ss.pending_segment !== null && ss.pending_segment !== undefined) {
      const pendingAge=now-Number(ss.pending_delivered_at||now);
      const pendingDuration=Number(ss.pending_duration_ms||0)/1000;
      if (pendingAge > pendingDuration + 10) {
        const pendingCost=Number(ss.pending_cost||0);
        await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance+?,total_tl_spent=total_tl_spent-? WHERE id=?').bind(pendingCost,pendingCost,u.id).run();
        await c.env.DB.prepare('UPDATE tl3_stream_sessions SET next_segment=pending_segment+1,pending_segment=NULL,pending_cost=0,pending_duration_ms=0,pending_delivered_at=0,updated_at=datetime(\'now\') WHERE id=?').bind(sessionId).run();
        ss.next_segment=Number(ss.pending_segment)+1; ss.pending_segment=null;
      } else {
        return c.json({ok:false,error:'이전 세그먼트의 재생 정산이 필요합니다.',pending_segment:Number(ss.pending_segment)},409);
      }
    }
    if (Number(ss.last_segment_at) && now-Number(ss.last_segment_at)<4) return c.json({ok:false,error:'다음 재생 구간을 받을 수 없습니다.',retry_after:4-(now-Number(ss.last_segment_at))},429);

    const cost=Number((Number(seg.duration_ms)/1000).toFixed(3));
    const debit=await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance-?,total_tl_spent=total_tl_spent+? WHERE id=? AND tl_balance>=?')
      .bind(cost,cost,u.id,cost).run();
    if (!debit.meta?.changes) return c.json({ok:false,error:'시간 포인트가 부족합니다.',required:cost,balance:u.tl_balance},402);

    const rangeStart=Number(file.payload_offset)+Number(seg.offset);
    const rangeEnd=rangeStart+Number(seg.length)-1;
    const segmentBytes=await readD1Range(c.env.DB,String(file.tl3_key),rangeStart,Number(seg.length));
    if (!segmentBytes.byteLength) {
      await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance+?,total_tl_spent=total_tl_spent-? WHERE id=?').bind(cost,cost,u.id).run();
      return c.json({ok:false,error:'TL3 세그먼트를 가져올 수 없습니다.'},502);
    }

    await c.env.DB.prepare('UPDATE tl3_stream_sessions SET pending_segment=?,pending_cost=?,pending_duration_ms=?,pending_delivered_at=?,last_segment_at=?,updated_at=datetime(\'now\') WHERE id=?')
      .bind(segmentIndex,cost,Number(seg.duration_ms),now,now,sessionId).run();
    const revenue=0;
    const creator=await c.env.DB.prepare('SELECT id,tl_balance FROM users WHERE id=?').bind(file.user_id).first<any>();
    // 정산은 /confirm에서 실제 재생시간을 확정한 뒤 수행한다.
    const headers=new Headers({'Content-Type':'audio/mpeg','Content-Length':String(seg.length),'Cache-Control':'private, no-store',
      'X-TL3-Segment-Index':String(segmentIndex),'X-TL3-Segment-Duration-Ms':String(seg.duration_ms), 'X-TL3-Payload-Offset':String(seg.offset),
      'X-TL3-Next-Segment':String(segmentIndex+1)});
    const fresh=await c.env.DB.prepare('SELECT tl_balance FROM users WHERE id=?').bind(u.id).first<any>();
    headers.set('X-TL3-Remaining-TL',String(Number(fresh?.tl_balance||0)));
    return new Response(segmentBytes,{status:206,headers});
  } catch(e:any) { return c.json({ok:false,error:e.message||'TL3 segment error'},500); }
});


// POST /api/v1/tl3/segment/confirm/:id — 실제 재생시간 확정 및 미사용분 환급
app.post('/api/v1/tl3/segment/confirm/:id', async (c) => {
  try {
    const auth=c.req.header('Authorization')?.replace('Bearer ','').trim()||'';
    const payload=auth?await verifyToken(auth,c.env.JWT_SECRET):null;
    if(!payload) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    const u=await c.env.DB.prepare('SELECT * FROM users WHERE id=? AND is_active=1').bind(Number(payload.sub)).first<any>();
    if(!u) return c.json({ok:false,error:'사용자를 찾을 수 없습니다.'},401);
    const fileId=Number(c.req.param('id')||0);
    const body=await c.req.json<any>().catch(()=>({}));
    const sessionId=String(body.session_id||'').slice(0,80);
    const reported=Number(body.played_seconds||0);
    if(!fileId||!sessionId) return c.json({ok:false,error:'재생 세션이 필요합니다.'},400);
    const file=await c.env.DB.prepare(`SELECT f.id,f.user_id,f.revenue_held,r.status,r.segment_count FROM tl_files f JOIN tl3_releases r ON r.file_id=f.id WHERE f.id=? AND r.status='released'`).bind(fileId).first<any>();
    if(!file||file.revenue_held) return c.json({ok:false,error:'TL3 release not available'},404);
    const ss=await c.env.DB.prepare('SELECT * FROM tl3_stream_sessions WHERE id=? AND user_id=? AND file_id=?').bind(sessionId,u.id,fileId).first<any>();
    if(!ss||ss.pending_segment===null||ss.pending_segment===undefined) return c.json({ok:false,error:'대기 중인 세그먼트가 없습니다.'},409);
    const now=Math.floor(Date.now()/1000);
    const duration=Number(ss.pending_duration_ms||0)/1000;
    const wallCap=Math.min(duration,Math.max(0,now-Number(ss.pending_delivered_at||now))+1);
    const played=Math.max(0,Math.min(duration,reported,wallCap));
    const reserved=Number(ss.pending_cost||0);
    const refund=Number(Math.max(0,reserved-played).toFixed(3));
    const revenue=Number((played*0.7).toFixed(3));
    await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance+?,total_tl_spent=total_tl_spent-? WHERE id=?').bind(refund,refund,u.id).run();
    await c.env.DB.prepare('UPDATE tl3_stream_sessions SET next_segment=pending_segment+1,pending_segment=NULL,pending_cost=0,pending_duration_ms=0,pending_delivered_at=0,updated_at=datetime(\'now\') WHERE id=?').bind(sessionId).run();
    const creator=await c.env.DB.prepare('SELECT id,tl_balance FROM users WHERE id=?').bind(file.user_id).first<any>();
    if(creator&&revenue>0){
      await c.env.DB.prepare('UPDATE users SET tl_balance=tl_balance+?,total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?').bind(revenue,revenue,creator.id).run();
      await c.env.DB.prepare(`INSERT INTO transactions(user_id,file_id,tx_type,amount,balance_after,counterpart_user_id,note) VALUES (?,?,'earn',?,?,?,?)`)
        .bind(creator.id,fileId,revenue,Number(creator.tl_balance||0)+revenue,u.id,`TL3 실제 ${played.toFixed(3)}초 정산`).run();
    }
    await c.env.DB.prepare(`INSERT INTO play_events(file_id,player_user_id,tl_deducted,revenue_credited,file_tl_after,play_duration_seconds,car_mode) VALUES(?,?,?,?,?,?,0)`)
      .bind(fileId,u.id,played,revenue,null,Math.round(played),0).run();
    const fresh=await c.env.DB.prepare('SELECT tl_balance FROM users WHERE id=?').bind(u.id).first<any>();
    return c.json({ok:true,segment:Number(ss.pending_segment),reserved,played_seconds:played,refund,settled_tl:played,creator_revenue:revenue,remaining_tl:Number(fresh?.tl_balance||0)});
  } catch(e:any){ return c.json({ok:false,error:e.message||'TL3 confirm error'},500); }
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
  const body = bodyRaw;
  const isExternalFree = body.release_mode === 'free_mp3_external' || body.release_mode === 'free_mp3_local' || body.storage_mode === 'external_url' || body.storage_mode === 'creator_pc';
  const tl = userRow.tl ?? userRow.tl_balance ?? 0;
  // 외부 서버/창작자 PC 무료 공개는 TimeLink가 원본 파일 저장·호스팅 비용을 부담하지 않으므로 등록 수수료를 차감하지 않는다.
  if (!isExternalFree && tl < 5000) return c.json({ error: 'TL 부족', required: 5000, current: tl }, 402);
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
  // 무료/외부/창작자 PC 공개 여부를 share 자체에 저장한다.
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN release_mode TEXT DEFAULT ''").run().catch(() => {});
  await c.env.DB.prepare("ALTER TABLE tl_shares ADD COLUMN storage_mode TEXT DEFAULT ''").run().catch(() => {});
  const tlColRaw = userRow.tl !== undefined ? 'tl' : 'tl_balance';
  const tlCol = ['tl','tl_balance'].includes(tlColRaw) ? tlColRaw : 'tl';
  const realId = userRow.id;
  if (!isExternalFree) {
    await c.env.DB.prepare(`UPDATE users SET ${tlCol}=${tlCol}-5000 WHERE id=?`).bind(realId).run();
  }
  const id = 'sh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  
  // 외부 서버 무료 공개는 파일 자체를 TimeLink에 저장하지 않으며 file_tl도 0으로 시작한다.
  const fileTl = isExternalFree ? 0 : (body.file_tl || 5000);
  
  await c.env.DB.prepare(`
    INSERT INTO tl_shares (id,user_id,username,title,artist,album,duration,file_tl,category,file_type,category_type,description,plan,spotify_id,spotify_url,cover_url,preview_url,stream_url,country,content_lang,pulse,created_at,price_per_sec,composer,lyricist,lyrics,release_mode,storage_mode) 
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)
  `).bind(
    id, String(realId), username, body.title, body.artist || '', body.album || '',
    body.duration || 0, fileTl, body.category || 'Music', body.file_type || '', body.category_type || '',
    body.description || '', body.plan || 'A', body.spotify_id || null, body.spotify_url || null,
    body.cover_url || null, body.preview_url || null, body.stream_url || null,
    body.country || 'KR', body.content_lang || 'ko', Date.now(), body.price_per_sec || 1.0,
    body.composer || '', body.lyricist || '', body.lyrics || '',
    body.release_mode || '', body.storage_mode || ''
  ).run();
  
  // 🔥 중요: tl_user_files에 초기 레코드 생성 (직접 업로드한 파일 대응)
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO tl_user_files (user_id, share_id, tl_balance, total_charged, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(realId, id, fileTl, fileTl).run();
  
  const updated = await c.env.DB.prepare(`SELECT ${tlCol} as tl FROM users WHERE id=?`).bind(realId).first<{ tl: number }>();
  return c.json({ ok: true, id, tl_remaining: updated?.tl || 0 });
});

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
async function shareAuthUser(c:any){
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  if(!token) return null;
  const payload=await verifyToken(token,c.env.JWT_SECRET);
  if(!payload?.sub) return null;
  return Number(payload.sub);
}

// ── 유저의 특정 곡 TL 잔액 조회 ──
app.get('/api/shares/:id/my-tl', async (c) => {
  const userId=await shareAuthUser(c);
  if(!userId) return c.json({error:'인증 필요'},401);
  const shareId=c.req.param('id');
  try{
    await ensureShareTLBalances(c.env.DB);
    const share=await c.env.DB.prepare('SELECT id,file_tl,file_type,release_mode FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);
    let row=await c.env.DB.prepare('SELECT tl_balance,total_charged FROM tl_user_files WHERE user_id=? AND share_id=?')
      .bind(userId,shareId).first<any>();
    if(!row){
      await c.env.DB.prepare('INSERT OR IGNORE INTO tl_user_files (user_id,share_id,tl_balance,total_charged) VALUES (?,?,0,0)')
        .bind(userId,shareId).run();
      row={tl_balance:0,total_charged:0};
    }
    return c.json({ok:true,tl_balance:Number(row.tl_balance||0),total_charged:Number(row.total_charged||0),file_tl:Number(share.file_tl||0)});
  }catch(e:any){
    return c.json({error:e?.message||'TL 잔액 조회 실패'},500);
  }
});

// ── TL3 전용 TL 충전: 사용자의 공용 TL을 특정 파일 잔액으로 이동 ──
app.post('/api/shares/:id/charge', async (c) => {
  const userId=await shareAuthUser(c);
  if(!userId) return c.json({error:'인증 필요'},401);
  const shareId=c.req.param('id');
  try{
    const body=await c.req.json<any>().catch(()=>({}));
    const amount=Math.floor(Number(body.amount||0));
    if(!Number.isFinite(amount)||amount<=0) return c.json({error:'충전 TL은 1 이상이어야 합니다.'},400);
    await ensureShareTLBalances(c.env.DB);
    const share=await c.env.DB.prepare('SELECT id,user_id,file_tl,file_type,release_mode FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);
    const isMp3=String(share.file_type||'').toLowerCase()==='audio/mp3' ||
      String(share.release_mode||'').toLowerCase().startsWith('free_mp3');
    if(isMp3) return c.json({error:'MP3는 무료 재생이며 TL 충전 대상이 아닙니다.'},400);

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
  const shareId=c.req.param('id');
  try{
    const body=await c.req.json<any>().catch(()=>({}));
    const seconds=Math.max(1,Math.min(30,Math.floor(Number(body.seconds||0))));
    await ensureShareTLBalances(c.env.DB);
    const share=await c.env.DB.prepare('SELECT id,user_id,file_tl,file_type,release_mode FROM tl_shares WHERE id=?').bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);
    const isMp3=String(share.file_type||'').toLowerCase()==='audio/mp3' ||
      String(share.release_mode||'').toLowerCase().startsWith('free_mp3');
    if(isMp3) return c.json({ok:true,consumed:0,user_tl:0,tl_balance:0,free:true});

    const row=await c.env.DB.prepare('SELECT tl_balance FROM tl_user_files WHERE user_id=? AND share_id=?')
      .bind(userId,shareId).first<any>();
    const before=Number(row?.tl_balance||0);
    if(before<seconds) return c.json({ok:false,error:'TL이 부족합니다.',required:seconds,user_tl:before,tl_balance:before},402);

    const revenue=seconds*0.7;
    const creatorId=Number(share.user_id||0);
    const creator=creatorId?await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(creatorId).first<any>():null;
    const creatorCol='tl_balance';

    const statements=[
      c.env.DB.prepare('UPDATE tl_user_files SET tl_balance=tl_balance-?,updated_at=datetime("now") WHERE user_id=? AND share_id=? AND tl_balance>=?').bind(seconds,userId,shareId,seconds),
      c.env.DB.prepare('UPDATE tl_shares SET pulse=COALESCE(pulse,0)+? WHERE id=?').bind(seconds,shareId)
    ];
    if(creator) statements.push(
      c.env.DB.prepare('UPDATE users SET '+creatorCol+'='+creatorCol+'+?, total_tl_earned=COALESCE(total_tl_earned,0)+? WHERE id=?').bind(revenue,revenue,creatorId)
    );
    const batch=await c.env.DB.batch(statements);
    if(Number(batch[0]?.meta?.changes||0)!==1) return c.json({ok:false,error:'TL 소비 처리에 실패했습니다.'},409);

    const fresh=await c.env.DB.prepare('SELECT tl_balance,total_charged FROM tl_user_files WHERE user_id=? AND share_id=?').bind(userId,shareId).first<any>();
    return c.json({ok:true,consumed:seconds,revenue_credited:revenue,user_tl:Number(fresh?.tl_balance||0),tl_balance:Number(fresh?.tl_balance||0),total_charged:Number(fresh?.total_charged||0)});
  }catch(e:any){
    return c.json({ok:false,error:e?.message||'TL 소비 실패'},500);
  }
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


// ══════════════════════════════════════════════════════════
// PATCH /api/shares/:id — 창작자 정보 편집 (곡명 불변)
// ══════════════════════════════════════════════════════════
app.patch('/api/shares/:id', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  let userId: number;
  try {
    const p = parseJWT(auth);
    userId = p.userId || p.id || p.sub;
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
    const check = await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND password_hash=?').bind(email, password).first();
    if (!check) return c.json({ error: '이메일 또는 비밀번호가 틀렸습니다' }, 401);
    const user = await c.env.DB.prepare(USER_SELECT + ' WHERE email=?').bind(email).first();
    const token = await makeAccessToken(Number((user as any).id), c.env.JWT_SECRET);
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
      await c.env.DB.prepare(
        'INSERT INTO users (email, username, password_hash, tl, tl_balance, tlc_balance, created_at, is_advertiser, biz_reg_num, business_name) VALUES (?,?,?,10000,10000,0,?,?,?,?)'
      ).bind(email, username, password||'', now, isAdvertiser?1:0, bizRegNum||'', businessName||username).run();
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
app.options('/api/audio/:filename', (c) => new Response(null, { headers: {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
}}));

app.get('/api/audio/:filename',async(c)=>{try{await ensureD1Storage(c.env.DB);const key=`tracks/${c.req.param('filename')}`,meta=await getD1ObjectMeta(c.env.DB,key);if(!meta)return c.json({error:'Not found'},404);const cors:any={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range, Content-Type','Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'};const rh=c.req.header('Range')||'';let start=0,end=meta.size-1,status=200;if(rh){const m=rh.match(/bytes=(\\d+)-(\\d*)/);if(!m)return new Response('Invalid Range',{status:416});start=Number(m[1]);end=m[2]!==''?Math.min(Number(m[2]),meta.size-1):Math.min(start+D1_CHUNK_SIZE-1,meta.size-1);status=206;}const bytes=await readD1Range(c.env.DB,key,start,end-start+1),h:any={...cors,'Content-Type':meta.content_type||'audio/mpeg','Content-Length':String(bytes.byteLength)};if(status===206)h['Content-Range']=`bytes ${start}-${end}/${meta.size}`;return new Response(bytes,{status,headers:h});}catch(e:any){return c.json({error:e?.message||'오디오 읽기 실패'},500);}});
app.options('/api/audio/:filename',(c)=>new Response(null,{status:204}));
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

app.get('/api/stream/:shareId',async(c)=>{const token=(c.req.header('Authorization')||'').replace('Bearer ','')||c.req.query('tk')||'',userId=parseTokenUserId(token),shareId=c.req.param('shareId'),cors:any={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range, Content-Type, Authorization','Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length, X-TL-Balance','Accept-Ranges':'bytes'};try{const share=await c.env.DB.prepare('SELECT id,stream_url,storage_object_id,storage_provider FROM tl_shares WHERE id=?').bind(shareId).first() as any;if(!share)return new Response(JSON.stringify({error:'파일 없음'}),{status:404,headers:cors});
if(share.storage_object_id){
  try{
    const r=await externalStream(c.env.DB,c.env,Number(share.storage_object_id),c.req.header('Range')||'');
    const h=new Headers(r.headers);h.set('Access-Control-Allow-Origin','*');h.set('Access-Control-Expose-Headers','Content-Range,Accept-Ranges,Content-Length');
    return new Response(r.body,{status:r.status,headers:h});
  }catch(e:any){return new Response(JSON.stringify({error:e.message}),{status:502,headers:cors});}
}
const su=String(share.stream_url||'');let key='';if(su.includes('/api/storage/'))key=decodeURIComponent(su.split('/api/storage/')[1].split('?')[0]);else if(su.startsWith('tracks/')||su.startsWith('tl/'))key=su;else if(su.startsWith('http')){const fn=su.split('/').pop()?.split('?')[0]||'';key=fn.endsWith('.tl')?'tl/'+fn:'tracks/'+fn;}else key=su;if(!key)return new Response(JSON.stringify({error:'스트림 없음'}),{status:404,headers:cors});const meta=await getD1ObjectMeta(c.env.DB,key);if(!meta)return new Response(JSON.stringify({error:'D1 파일 없음'}),{status:404,headers:cors});const rh=c.req.header('Range')||'';let start=0,end=meta.size-1,status=200;if(rh){const m=rh.match(/bytes=(\\d+)-(\\d*)/);if(!m)return new Response('Invalid Range',{status:416,headers:cors});start=Number(m[1]);end=m[2]!==''?Math.min(Number(m[2]),meta.size-1):Math.min(start+D1_CHUNK_SIZE-1,meta.size-1);status=206;}const bytes=await readD1Range(c.env.DB,key,start,end-start+1),h:any={...cors,'Content-Type':meta.content_type||'audio/mpeg','Content-Length':String(bytes.byteLength),'Cache-Control':'no-store'};if(status===206)h['Content-Range']=`bytes ${start}-${end}/${meta.size}`;return new Response(bytes,{status,headers:h});}catch(e:any){return new Response(JSON.stringify({error:e.message}),{status:500,headers:cors});}});
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

app.post('/api/upload/tl',async(c)=>{try{await ensureD1Storage(c.env.DB);const f=await c.req.parseBody({limit:D1_MAX_FILE_SIZE}),file=f['file'] as File,shareId=(f['shareId'] as string)||('s_'+Date.now()),meta=JSON.parse((f['meta'] as string)||'{}');if(!file)return c.json({ok:false,error:'file 필요'},400);if(file.size>D1_MAX_FILE_SIZE)return c.json({ok:false,error:'100MB 초과'},400);const raw=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(raw),ext=(file.name.split('.').pop()||'bin').toLowerCase(),secret=(c.env as any).TL_SECRET||'timelink_default_secret_2026',tlPerSec=Number(meta.tl_per_sec||1),duration=Number(meta.duration||0),fileTL=Math.ceil(duration*tlPerSec)||3600,xorKey=shareId+secret+'TIMELINK_v1',header={shareId,creatorId:Number(meta.creatorId||0),creatorName:String(meta.creatorName||''),title:String(meta.title||file.name.replace(/\\.[^.]+$/, '')),artist:String(meta.artist||''),fileType:file.type||'application/octet-stream',ext,duration,tl_per_sec:tlPerSec,plan:String(meta.plan||'A'),tl_balance:fileTL,tl_max:fileTL,xorKey,uploadedAt:new Date().toISOString(),contentHash:hash,platform:'timelink.digital',version:1},tlData=buildTLFile(header,raw,secret),key=`tl/${shareId}.tl`;await putD1Object(c.env.DB,key,tlData,'application/octet-stream',`${shareId}.tl`);return c.json({ok:true,key,shareId,size:tlData.length,hash,storage_mode:'d1',url:`https://api.timelink.digital/api/storage/${encodeURIComponent(key)}`});}catch(e:any){return c.json({ok:false,error:e.message},500);}});
app.get('/api/download/:shareId', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();
  const userId=parseTokenUserId(token);
  const shareId=c.req.param('shareId');
  if(!userId) return c.json({error:'인증 필요'},401);
  try{
    const share=await c.env.DB.prepare(
      'SELECT id,title,stream_url,file_type,storage_object_id,storage_provider FROM tl_shares WHERE id=?'
    ).bind(shareId).first<any>();
    if(!share) return c.json({error:'파일 없음'},404);

    const fileType=String(share.file_type||'').toLowerCase();
    if(fileType==='audio/mp3') return c.json({error:'MP3는 무료 재생 전용이며 TL3 다운로드 대상이 아닙니다.'},400);

    const safeTitle=String(share.title||'file').replace(/[<>:"/\\|?*]/g,'_');
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
