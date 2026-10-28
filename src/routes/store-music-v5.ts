import {Hono} from 'hono';
import type {Env} from '../types';
import {verifyToken} from '../auth';
import {ensureD1Storage,putD1Object,getD1ObjectMeta,readD1Range} from '../d1-storage';

/**
 * TILO STORE ONLY: independently licensed, source-verified CC0 recordings.
 * Encrypted TLNK V5 containers do not enter tl_files / tl_shares, Shared Place
 * or the central radio. Playback is limited to paid store sessions.
 */
const router=new Hono<{Bindings:Env}>();
const enc=new TextEncoder();
const MAGIC=new Uint8Array([84,76,78,75,5]);
const MAX_MP3_BYTES=16*1024*1024;
const SOURCE_PAGE='https://kaino.dev/library/music';
const CC0_LICENSE='https://creativecommons.org/publicdomain/zero/1.0/';
const INITIAL_CC0=[
 ['acoustic-folk-01','Pale Window','Acoustic folk',90],
 ['acoustic-folk-02','Silent Voltage','Acoustic folk',90],
 ['acoustic-folk-03','Wandering Mirror','Acoustic folk',120],
 ['acoustic-folk-04','Rusted Pulse','Acoustic folk',120],
 ['acoustic-folk-05','Coastal Thunder','Acoustic folk',90],
 ['acoustic-folk-06','Crimson Anthem','Acoustic folk',90],
 ['acoustic-folk-07','Radiant Foundry','Acoustic folk',120],
 ['acoustic-folk-08','Velvet Forest','Acoustic folk',120],
 ['acoustic-folk-09','Turbo Echo','Acoustic folk',90],
 ['acoustic-folk-10','Copper Voltage','Acoustic folk',90]
] as const;
function asBuffer(b:Uint8Array):ArrayBuffer{return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer}
function concat(...parts:Uint8Array[]){const b=new Uint8Array(parts.reduce((n,x)=>n+x.length,0));let p=0;for(const x of parts){b.set(x,p);p+=x.length}return b}
function packU32(n:number){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,false);return b}
function b64(data:Uint8Array){let s='';for(const x of data)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}
function unb64(s:string){const str=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));return Uint8Array.from(str,ch=>ch.charCodeAt(0))}
async function digest(raw:Uint8Array){const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',asBuffer(raw)));return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('')}
function mp3Duration(raw:Uint8Array){
 let cursor=0;if(raw.length>10&&raw[0]===73&&raw[1]===68&&raw[2]===51){const n=((raw[6]&127)<<21)|((raw[7]&127)<<14)|((raw[8]&127)<<7)|(raw[9]&127);cursor=10+n+((raw[5]&16)?10:0)}
 const v1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
 const v2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
 let frames=0,duration=0;
 while(cursor+4<=raw.length){
  const h=((raw[cursor]<<24)|(raw[cursor+1]<<16)|(raw[cursor+2]<<8)|raw[cursor+3])>>>0;
  if((h>>>21)!==0x7ff){cursor++;continue}
  const v=(h>>>19)&3,layer=(h>>>17)&3,bit=(h>>>12)&15,samp=(h>>>10)&3,pad=(h>>>9)&1;
  if(v===1||layer!==1||bit===0||bit===15||samp===3){cursor++;continue}
  const rate=(v===3?[44100,48000,32000]:v===2?[22050,24000,16000]:[11025,12000,8000])[samp];
  const rateK=(v===3?v1:v2)[bit],len=Math.floor((v===3?144:72)*rateK*1000/rate)+pad;
  if(len<24||cursor+len>raw.length)break;
  duration+=(v===3?1152:576)*1000/rate;frames++;cursor+=len;
 }
 if(frames<10||duration<1000||!Number.isFinite(duration))throw Error('INVALID_MP3_FRAMES');
 return Math.round(duration);
}
async function owner(c:any){
 const token=String(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
 if(!token)return null;
 const claims=await verifyToken(token,String(c.env.JWT_SECRET||'')).catch(()=>null);
 const uid=Number(claims?.sub||0);
 if(!Number.isSafeInteger(uid)||uid<1)return null;
 const u=await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0").bind(uid).first().catch(()=>null);
 return u?uid:null;
}
async function ownCafe(db:D1Database,uid:number,channel:string){
 if(!/^cafe_[a-f0-9]{16}$/.test(channel))return false;
 const x=await db.prepare("SELECT channel_id FROM cafe_channels WHERE channel_id=? AND owner_id=? AND status='active'").bind(channel,uid).first();
 return !!x;
}
async function ensure(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_store_music_tracks (track_key TEXT PRIMARY KEY,title TEXT NOT NULL,artist TEXT NOT NULL,genre TEXT NOT NULL,source_page TEXT NOT NULL,source_download TEXT NOT NULL,license_code TEXT NOT NULL,license_url TEXT NOT NULL,rights_evidence TEXT NOT NULL,country TEXT NOT NULL DEFAULT 'ALL',expected_seconds INTEGER NOT NULL,duration_ms INTEGER NOT NULL DEFAULT 0,object_key TEXT,source_sha256 TEXT,container_sha256 TEXT,wrapped_key TEXT,container_size INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_store_music_plays (session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,channel_id TEXT NOT NULL,track_key TEXT NOT NULL,grant_order_id TEXT NOT NULL,reserved_seconds INTEGER NOT NULL,consumed_seconds INTEGER NOT NULL DEFAULT 0,started_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',last_meter_ms INTEGER NOT NULL)").run();
 await db.prepare("CREATE INDEX IF NOT EXISTS idx_v5_store_music_active ON v5_store_music_plays(channel_id,status,expires_ms)").run();
}
async function seed(db:D1Database){
 const statements=INITIAL_CC0.map(([id,title,genre,secs])=>db.prepare("INSERT OR IGNORE INTO v5_store_music_tracks(track_key,title,artist,genre,source_page,source_download,license_code,license_url,rights_evidence,expected_seconds) VALUES(?,?, 'Kainotomic', ?, ?, ?, 'CC0', ?, ?, ?)").bind(
 id,title,genre,SOURCE_PAGE,'https://kaino.dev/api/library/music/'+id+'/download?format=mp3',CC0_LICENSE,
 'Publisher asserts both copyright and related recording rights waived under CC0 1.0: '+SOURCE_PAGE,secs
 ));
 await db.batch(statements);
}
async function wrappingKey(secret:string){
 if(secret.length<24)throw Error('TL3_MASTER_SECRET_UNAVAILABLE');
 const hash=await crypto.subtle.digest('SHA-256',asBuffer(enc.encode(secret)));
 return crypto.subtle.importKey('raw',hash,'AES-GCM',false,['encrypt','decrypt']);
}
async function makeTL3(raw:Uint8Array,keyId:string,title:string,artist:string,duration_ms:number,source_hash:string,secret:string){
 const manifest={profile:'TL3-V5',version:5,scope:'commercial_broadcast_only',track_key:keyId,title,artist,duration_ms,
 source_sha256:source_hash,rights:{license:'CC0',proof_url:SOURCE_PAGE,commercial_use:true,transformation:true},created_at:new Date().toISOString()};
 const metadata=enc.encode(JSON.stringify(manifest));
 const plain=concat(packU32(metadata.length),metadata,raw);
 const contentKey=crypto.getRandomValues(new Uint8Array(32));
 const nonce=crypto.getRandomValues(new Uint8Array(12));
 const boot=enc.encode(JSON.stringify({profile:'TL3-V5',algorithm:'AES-256-GCM',nonce:b64(nonce),ciphertext_bytes:plain.length+16}));
 const prefix=concat(MAGIC,packU32(boot.length),boot);
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:asBuffer(nonce),additionalData:asBuffer(prefix),tagLength:128},await crypto.subtle.importKey('raw',asBuffer(contentKey),'AES-GCM',false,['encrypt']),asBuffer(plain)));
 const master=await wrappingKey(secret);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const enveloped=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:asBuffer(iv),additionalData:asBuffer(enc.encode('timelink:store:v5:'+keyId))},master,asBuffer(contentKey)));
 return {container:concat(prefix,cipher),wrapped:b64(concat(iv,enveloped))};
}
async function unwrapKey(secret:string,keyId:string,wrapped:string){
 const buf=unb64(wrapped);if(buf.length!==60)throw Error('STORED_KEY_INVALID');
 const master=await wrappingKey(secret);
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:asBuffer(buf.slice(0,12)),additionalData:asBuffer(enc.encode('timelink:store:v5:'+keyId))},master,asBuffer(buf.slice(12))));
}
/**
 * Bounded importer called from existing Worker cron. The source belongs to the
 * publisher and identifies both music and recording as CC0. No arbitrary URL,
 * license flag or user input can be used for this automatic path.
 */
export async function runStoreMusicIntake(env:Env){
 await ensure(env.DB);await seed(env.DB);
 const candidate=await env.DB.prepare("SELECT track_key,title,artist,source_download,expected_seconds FROM v5_store_music_tracks WHERE status='queued' AND attempts<3 ORDER BY track_key LIMIT 1").first<any>();
 if(!candidate)return;
 const id=String(candidate.track_key);
 await env.DB.prepare("UPDATE v5_store_music_tracks SET attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE track_key=? AND status='queued'").bind(id).run();
 try{
  const license=await fetch(SOURCE_PAGE,{signal:AbortSignal.timeout(12000)});
  if(!license.ok||!(await license.text()).includes('CC0 1.0 Universal'))throw Error('CC0_SOURCE_ASSERTION_MISSING');
  const source=await fetch(String(candidate.source_download),{signal:AbortSignal.timeout(25000)});
  if(!source.ok)throw Error('SOURCE_HTTP_'+source.status);
  const max=Number(source.headers.get('content-length')||0);
  if(max>MAX_MP3_BYTES)throw Error('SOURCE_TOO_LARGE');
  const raw=new Uint8Array(await source.arrayBuffer());
  if(raw.length<1024||raw.length>MAX_MP3_BYTES)throw Error('INVALID_SOURCE_LENGTH');
  const duration=mp3Duration(raw);
  if(Math.abs(duration-Number(candidate.expected_seconds)*1000)>5000)throw Error('SOURCE_DURATION_MISMATCH');
  const hash=await digest(raw);
  const secret=String(env.TL3_MASTER_SECRET||'');
  const sealed=await makeTL3(raw,id,String(candidate.title),String(candidate.artist),duration,hash,secret);
  const containerHash=await digest(sealed.container);
  const objectKey='store/tl3/v5/'+id+'/'+hash+'.tl3';
  await ensureD1Storage(env.DB);
  await putD1Object(env.DB,objectKey,sealed.container,'application/octet-stream',id+'.tl3');
  await env.DB.prepare("UPDATE v5_store_music_tracks SET status='ready',duration_ms=?,object_key=?,source_sha256=?,container_sha256=?,wrapped_key=?,container_size=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE track_key=? AND status='queued'")
   .bind(duration,objectKey,hash,containerHash,sealed.wrapped,sealed.container.length,id).run();
  console.log('[STORE_MUSIC_READY]',id,duration,sealed.container.length);
 }catch(e:any){
  const msg=String(e?.message||'IMPORT_FAILED').slice(0,180);
  await env.DB.prepare("UPDATE v5_store_music_tracks SET last_error=?,status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,updated_at=CURRENT_TIMESTAMP WHERE track_key=?").bind(msg,id).run();
  console.error('[STORE_MUSIC_IMPORT_FAILED]',id,msg);
 }
}
async function balance(db:D1Database,uid:number,channel:string){
 const row=await db.prepare("SELECT COALESCE(SUM(granted_seconds-used_seconds),0) n FROM v5_store_airtime_grants WHERE user_id=? AND channel_id=? AND expires_at_ms>?").bind(uid,channel,Date.now()).first<any>();
 return Number(row?.n||0);
}
router.get('/queue',async c=>{
 const uid=await owner(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const channel=String(c.req.query('channel_id')||'');
 const genre=String(c.req.query('genre')||'all').slice(0,100).toLowerCase();
 if(!await ownCafe(c.env.DB,uid,channel))return c.json({ok:false,code:'STORE_OWNER_REQUIRED'},403);
 try{
  await ensure(c.env.DB);
  const remaining=await balance(c.env.DB,uid,channel);
  const rows=await c.env.DB.prepare("SELECT track_key,title,artist,genre,duration_ms,license_code,license_url,rights_evidence FROM v5_store_music_tracks WHERE status='ready' AND (LOWER(genre)=? OR ?='all') ORDER BY title LIMIT 200").bind(genre,genre).all<any>();
  c.header('Cache-Control','private,no-store');
  return c.json({ok:true,scope:'commercial_broadcast_only',channel_id:channel,remaining_seconds:remaining,tracks:rows.results||[],playback_enabled:remaining>0,other_catalog_tracks_included:false});
 }catch(e:any){console.error('[STORE_MUSIC_QUEUE]',e);return c.json({ok:false,code:'STORE_MUSIC_NOT_READY'},503)}
});
router.post('/session',async c=>{
 const uid=await owner(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),channel=String(b?.channel_id||''),key=String(b?.track_key||'');
 if(!/^[a-z0-9-]{1,80}$/.test(key)||!await ownCafe(c.env.DB,uid,channel))return c.json({ok:false,code:'STORE_OWNER_REQUIRED'},403);
 const jwk=b?.player_public_key;
 if(!jwk||jwk.kty!=='EC'||jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(jwk.x)||!/^[A-Za-z0-9_-]{43}$/.test(jwk.y))return c.json({ok:false,code:'PLAYER_KEY_INVALID'},400);
 try{
  await ensure(c.env.DB);await releaseExpiredStoreSessions(c.env);
  const track=await c.env.DB.prepare("SELECT * FROM v5_store_music_tracks WHERE track_key=? AND status='ready'").bind(key).first<any>();
  if(!track)return c.json({ok:false,code:'STORE_TRACK_NOT_READY'},404);
  const duration=Math.ceil(Number(track.duration_ms)/1000);
  const existing=await c.env.DB.prepare("SELECT session_id FROM v5_store_music_plays WHERE channel_id=? AND status='active' AND expires_ms>?").bind(channel,Date.now()).first();
  if(existing)return c.json({ok:false,code:'STORE_PLAYER_ALREADY_ACTIVE'},409);
  const grant=await c.env.DB.prepare("SELECT order_id,granted_seconds-used_seconds available FROM v5_store_airtime_grants WHERE user_id=? AND channel_id=? AND expires_at_ms>? AND granted_seconds-used_seconds>=? ORDER BY expires_at_ms,order_id LIMIT 1").bind(uid,channel,Date.now(),duration).first<any>();
  if(!grant)return c.json({ok:false,code:'STORE_TIME_INSUFFICIENT'},402);
  const contentKey=await unwrapKey(String(c.env.TL3_MASTER_SECRET||''),key,String(track.wrapped_key));
  const memberPublic=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,ext:true},{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']) as CryptoKeyPair;
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:memberPublic} as any,ephemeral.privateKey,256);
  const salt=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));
  const sessionId='sm_'+crypto.randomUUID().replace(/-/g,'');
  const info=enc.encode(['timelink:store:v5:license',uid,channel,key,sessionId].join(':'));
  const hkdf=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
  const transportKey=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:asBuffer(salt),info:asBuffer(info)},hkdf,{name:'AES-GCM',length:256},false,['encrypt']);
  const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:asBuffer(iv),additionalData:asBuffer(info)},transportKey,asBuffer(contentKey)));
  const exported=await crypto.subtle.exportKey('jwk',ephemeral.publicKey) as JsonWebKey;
  const started=Date.now(),expires=started+Math.max(60000,Math.min(900000,duration*1000+90000));
  await c.env.DB.batch([
   c.env.DB.prepare("UPDATE v5_store_airtime_grants SET used_seconds=used_seconds+? WHERE order_id=? AND granted_seconds-used_seconds>=? AND expires_at_ms>?").bind(duration,String(grant.order_id),duration,started),
   c.env.DB.prepare("INSERT INTO v5_store_music_plays(session_id,user_id,channel_id,track_key,grant_order_id,reserved_seconds,consumed_seconds,started_ms,expires_ms,last_meter_ms) SELECT ?,?,?,?,?,?,0,?,?,? WHERE (SELECT changes())=1").bind(sessionId,uid,channel,key,String(grant.order_id),duration,started,expires,started)
  ]);
  const session=await c.env.DB.prepare("SELECT session_id FROM v5_store_music_plays WHERE session_id=? AND status='active'").bind(sessionId).first();
  if(!session)return c.json({ok:false,code:'STORE_TIME_CONFLICT'},409);
  c.header('Cache-Control','private,no-store');
  return c.json({ok:true,session_id:sessionId,track_key:key,channel_id:channel,duration_ms:Number(track.duration_ms),reserved_seconds:duration,encrypted_container:true,
   salt:b64(salt),nonce:b64(iv),wrapped_content_key:b64(wrapped),ephemeral_public_key:{kty:'EC',crv:'P-256',x:exported.x,y:exported.y},info:['timelink:store:v5:license',uid,channel,key,sessionId].join(':'),
   container_url:'/api/v5/store-music/container/'+key+'?session_id='+encodeURIComponent(sessionId),expires_ms:expires});
 }catch(e:any){console.error('[STORE_SESSION]',e);return c.json({ok:false,code:'STORE_LICENSE_FAILED'},503)}
});
router.get('/container/:track',async c=>{
 const uid=await owner(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const track=String(c.req.param('track')||''),session=String(c.req.query('session_id')||'');
 if(!/^sm_[a-f0-9]{32}$/.test(session))return c.json({ok:false,code:'SESSION_INVALID'},400);
 const row=await c.env.DB.prepare("SELECT t.object_key,t.container_sha256,t.container_size FROM v5_store_music_plays p JOIN v5_store_music_tracks t ON t.track_key=p.track_key WHERE p.session_id=? AND p.user_id=? AND p.track_key=? AND p.status='active' AND p.expires_ms>? AND t.status='ready'").bind(session,uid,track,Date.now()).first<any>().catch(()=>null);
 if(!row)return c.json({ok:false,code:'STORE_PLAYBACK_DENIED'},403);
 const meta=await getD1ObjectMeta(c.env.DB,String(row.object_key));
 if(!meta||meta.size!==Number(row.container_size))return c.json({ok:false,code:'STORE_CONTAINER_MISSING'},503);
 const data=await readD1Range(c.env.DB,String(row.object_key),0,meta.size);
 if(await digest(data)!==String(row.container_sha256))return c.json({ok:false,code:'STORE_CONTAINER_CORRUPT'},503);
 return new Response(asBuffer(data),{status:200,headers:{'Content-Type':'application/octet-stream','Content-Length':String(data.length),'Cache-Control':'private,no-store','X-TL3-Version':'5','X-TL3-Scope':'commercial_broadcast_only'}});
});
router.post('/meter',async c=>{
 const uid=await owner(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const body=await c.req.json<any>().catch(()=>null),sid=String(body?.session_id||''),reported=Number(body?.played_seconds);
 if(!/^sm_[a-f0-9]{32}$/.test(sid)||!Number.isSafeInteger(reported)||reported<0)return c.json({ok:false,code:'INVALID_METER'},400);
 const x=await c.env.DB.prepare("SELECT * FROM v5_store_music_plays WHERE session_id=? AND user_id=? AND status='active'").bind(sid,uid).first<any>().catch(()=>null);
 if(!x)return c.json({ok:false,code:'STORE_SESSION_NOT_ACTIVE'},409);
 const now=Date.now();
 if(now>Number(x.expires_ms))return c.json({ok:false,code:'STORE_SESSION_EXPIRED'},409);
 const plausible=Math.floor((now-Number(x.started_ms))/1000)+2;
 if(reported>plausible||reported>Number(x.reserved_seconds))return c.json({ok:false,code:'METER_EXCEEDS_PLAYBACK'},422);
 const target=Math.max(Number(x.consumed_seconds),reported);
 await c.env.DB.prepare("UPDATE v5_store_music_plays SET consumed_seconds=?,last_meter_ms=? WHERE session_id=? AND user_id=? AND status='active' AND consumed_seconds<=?").bind(target,now,sid,uid,target).run();
 return c.json({ok:true,played_seconds:target,reserved_seconds:Number(x.reserved_seconds),unconsumed_seconds:Number(x.reserved_seconds)-target});
});
async function finishSession(db:D1Database,session:any,status:string){
 const refund=Math.max(0,Number(session.reserved_seconds)-Number(session.consumed_seconds));
 await db.batch([
  db.prepare("UPDATE v5_store_music_plays SET status=? WHERE session_id=? AND status='active'").bind(status,String(session.session_id)),
  db.prepare("UPDATE v5_store_airtime_grants SET used_seconds=MAX(0,used_seconds-?) WHERE order_id=? AND (SELECT changes())=1").bind(refund,String(session.grant_order_id))
 ]);
 return refund;
}
router.post('/close',async c=>{
 const uid=await owner(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null),sid=String(b?.session_id||'');
 if(!/^sm_[a-f0-9]{32}$/.test(sid))return c.json({ok:false,code:'SESSION_INVALID'},400);
 const session=await c.env.DB.prepare("SELECT * FROM v5_store_music_plays WHERE session_id=? AND user_id=?").bind(sid,uid).first<any>().catch(()=>null);
 if(!session)return c.json({ok:false,code:'SESSION_NOT_FOUND'},404);
 if(session.status!=='active')return c.json({ok:true,alreadyClosed:true});
 const refund=await finishSession(c.env.DB,session,'closed');
 return c.json({ok:true,charged_seconds:Number(session.consumed_seconds),refunded_seconds:refund});
});
export async function releaseExpiredStoreSessions(env:Env){
 await ensure(env.DB);
 const rows=await env.DB.prepare("SELECT * FROM v5_store_music_plays WHERE status='active' AND expires_ms<? ORDER BY expires_ms LIMIT 50").bind(Date.now()).all<any>();
 for(const row of rows.results||[])await finishSession(env.DB,row,'expired');
}
router.get('/status',async c=>{
 const uid=await owner(c);if(!uid)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
 await ensure(c.env.DB);
 const x=await c.env.DB.prepare("SELECT status,COUNT(*) n FROM v5_store_music_tracks GROUP BY status").all<any>();
 return c.json({ok:true,scope:'commercial_broadcast_only',counts:x.results||[],shared_place:false,central_radio:false});
});
export default router;
