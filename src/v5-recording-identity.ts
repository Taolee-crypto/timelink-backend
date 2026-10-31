export type RecordingDuplicate={
  file_id:number;
  share_id:string;
  matched_by:'source_sha256'|'isrc';
};

export function normalizeIsrc(value:unknown):string{
  const normalized=String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized)?normalized:'';
}

export async function ensureRecordingIdentitySchema(db:D1Database):Promise<void>{
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_recording_identity(
    file_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    share_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    isrc_norm TEXT,
    title_norm TEXT NOT NULL DEFAULT '',
    artist_norm TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_v5_recording_identity_source ON v5_recording_identity(source_sha256)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_v5_recording_identity_isrc ON v5_recording_identity(isrc_norm)').run();
}
function cleanSha(value:unknown):string{
  const v=String(value||'').toLowerCase();return /^[a-f0-9]{64}$/.test(v)?v:'';
}
export async function findRegisteredRecordingDuplicate(db:D1Database,input:{
  sourceSha256?:unknown;isrc?:unknown;excludeFileId?:number|null
}):Promise<RecordingDuplicate|null>{
  await ensureRecordingIdentitySchema(db);
  const exclude=Number.isSafeInteger(Number(input.excludeFileId))&&Number(input.excludeFileId)>0?Number(input.excludeFileId):0;
  const source=cleanSha(input.sourceSha256);
  if(source){
    const indexed=await db.prepare(`SELECT i.file_id,i.share_id FROM v5_recording_identity i
      JOIN tl3_v5_releases v ON v.file_id=i.file_id AND v.status='sealed'
      WHERE i.source_sha256=? AND i.file_id<>? LIMIT 1`).bind(source,exclude).first<any>().catch(()=>null);
    if(indexed)return {file_id:Number(indexed.file_id),share_id:String(indexed.share_id),matched_by:'source_sha256'};
    const historical=await db.prepare(`SELECT v.file_id,v.share_id FROM tl3_v5_releases v
      WHERE v.source_sha256=? AND v.status='sealed' AND v.file_id<>? LIMIT 1`)
      .bind(source,exclude).first<any>().catch(()=>null);
    if(historical)return {file_id:Number(historical.file_id),share_id:String(historical.share_id),matched_by:'source_sha256'};
  }
  const isrc=normalizeIsrc(input.isrc);
  if(isrc){
    const indexed=await db.prepare(`SELECT i.file_id,i.share_id FROM v5_recording_identity i
      JOIN tl3_v5_releases v ON v.file_id=i.file_id AND v.status='sealed'
      WHERE i.isrc_norm=? AND i.file_id<>? LIMIT 1`).bind(isrc,exclude).first<any>().catch(()=>null);
    if(indexed)return {file_id:Number(indexed.file_id),share_id:String(indexed.share_id),matched_by:'isrc'};
    const historical=await db.prepare(`SELECT v.file_id,v.share_id FROM tl_creator_spotify_metadata s
      JOIN tl3_v5_releases v ON v.file_id=s.file_id AND v.status='sealed'
      WHERE UPPER(REPLACE(REPLACE(COALESCE(s.isrc,''),'-',''),' ',''))=? AND v.file_id<>?
      LIMIT 1`).bind(isrc,exclude).first<any>().catch(()=>null);
    if(historical)return {file_id:Number(historical.file_id),share_id:String(historical.share_id),matched_by:'isrc'};
  }
  return null;
}
export async function recordRecordingIdentity(db:D1Database,input:{
  fileId:number;userId:number;shareId:string;sourceSha256:string;isrc?:unknown;title?:unknown;artist?:unknown
}):Promise<void>{
  await ensureRecordingIdentitySchema(db);
  const source=cleanSha(input.sourceSha256);
  if(!Number.isSafeInteger(input.fileId)||input.fileId<=0||!Number.isSafeInteger(input.userId)||input.userId<=0||
     !input.shareId||!source)throw Error('INVALID_RECORDING_IDENTITY');
  const isrc=normalizeIsrc(input.isrc)||null;
  const title=String(input.title||'').trim().toLocaleLowerCase().slice(0,200);
  const artist=String(input.artist||'').trim().toLocaleLowerCase().slice(0,200);
  await db.prepare(`INSERT INTO v5_recording_identity
    (file_id,user_id,share_id,source_sha256,isrc_norm,title_norm,artist_norm)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(file_id) DO UPDATE SET
      user_id=excluded.user_id,share_id=excluded.share_id,source_sha256=excluded.source_sha256,
      isrc_norm=excluded.isrc_norm,title_norm=excluded.title_norm,artist_norm=excluded.artist_norm,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(input.fileId,input.userId,input.shareId,source,isrc,title,artist).run();
}
