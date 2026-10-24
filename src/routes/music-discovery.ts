import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware } from '../middleware';
import type { Env,User } from '../types';
import { putV5Object,deleteV5Object } from '../v5-object-store';

const router=new Hono<{Bindings:Env;Variables:{user:User}}>();
router.use('*',authMiddleware);
router.use('*',bodyLimit({maxSize:21*1024*1024}));
export async function ensureDiscovery(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_music_discovery (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,batch_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,file_name TEXT NOT NULL,size_bytes INTEGER NOT NULL,
    storage_key TEXT NOT NULL,nonce_hex TEXT NOT NULL,key_source TEXT NOT NULL,
    title TEXT NOT NULL,artist TEXT NOT NULL DEFAULT '',metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending_rights',created_at TEXT DEFAULT(datetime('now')),
    UNIQUE(user_id,sha256))`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_discovery_batch_limit BEFORE INSERT ON v5_music_discovery
    WHEN (SELECT COUNT(*) FROM v5_music_discovery WHERE user_id=NEW.user_id AND batch_id=NEW.batch_id)>=10
    BEGIN SELECT RAISE(ABORT,'DISCOVERY_BATCH_LIMIT'); END`).run();
}
router.get('/',async c=>{
  await ensureDiscovery(c.env.DB);
  const rows=await c.env.DB.prepare(`SELECT id,batch_id,file_name,size_bytes,title,artist,status,created_at
    FROM v5_music_discovery WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).bind(c.get('user').id).all();
  return c.json({ok:true,registrations:rows.results||[]});
});
router.post('/',async c=>{
  const keySource=c.env.STORAGE_ENCRYPTION_KEY?'STORAGE_ENCRYPTION_KEY':'TL3_MASTER_SECRET';
  const secret=c.env.STORAGE_ENCRYPTION_KEY||c.env.TL3_MASTER_SECRET;
  if(!secret)return c.json({error:'PRIVATE_ENCRYPTION_NOT_CONFIGURED'},503);
  const body=await c.req.parseBody();
  const file=body.file,batchId=String(body.batch_id||'');
  if(!(file instanceof File)||file.size<=0||file.size>20*1024*1024||
    !/\.(mp3|wav|flac|m4a|aac)$/i.test(file.name)||!/^[a-zA-Z0-9_-]{8,80}$/.test(batchId))
    return c.json({error:'음원 파일(최대 20MB)과 등록 묶음 ID를 확인하세요.'},400);
  const title=String(body.title||file.name.replace(/\.[^.]+$/,'')).trim().slice(0,200);
  const artist=String(body.artist||'').trim().slice(0,200);
  const metadata=String(body.metadata||'{}');
  if(metadata.length>10000)return c.json({error:'METADATA_TOO_LARGE'},400);
  try{JSON.parse(metadata);}catch{return c.json({error:'INVALID_METADATA'},400);}
  await ensureDiscovery(c.env.DB);
  const userId=c.get('user').id;
  const raw=await file.arrayBuffer();
  const hex=(v:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(v)).map(x=>x.toString(16).padStart(2,'0')).join('');
  const hash=hex(await crypto.subtle.digest('SHA-256',raw));
  const previous=await c.env.DB.prepare('SELECT id,status FROM v5_music_discovery WHERE user_id=? AND sha256=?').bind(userId,hash).first<any>();
  if(previous)return c.json({ok:true,replayed:true,registration:previous});
  const id=crypto.randomUUID(),storageKey='private-discovery/'+userId+'/'+id+'.enc';
  const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode('timelink:discovery:v1:'+secret)),{name:'AES-GCM'},false,['encrypt']);
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode(id+':'+hash)},key,raw);
  await putV5Object(c.env,storageKey,new Uint8Array(encrypted),'application/octet-stream');
  try{
    await c.env.DB.prepare(`INSERT INTO v5_music_discovery
      (id,user_id,batch_id,sha256,file_name,size_bytes,storage_key,nonce_hex,key_source,title,artist,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,userId,batchId,hash,file.name.slice(0,255),file.size,storageKey,hex(nonce),keySource,title,artist,metadata).run();
  }catch(e){
    await deleteV5Object(c.env,storageKey);
    const raced=await c.env.DB.prepare('SELECT id,status FROM v5_music_discovery WHERE user_id=? AND sha256=?').bind(userId,hash).first<any>();
    if(raced)return c.json({ok:true,replayed:true,registration:raced});
    return c.json({error:'DISCOVERY_REGISTRATION_FAILED'},409);
  }
  return c.json({ok:true,replayed:false,registration:{id,status:'pending_rights'},
    note:'비공개 등록되었습니다. 권리 검토 승인 전에는 공개 재생·수익 지급이 이뤄지지 않습니다.'},201);
});
export default router;
