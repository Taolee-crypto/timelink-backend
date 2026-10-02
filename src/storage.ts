import type { Env, JWTPayload } from './types';

type Provider = 'google_drive' | 'onedrive';
type ConnectionRow = {
  id:number; user_id:number; provider:Provider; provider_account_id:string|null;
  provider_email:string|null; provider_name:string|null; access_token:string;
  refresh_token:string|null; expires_at:number; root_id:string|null; status:string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes:Uint8Array):string {
  let s=''; for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64u(s:string):Uint8Array {
  const x=s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4);
  const bin=atob(x); return Uint8Array.from(bin,c=>c.charCodeAt(0));
}
async function cryptoKey(secret:string):Promise<CryptoKey>{
  const h=await crypto.subtle.digest('SHA-256',enc.encode(secret));
  return crypto.subtle.importKey('raw',h,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function seal(value:string,secret:string):Promise<string>{
  if(!secret) throw new Error('STORAGE_ENCRYPTION_KEY secret가 필요합니다.');
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await cryptoKey(secret);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(value)));
  return b64u(iv)+'.'+b64u(ct);
}
async function open(value:string,secret:string):Promise<string>{
  if(!secret) throw new Error('STORAGE_ENCRYPTION_KEY secret가 필요합니다.');
  const [iv,ct]=value.split('.'); const key=await cryptoKey(secret);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64u(iv)},key,unb64u(ct));
  return dec.decode(pt);
}

function cfg(env:Env,p:Provider){
  if(p==='google_drive') return {
    clientId:env.GOOGLE_CLIENT_ID, clientSecret:env.GOOGLE_CLIENT_SECRET,
    redirect:env.GOOGLE_REDIRECT_URI || 'https://api.timelink.digital/api/storage/oauth/google_drive/callback',
    authorize:'https://accounts.google.com/o/oauth2/v2/auth',
    token:'https://oauth2.googleapis.com/token',
    scope:'https://www.googleapis.com/auth/drive.file',
  };
  return {
    clientId:env.ONEDRIVE_CLIENT_ID, clientSecret:env.ONEDRIVE_CLIENT_SECRET,
    redirect:env.ONEDRIVE_REDIRECT_URI || 'https://api.timelink.digital/api/storage/oauth/onedrive/callback',
    authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:'Files.ReadWrite.AppFolder offline_access openid profile',
  };
}

export async function ensureStorageTables(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS storage_connections(
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,provider TEXT NOT NULL,
    provider_account_id TEXT,provider_email TEXT,provider_name TEXT,
    access_token TEXT NOT NULL,refresh_token TEXT,expires_at INTEGER NOT NULL DEFAULT 0,
    root_id TEXT,status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')),
    UNIQUE(user_id,provider)
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS storage_oauth_states(
    state TEXT PRIMARY KEY,user_id INTEGER NOT NULL,provider TEXT NOT NULL,
    expires_at INTEGER NOT NULL,created_at TEXT DEFAULT(datetime('now'))
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS storage_objects(
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,connection_id INTEGER NOT NULL,
    provider TEXT NOT NULL,provider_object_id TEXT NOT NULL,name TEXT NOT NULL,
    mime_type TEXT,size INTEGER DEFAULT 0,content_hash TEXT,provider_etag TEXT,
    status TEXT NOT NULL DEFAULT 'active',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')),
    UNIQUE(connection_id,provider_object_id)
  )`).run();
}

async function connection(db:D1Database,env:Env,userId:number,provider:Provider):Promise<{row:ConnectionRow;access:string}>{
  await ensureStorageTables(db);
  const row=await db.prepare('SELECT * FROM storage_connections WHERE user_id=? AND provider=? AND status=\'active\'').bind(userId,provider).first<ConnectionRow>();
  if(!row) throw new Error('연결된 저장소가 없습니다.');
  let access=await open(row.access_token,env.STORAGE_ENCRYPTION_KEY||'');
  if(row.expires_at>Math.floor(Date.now()/1000)+60) return {row,access};
  if(!row.refresh_token) return {row,access};
  const cc=cfg(env,provider);
  const p=new URLSearchParams({client_id:cc.clientId||'',client_secret:cc.clientSecret||'',grant_type:'refresh_token',refresh_token:await open(row.refresh_token,env.STORAGE_ENCRYPTION_KEY||''),redirect_uri:cc.redirect});
  const tr=await fetch(cc.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p});
  if(!tr.ok) throw new Error('저장소 토큰 갱신 실패');
  const tj=await tr.json<any>();
  access=String(tj.access_token||'');
  const expires= Math.floor(Date.now()/1000)+Number(tj.expires_in||3600);
  const sealedAccess=await seal(access,env.STORAGE_ENCRYPTION_KEY||'');
  await db.prepare('UPDATE storage_connections SET access_token=?,expires_at=?,updated_at=datetime(\'now\') WHERE id=?')
    .bind(sealedAccess,expires,row.id).run();
  return {row:{...row,expires_at:expires,access_token:sealedAccess},access};
}

export function storageAuthUrl(env:Env,userId:number,provider:Provider,state:string){
  const cc=cfg(env,provider);
  if(!cc.clientId||!cc.clientSecret) throw new Error(provider+' OAuth 설정이 없습니다.');
  const u=new URL(cc.authorize);
  u.searchParams.set('client_id',cc.clientId);u.searchParams.set('redirect_uri',cc.redirect);
  u.searchParams.set('response_type','code');u.searchParams.set('scope',cc.scope);
  u.searchParams.set('state',state);u.searchParams.set('access_type','offline');
  u.searchParams.set('prompt','consent');
  if(provider==='onedrive'){u.searchParams.delete('access_type');u.searchParams.delete('prompt');}
  return u.toString();
}

export async function beginStorageConnect(db:D1Database,env:Env,userId:number,provider:Provider){
  await ensureStorageTables(db);
  const state=b64u(crypto.getRandomValues(new Uint8Array(24)));
  await db.prepare('INSERT INTO storage_oauth_states(state,user_id,provider,expires_at) VALUES(?,?,?,?)')
    .bind(state,userId,provider,Math.floor(Date.now()/1000)+600).run();
  return storageAuthUrl(env,userId,provider,state);
}

export async function finishStorageConnect(db:D1Database,env:Env,provider:Provider,code:string,state:string){
  await ensureStorageTables(db);
  const s=await db.prepare('SELECT * FROM storage_oauth_states WHERE state=? AND provider=?').bind(state,provider).first<any>();
  if(!s||Number(s.expires_at)<Math.floor(Date.now()/1000)) throw new Error('OAuth 상태가 만료되었습니다.');
  await db.prepare('DELETE FROM storage_oauth_states WHERE state=?').bind(state).run();
  const cc=cfg(env,provider);
  const p=new URLSearchParams({code,client_id:cc.clientId||'',client_secret:cc.clientSecret||'',redirect_uri:cc.redirect,grant_type:'authorization_code'});
  const tr=await fetch(cc.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p});
  if(!tr.ok) throw new Error('OAuth 토큰 교환 실패');
  const tj=await tr.json<any>();
  const access=String(tj.access_token||''); if(!access) throw new Error('access_token이 없습니다.');
  const refresh=String(tj.refresh_token||'');
  let accountId='',email='',name='',rootId='';
  if(provider==='google_drive'){
    const ar=await fetch('https://www.googleapis.com/drive/v3/about?fields=user(id,emailAddress,displayName)',{headers:{Authorization:'Bearer '+access}});
    if(!ar.ok) throw new Error('Google Drive 계정 확인 실패');
    const a=await ar.json<any>(); accountId=String(a.user?.id||'');email=String(a.user?.emailAddress||'');name=String(a.user?.displayName||'');
    const fr=await fetch('https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType)&q='+encodeURIComponent("name='TimeLink' and mimeType='application/vnd.google-apps.folder' and trashed=false"),{headers:{Authorization:'Bearer '+access}});
    const fj=await fr.json<any>(); rootId=String(fj.files?.[0]?.id||'');
    if(!rootId){
      const cr=await fetch('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify({name:'TimeLink',mimeType:'application/vnd.google-apps.folder'})});
      if(!cr.ok) throw new Error('Google Drive TimeLink 폴더 생성 실패');
      rootId=String((await cr.json<any>()).id||'');
    }
  }else{
    const ar=await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',{headers:{Authorization:'Bearer '+access}});
    if(!ar.ok) throw new Error('OneDrive 계정 확인 실패');
    const a=await ar.json<any>();accountId=String(a.id||'');email=String(a.mail||a.userPrincipalName||'');name=String(a.displayName||'');
    const rr=await fetch('https://graph.microsoft.com/v1.0/me/drive/special/approot',{headers:{Authorization:'Bearer '+access}});
    if(!rr.ok) throw new Error('OneDrive App Folder 접근 실패');
    rootId=String((await rr.json<any>()).id||'');
  }
  const ea=await seal(access,env.STORAGE_ENCRYPTION_KEY||''),er=refresh?await seal(refresh,env.STORAGE_ENCRYPTION_KEY||''):null;
  const exp=Math.floor(Date.now()/1000)+Number(tj.expires_in||3600);
  await db.prepare(`INSERT INTO storage_connections(user_id,provider,provider_account_id,provider_email,provider_name,access_token,refresh_token,expires_at,root_id,status)
    VALUES(?,?,?,?,?,?,?,?,?,'active') ON CONFLICT(user_id,provider) DO UPDATE SET provider_account_id=excluded.provider_account_id,provider_email=excluded.provider_email,provider_name=excluded.provider_name,access_token=excluded.access_token,refresh_token=COALESCE(excluded.refresh_token,storage_connections.refresh_token),expires_at=excluded.expires_at,root_id=excluded.root_id,status='active',updated_at=datetime('now')`)
    .bind(s.user_id,provider,accountId,email,name,ea,er,exp,rootId).run();
  return {userId:Number(s.user_id),provider,email,name};
}

export async function createUploadSession(db:D1Database,env:Env,userId:number,provider:Provider,name:string,size:number,mime:string,origin:string=''){
  const {row,access}=await connection(db,env,userId,provider);
  let uploadUrl='',expiresAt='';
  if(provider==='google_drive'){
    const u='https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
    const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json','X-Upload-Content-Type':mime,'X-Upload-Content-Length':String(size),...(origin?{Origin:origin}:{})},body:JSON.stringify({name,parents:row.root_id?[row.root_id]:undefined})});
    if(!r.ok) throw new Error('Google Drive 업로드 세션 생성 실패');
    uploadUrl=r.headers.get('Location')||''; expiresAt=new Date(Date.now()+3600000).toISOString();
  }else{
    const path=encodeURIComponent(name);
    const u=`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${path}:/createUploadSession`;
    const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify({item:{'@microsoft.graph.conflictBehavior':'rename',name}})});
    if(!r.ok) throw new Error('OneDrive 업로드 세션 생성 실패');
    const j=await r.json<any>();uploadUrl=String(j.uploadUrl||'');expiresAt=String(j.expirationDateTime||'');
  }
  return {connectionId:row.id,provider,uploadUrl,expiresAt,size,name,mime};
}

export async function registerObject(db:D1Database,userId:number,connectionId:number,provider:Provider,objectId:string,name:string,mime:string,size:number,hash?:string){
  await ensureStorageTables(db);
  const c=await db.prepare('SELECT id FROM storage_connections WHERE id=? AND user_id=? AND provider=? AND status=\'active\'').bind(connectionId,userId,provider).first();
  if(!c) throw new Error('저장소 연결을 확인할 수 없습니다.');
  const r=await db.prepare(`INSERT INTO storage_objects(user_id,connection_id,provider,provider_object_id,name,mime_type,size,content_hash)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,provider_object_id) DO UPDATE SET name=excluded.name,mime_type=excluded.mime_type,size=excluded.size,content_hash=excluded.content_hash,updated_at=datetime('now') RETURNING id`)
    .bind(userId,connectionId,provider,objectId,name,mime,size,hash||null).first<any>();
  return r?.id;
}

export async function finalizeUpload(db:D1Database,env:Env,userId:number,connectionId:number,provider:Provider,name:string){
  await ensureStorageTables(db);
  const row=await db.prepare("SELECT * FROM storage_connections WHERE id=? AND user_id=? AND provider=? AND status='active'").bind(connectionId,userId,provider).first<ConnectionRow>();
  if(!row) throw new Error('저장소 연결을 확인할 수 없습니다.');
  const access=await open(row.access_token,env.STORAGE_ENCRYPTION_KEY||'');
  let item:any=null;
  if(provider==='google_drive'){
    const q="name='"+name.replace(/'/g,"\\'")+"' and '"+String(row.root_id||'')+"' in parents and trashed=false";
    const r=await fetch('https://www.googleapis.com/drive/v3/files?orderBy='+encodeURIComponent('createdTime desc')+'&pageSize=1&fields=files(id,name,mimeType,size,md5Checksum,modifiedTime)&q='+encodeURIComponent(q),{headers:{Authorization:'Bearer '+access}});
    if(!r.ok) throw new Error('Google Drive 파일 확인 실패');
    item=(await r.json<any>()).files?.[0];
  }else{
    const r=await fetch('https://graph.microsoft.com/v1.0/me/drive/special/approot:/'+encodeURIComponent(name)+'?$select=id,name,size,file,eTag', {headers:{Authorization:'Bearer '+access}});
    if(!r.ok) throw new Error('OneDrive 파일 확인 실패');
    item=await r.json<any>();
  }
  if(!item?.id) throw new Error('업로드된 파일을 찾지 못했습니다.');
  return {objectId:String(item.id),name:String(item.name||name),mime:String(item.mimeType||item.file?.mimeType||'application/octet-stream'),size:Number(item.size||0),etag:String(item.etag||'')};
}

export async function getObject(db:D1Database,env:Env,objectId:number){
  await ensureStorageTables(db);
  const o=await db.prepare('SELECT * FROM storage_objects WHERE id=? AND status=\'active\'').bind(objectId).first<any>();
  if(!o) return null;
  const {access}=await connection(db,env,Number(o.user_id),o.provider as Provider);
  return {o,access};
}

export async function externalStream(db:D1Database,env:Env,objectId:number,range:string){
  const x=await getObject(db,env,objectId); if(!x) throw new Error('외부 저장 파일 없음');
  const {o,access}=x;
  if(o.provider==='google_drive'){
    const r=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(o.provider_object_id)+'?alt=media',{headers:{Authorization:'Bearer '+access,...(range?{Range:range}:{})}});
    return r;
  }
  const r=await fetch('https://graph.microsoft.com/v1.0/me/drive/items/'+encodeURIComponent(o.provider_object_id)+'?$select=id,@microsoft.graph.downloadUrl',{headers:{Authorization:'Bearer '+access}});
  if(!r.ok) return r;
  const j=await r.json<any>(),u=String(j['@microsoft.graph.downloadUrl']||'');
  if(!u) return new Response('download URL 없음',{status:502});
  return fetch(u,range?{headers:{Range:range}}:undefined);
}

export async function disconnectStorage(db:D1Database,userId:number,provider:Provider){
  await ensureStorageTables(db);
  await db.prepare('UPDATE storage_connections SET status=\'revoked\',updated_at=datetime(\'now\') WHERE user_id=? AND provider=?').bind(userId,provider).run();
}
