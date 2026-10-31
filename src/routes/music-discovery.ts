import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware } from '../middleware';
import type { Env,User } from '../types';
import { putV5Object,deleteV5Object } from '../v5-object-store';
import {findRegisteredRecordingDuplicate,normalizeIsrc} from '../v5-recording-identity';

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
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_music_discovery_reviews(
    registration_id TEXT PRIMARY KEY,
    reviewer_id INTEGER NOT NULL,
    decision TEXT NOT NULL,
    evidence_url TEXT NOT NULL DEFAULT '',
    reviewer_note TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_v5_music_discovery_status ON v5_music_discovery(status,created_at)').run();
}
async function requireAdmin(c:any):Promise<number>{
  const id=Number(c.get('user')?.id||0);
  if(!Number.isSafeInteger(id)||id<=0)return 0;
  const row=await c.env.DB.prepare('SELECT role FROM users WHERE id=? LIMIT 1').bind(id).first<any>().catch(()=>null);
  return ['admin','super_admin'].includes(String(row?.role||'').toLowerCase())?id:0;
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
  let metadataObject:any;
  try{metadataObject=JSON.parse(metadata);}catch{return c.json({error:'INVALID_METADATA'},400);}
  if(!metadataObject||typeof metadataObject!=='object'||Array.isArray(metadataObject)||
     metadataObject.source!=='creator-existing-recording-review'||
     !['recording_owner','composition_owner','authorized_agent'].includes(String(metadataObject.rights_role||''))||
     metadataObject.acknowledgement!=='pending_manual_verification')
    return c.json({error:'RIGHTS_REVIEW_DECLARATION_REQUIRED'},400);
  const evidenceUrl=String(metadataObject.evidence_url||'').trim();
  if(evidenceUrl){
    let u:URL;try{u=new URL(evidenceUrl)}catch{return c.json({error:'INVALID_EVIDENCE_URL'},400)}
    if(u.protocol!=='https:'||u.username||u.password||evidenceUrl.length>1200)return c.json({error:'INVALID_EVIDENCE_URL'},400);
  }
  const rawIsrc=String(metadataObject.isrc||'').trim();
  const isrc=normalizeIsrc(rawIsrc);
  if(rawIsrc&&!isrc)return c.json({error:'INVALID_ISRC'},400);
  await ensureDiscovery(c.env.DB);
  const userId=c.get('user').id;
  const raw=await file.arrayBuffer();
  const hex=(v:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(v)).map(x=>x.toString(16).padStart(2,'0')).join('');
  const hash=hex(await crypto.subtle.digest('SHA-256',raw));
  const previous=await c.env.DB.prepare('SELECT id,status FROM v5_music_discovery WHERE user_id=? AND sha256=?').bind(userId,hash).first<any>();
  if(previous)return c.json({ok:true,replayed:true,registration:previous});
  const registered=await findRegisteredRecordingDuplicate(c.env.DB,{sourceSha256:hash,isrc});
  if(registered)return c.json({ok:false,error:'TRACK_ALREADY_REGISTERED',
    duplicate_by:registered.matched_by,file_id:registered.file_id,share_id:registered.share_id,
    note:'이미 TimeLink에 등록된 곡입니다. 기존 곡의 권리 관계 또는 공유 기능을 확인하세요.'},409);
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

router.get('/review-queue',async c=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  await ensureDiscovery(c.env.DB);
  const rows=await c.env.DB.prepare(`SELECT id,user_id,batch_id,file_name,size_bytes,title,artist,status,created_at,metadata_json
    FROM v5_music_discovery WHERE status IN ('pending_rights','rights_review','disputed')
    ORDER BY created_at ASC LIMIT 100`).all<any>();
  return c.json({ok:true,registrations:(rows.results||[]).map((row:any)=>{
    let metadata:any={};try{metadata=JSON.parse(String(row.metadata_json||'{}'));}catch{}
    return {id:row.id,user_id:Number(row.user_id),batch_id:row.batch_id,file_name:row.file_name,
      size_bytes:Number(row.size_bytes),title:row.title,artist:row.artist,status:row.status,created_at:row.created_at,
      rights_role:String(metadata.rights_role||''),isrc:normalizeIsrc(metadata.isrc)||null,
      evidence_url:typeof metadata.evidence_url==='string'?metadata.evidence_url:null};
  })});
});
router.post('/:id/review',async c=>{
  const adminId=await requireAdmin(c);
  if(!adminId)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  await ensureDiscovery(c.env.DB);
  const id=String(c.req.param('id')||'');
  if(!/^[0-9a-f-]{36}$/i.test(id))return c.json({ok:false,error:'INVALID_REGISTRATION_ID'},400);
  const body=await c.req.json<any>().catch(()=>null);
  if(!body||typeof body!=='object'||Array.isArray(body))return c.json({ok:false,error:'INVALID_REVIEW'},400);
  const decision=String(body.decision||'');
  if(!['approve','reject','dispute'].includes(decision))return c.json({ok:false,error:'INVALID_DECISION'},400);
  const note=String(body.reviewer_note||'').trim();
  if(note.length<3||note.length>2000)return c.json({ok:false,error:'REVIEW_NOTE_REQUIRED'},400);
  const evidence=String(body.evidence_url||'').trim();
  if(decision==='approve'){
    let u:URL;try{u=new URL(evidence)}catch{return c.json({ok:false,error:'EVIDENCE_URL_REQUIRED'},400)}
    if(u.protocol!=='https:'||u.username||u.password||evidence.length>1200)
      return c.json({ok:false,error:'INVALID_EVIDENCE_URL'},400);
  }else if(evidence){
    let u:URL;try{u=new URL(evidence)}catch{return c.json({ok:false,error:'INVALID_EVIDENCE_URL'},400)}
    if(u.protocol!=='https:'||u.username||u.password||evidence.length>1200)
      return c.json({ok:false,error:'INVALID_EVIDENCE_URL'},400);
  }
  const registration=await c.env.DB.prepare('SELECT id,status FROM v5_music_discovery WHERE id=?').bind(id).first<any>();
  if(!registration)return c.json({ok:false,error:'NOT_FOUND'},404);
  if(!['pending_rights','rights_review','disputed'].includes(String(registration.status)))
    return c.json({ok:false,error:'REVIEW_ALREADY_DECIDED'},409);
  const status=decision==='approve'?'approved':decision==='reject'?'rejected':'disputed';
  try{
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE v5_music_discovery SET status=? WHERE id=? AND status IN (\'pending_rights\',\'rights_review\',\'disputed\')').bind(status,id),
      c.env.DB.prepare(`INSERT INTO v5_music_discovery_reviews
        (registration_id,reviewer_id,decision,evidence_url,reviewer_note)
        VALUES(?,?,?,?,?)
        ON CONFLICT(registration_id) DO UPDATE SET reviewer_id=excluded.reviewer_id,
        decision=excluded.decision,evidence_url=excluded.evidence_url,
        reviewer_note=excluded.reviewer_note,reviewed_at=CURRENT_TIMESTAMP`)
        .bind(id,adminId,decision,evidence,note)
    ]);
  }catch{return c.json({ok:false,error:'RIGHTS_REVIEW_FAILED'},503)}
  return c.json({ok:true,id,status,public:false,playable:false,settlement_enabled:false,
    note:status==='approved'
      ?'권리 검토가 승인되었습니다. 별도 TL3 자산화·공개 절차 전에는 재생·정산되지 않습니다.'
      :'검토 상태가 변경되었습니다. 공개·재생·정산은 허용되지 않습니다.'});
});
export default router;
