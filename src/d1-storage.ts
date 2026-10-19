// R2-free object storage for TimeLink using Cloudflare D1.
// D1 max BLOB/row is 2 MB; 1.5 MB chunks keep a safety margin.
export const D1_OBJECT_CHUNK_SIZE=1_500_000;
export const D1_MAX_OBJECT_SIZE=100*1024*1024;
type ObjectMeta={key:string;size:number;content_type:string;file_name:string;part_count:number;status:string};
export async function ensureD1Storage(db:D1Database):Promise<void>{await db.exec(`CREATE TABLE IF NOT EXISTS tl_d1_objects(object_key TEXT PRIMARY KEY,size INTEGER NOT NULL DEFAULT 0,content_type TEXT NOT NULL DEFAULT 'application/octet-stream',file_name TEXT NOT NULL DEFAULT '',part_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'complete',created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));CREATE TABLE IF NOT EXISTS tl_d1_object_parts(object_key TEXT NOT NULL,part_number INTEGER NOT NULL,data BLOB NOT NULL,size INTEGER NOT NULL,created_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(object_key,part_number));CREATE INDEX IF NOT EXISTS idx_tl_d1_parts_key ON tl_d1_object_parts(object_key,part_number);CREATE TABLE IF NOT EXISTS tl_d1_upload_sessions(upload_id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,object_key TEXT NOT NULL UNIQUE,expected_size INTEGER NOT NULL,expected_content_type TEXT NOT NULL,file_name TEXT NOT NULL,expected_parts INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',manifest_sha256 TEXT DEFAULT '',created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));`);await db.prepare("ALTER TABLE tl_d1_object_parts ADD COLUMN sha256 TEXT DEFAULT ''").run().catch(()=>{});}
export async function initD1Upload(db:D1Database,key:string,fileName:string,totalSize:number,contentType:string):Promise<void>{if(!key||key.length>300)throw new Error('잘못된 저장 키입니다.');if(totalSize<0||totalSize>D1_MAX_OBJECT_SIZE)throw new Error('무료 D1 저장 한도를 초과했습니다.');await db.prepare('DELETE FROM tl_d1_object_parts WHERE object_key=?').bind(key).run();await db.prepare(`INSERT INTO tl_d1_objects(object_key,size,content_type,file_name,part_count,status,updated_at)VALUES(?,?,?,?,0,'uploading',datetime('now'))ON CONFLICT(object_key) DO UPDATE SET size=excluded.size,content_type=excluded.content_type,file_name=excluded.file_name,part_count=0,status='uploading',updated_at=datetime('now')`).bind(key,totalSize,contentType,fileName).run();}
export async function writeD1UploadPart(db:D1Database,key:string,partNumber:number,data:Uint8Array):Promise<void>{if(data.byteLength>D1_OBJECT_CHUNK_SIZE)throw new Error('청크 크기가 저장 한도를 초과했습니다.');await db.prepare('INSERT OR REPLACE INTO tl_d1_object_parts(object_key,part_number,data,size)VALUES(?,?,?,?)').bind(key,partNumber,data,data.byteLength).run();}
export async function completeD1Upload(db:D1Database,key:string):Promise<ObjectMeta>{const metaRow=await db.prepare("SELECT object_key as key,size,content_type,file_name,part_count,status FROM tl_d1_objects WHERE object_key=?").bind(key).first<any>();if(!metaRow)throw new Error('업로드 메타데이터가 없습니다.');const meta:ObjectMeta={key:String(metaRow.key),size:Number(metaRow.size),content_type:String(metaRow.content_type||'application/octet-stream'),file_name:String(metaRow.file_name||''),part_count:Number(metaRow.part_count||0),status:String(metaRow.status)};const n=await db.prepare('SELECT COUNT(*) AS cnt,COALESCE(SUM(size),0) AS total FROM tl_d1_object_parts WHERE object_key=?').bind(key).first<any>();if(Number(n?.cnt||0)<=0)throw new Error('업로드 파트가 없습니다.');if(Number(n?.total||0)!==meta.size)throw new Error(`파일 크기 불일치: expected=${meta.size}, actual=${Number(n?.total||0)}`);await db.prepare("UPDATE tl_d1_objects SET part_count=?,status='complete',updated_at=datetime('now') WHERE object_key=?").bind(Number(n.cnt),key).run();return {...meta,part_count:Number(n.cnt),status:'complete'};}

type D1UploadSessionRow={upload_id:string;owner_id:number;object_key:string;expected_size:number;expected_content_type:string;file_name:string;expected_parts:number;expires_at:number;status:string;manifest_sha256:string};

async function sha256Hex(data:Uint8Array):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',data.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map(v=>v.toString(16).padStart(2,'0')).join('');
}

export async function createD1UploadSession(
  db:D1Database,ownerId:number,uploadId:string,key:string,fileName:string,totalSize:number,contentType:string,ttlSeconds=3600
):Promise<{uploadId:string;key:string;chunkSize:number;totalParts:number;expiresAt:number}>{
  await ensureD1Storage(db);
  if(!Number.isSafeInteger(ownerId)||ownerId<=0) throw new Error('인증 사용자 오류');
  if(!/^[A-Za-z0-9_-]{20,80}$/.test(uploadId)) throw new Error('잘못된 업로드 세션 ID');
  if(!key||key.length>300||!key.startsWith(`tracks/u${ownerId}/`)) throw new Error('업로드 저장 키 소유권 오류');
  if(!Number.isSafeInteger(totalSize)||totalSize<=7||totalSize>D1_MAX_OBJECT_SIZE) throw new Error('TL3 파일 크기가 올바르지 않습니다.');
  if(contentType!=='application/octet-stream') throw new Error('TL3 업로드는 application/octet-stream만 허용됩니다.');
  const safeName=String(fileName||'asset.tl3').replace(/[\\/\\\\\x00-\x1f]/g,'_').slice(0,180);
  const totalParts=Math.ceil(totalSize/D1_OBJECT_CHUNK_SIZE);
  const expiresAt=Math.floor(Date.now()/1000)+Math.max(300,Math.min(ttlSeconds,3600));
  const existing=await db.prepare('SELECT object_key FROM tl_d1_objects WHERE object_key=?').bind(key).first();
  if(existing) throw new Error('이미 존재하는 저장 키입니다. 새 업로드 ID를 사용하세요.');
  await initD1Upload(db,key,safeName,totalSize,contentType);
  await db.prepare("INSERT INTO tl_d1_upload_sessions(upload_id,owner_id,object_key,expected_size,expected_content_type,file_name,expected_parts,expires_at,status) VALUES(?,?,?,?,?,?,?,?,'active')")
    .bind(uploadId,ownerId,key,totalSize,contentType,safeName,totalParts,expiresAt).run();
  return {uploadId,key,chunkSize:D1_OBJECT_CHUNK_SIZE,totalParts,expiresAt};
}

export async function writeD1UploadSessionPart(
  db:D1Database,ownerId:number,uploadId:string,partNumber:number,data:Uint8Array
):Promise<{partNumber:number;size:number;sha256:string;duplicate:boolean}>{
  await ensureD1Storage(db);
  const session=await db.prepare("SELECT * FROM tl_d1_upload_sessions WHERE upload_id=? AND owner_id=?").bind(uploadId,ownerId).first<D1UploadSessionRow>();
  if(!session||session.status!=='active') throw new Error('유효한 업로드 세션이 없습니다.');
  if(Number(session.expires_at)<=Math.floor(Date.now()/1000)) throw new Error('업로드 세션이 만료되었습니다.');
  if(!Number.isSafeInteger(partNumber)||partNumber<1||partNumber>Number(session.expected_parts)) throw new Error('청크 번호가 범위를 벗어났습니다.');
  const expectedSize=Math.min(D1_OBJECT_CHUNK_SIZE,Number(session.expected_size)-(partNumber-1)*D1_OBJECT_CHUNK_SIZE);
  if(data.byteLength!==expectedSize) throw new Error(`청크 크기 불일치: expected=${expectedSize}, actual=${data.byteLength}`);
  const hash=await sha256Hex(data);
  const existing=await db.prepare('SELECT size,sha256 FROM tl_d1_object_parts WHERE object_key=? AND part_number=?').bind(session.object_key,partNumber).first<any>();
  if(existing){
    if(Number(existing.size)===data.byteLength&&String(existing.sha256||'')===hash) return {partNumber,size:data.byteLength,sha256:hash,duplicate:true};
    throw new Error('이미 다른 데이터로 등록된 청크입니다.');
  }
  await db.prepare('INSERT INTO tl_d1_object_parts(object_key,part_number,data,size,sha256) VALUES(?,?,?,?,?)')
    .bind(session.object_key,partNumber,data,data.byteLength,hash).run();
  await db.prepare("UPDATE tl_d1_upload_sessions SET updated_at=datetime('now') WHERE upload_id=?").bind(uploadId).run();
  return {partNumber,size:data.byteLength,sha256:hash,duplicate:false};
}

export async function completeD1UploadSession(
  db:D1Database,ownerId:number,uploadId:string
):Promise<ObjectMeta&{manifest_sha256:string}>{
  await ensureD1Storage(db);
  const session=await db.prepare("SELECT * FROM tl_d1_upload_sessions WHERE upload_id=? AND owner_id=?").bind(uploadId,ownerId).first<D1UploadSessionRow>();
  if(!session) throw new Error('유효한 업로드 세션이 없습니다.');
  if(session.status==='complete'){
    const meta=await getD1ObjectMeta(db,session.object_key);
    if(!meta) throw new Error('완료된 파일 메타데이터가 없습니다.');
    return {...meta,manifest_sha256:String(session.manifest_sha256||'')};
  }
  if(session.status!=='active'||Number(session.expires_at)<=Math.floor(Date.now()/1000)) throw new Error('업로드 세션이 만료되었거나 종료되었습니다.');
  const counts=await db.prepare('SELECT COUNT(*) AS cnt,COALESCE(SUM(size),0) AS total FROM tl_d1_object_parts WHERE object_key=?').bind(session.object_key).first<any>();
  if(Number(counts?.cnt||0)!==Number(session.expected_parts)) throw new Error('청크가 누락되었습니다.');
  const manifest:string[]=[];
  let total=0;
  for(let index=0;index<Number(session.expected_parts);index++){
    const pn=index+1;
    const part=await db.prepare('SELECT part_number,data,size,sha256 FROM tl_d1_object_parts WHERE object_key=? AND part_number=?').bind(session.object_key,pn).first<any>();
    if(!part||Number(part.part_number)!==pn) throw new Error('청크 순서가 연속적이지 않습니다.');
    const bytes=part.data instanceof Uint8Array?part.data:new Uint8Array(part.data as ArrayBuffer);
    const expectedSize=Math.min(D1_OBJECT_CHUNK_SIZE,Number(session.expected_size)-index*D1_OBJECT_CHUNK_SIZE);
    if(bytes.byteLength!==expectedSize||Number(part.size)!==expectedSize) throw new Error('청크 크기 검증에 실패했습니다.');
    if(index===0){
      if(bytes.byteLength<7||bytes[0]!==0x54||bytes[1]!==0x4c||bytes[2]!==0x4e||bytes[3]!==0x4b||bytes[4]!==0x02) throw new Error('TL3 v2 파일 헤더가 아닙니다.');
      const headerLength=(bytes[5]<<8)|bytes[6];
      if(headerLength<=0||7+headerLength>bytes.byteLength) throw new Error('TL3 메타데이터 헤더가 손상되었습니다.');
      let header:any;
      try{header=JSON.parse(new TextDecoder().decode(bytes.slice(7,7+headerLength)));}catch{throw new Error('TL3 메타데이터 JSON이 올바르지 않습니다.');}
      if(String(header.cid||'')!==String(ownerId)) throw new Error('TL3 창작자 ID가 업로드 사용자와 일치하지 않습니다.');
    }
    const actualHash=await sha256Hex(bytes);
    if(!actualHash||actualHash!==String(part.sha256||'')) throw new Error(`청크 해시 검증 실패: part ${pn}`);
    manifest.push(`${pn}:${expectedSize}:${actualHash}`);
    total+=expectedSize;
  }
  if(total!==Number(session.expected_size)||Number(counts?.total||0)!==Number(session.expected_size)) throw new Error('전체 파일 크기 검증에 실패했습니다.');
  const manifestHash=await sha256Hex(new TextEncoder().encode(manifest.join('\n')));
  await db.batch([
    db.prepare("UPDATE tl_d1_objects SET part_count=?,status='complete',updated_at=datetime('now') WHERE object_key=? AND status='uploading'")
      .bind(Number(session.expected_parts),session.object_key),
    db.prepare("UPDATE tl_d1_upload_sessions SET status='complete',manifest_sha256=?,updated_at=datetime('now') WHERE upload_id=? AND owner_id=? AND status='active'")
      .bind(manifestHash,uploadId,ownerId)
  ]);
  const meta=await getD1ObjectMeta(db,session.object_key);
  if(!meta) throw new Error('업로드 완료 처리에 실패했습니다.');
  return {...meta,manifest_sha256:manifestHash};
}

export async function putD1Object(db:D1Database,key:string,data:Uint8Array,contentType='application/octet-stream',fileName=''):Promise<ObjectMeta>{if(data.byteLength>D1_MAX_OBJECT_SIZE)throw new Error('무료 D1 저장 한도(100MB)를 초과했습니다.');await initD1Upload(db,key,fileName||key,data.byteLength,contentType);let batch:D1PreparedStatement[]=[];let p=1;for(let o=0;o<data.byteLength;o+=D1_OBJECT_CHUNK_SIZE){const ch=data.slice(o,Math.min(o+D1_OBJECT_CHUNK_SIZE,data.byteLength));batch.push(db.prepare('INSERT OR REPLACE INTO tl_d1_object_parts(object_key,part_number,data,size)VALUES(?,?,?,?)').bind(key,p++,ch,ch.byteLength));if(batch.length>=40){await db.batch(batch);batch=[];}}if(batch.length)await db.batch(batch);return completeD1Upload(db,key);}
export async function getD1ObjectMeta(db:D1Database,key:string):Promise<ObjectMeta|null>{const r=await db.prepare("SELECT object_key as key,size,content_type,file_name,part_count,status FROM tl_d1_objects WHERE object_key=? AND status='complete'").bind(key).first<any>();return r?{key:String(r.key),size:Number(r.size),content_type:String(r.content_type||'application/octet-stream'),file_name:String(r.file_name||''),part_count:Number(r.part_count||0),status:String(r.status)}:null;}
export async function readD1Range(db:D1Database,key:string,start:number,length:number):Promise<Uint8Array>{const m=await getD1ObjectMeta(db,key);if(!m)throw new Error('파일 없음');const s=Math.max(0,Math.floor(start)),len=Math.max(0,Math.floor(length));if(s>=m.size||len===0)return new Uint8Array();const end=Math.min(m.size,s+len),first=Math.floor(s/D1_OBJECT_CHUNK_SIZE)+1,last=Math.floor((end-1)/D1_OBJECT_CHUNK_SIZE)+1;const rows=await db.prepare('SELECT part_number,data FROM tl_d1_object_parts WHERE object_key=? AND part_number BETWEEN ? AND ? ORDER BY part_number').bind(key,first,last).all<any>();const out=new Uint8Array(end-s);let written=0;for(const row of rows.results||[]){const b=row.data instanceof Uint8Array?row.data:new Uint8Array(row.data as ArrayBuffer),pn=Number(row.part_number),ps=(pn-1)*D1_OBJECT_CHUNK_SIZE,from=Math.max(s,ps),to=Math.min(end,ps+b.byteLength);if(to>from){out.set(b.slice(from-ps,to-ps),from-s);written+=to-from;}}if(written!==out.byteLength)throw new Error('파일 데이터가 불완전합니다.');return out;}

// 2026-10-19: readD1Range 최적화 버전. getD1ObjectMeta 조회를 생략한다.
// segment 라우트에서 이미 meta.size를 알고 있으므로 중복 조회를 제거한다.
// Sealed Spine v4 objects are immutable. Cache their physical D1 chunks at the
// Worker edge so adjacent audio segments do not repeatedly read the same 1.5 MB
// BLOB row from D1. The cache is best-effort; D1 remains the source of truth.
const tl3D1ChunkInflight = new Map<string, Promise<Uint8Array>>();

async function readSealedD1Chunk(
  db: D1Database, key: string, partNumber: number
): Promise<Uint8Array> {
  const cacheRequest = new Request(
    `https://api.timelink.digital/__tl3_d1_cache/${encodeURIComponent(key)}/${partNumber}`
  );
  try {
    const cached = await caches.default.match(cacheRequest);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
  } catch (_) {
    // Cache API can be unavailable in local/test runtimes; fall back to D1.
  }

  const inflightKey = key + ':' + partNumber;
  const pending = tl3D1ChunkInflight.get(inflightKey);
  if (pending) return (await pending).slice();

  const task = (async () => {
    const row = await db.prepare(
      'SELECT data FROM tl_d1_object_parts WHERE object_key=? AND part_number=?'
    ).bind(key, partNumber).first<any>();
    if (!row?.data) throw new Error('파일 데이터 청크를 찾을 수 없습니다.');
    const data = row.data instanceof Uint8Array
      ? row.data.slice()
      : new Uint8Array(row.data as ArrayBuffer);
    try {
      await caches.default.put(
        cacheRequest,
        new Response(data.slice().buffer, {
          headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' }
        })
      );
    } catch (_) {
      // A cache write failure must not interrupt playback.
    }
    return data;
  })();
  tl3D1ChunkInflight.set(inflightKey, task);
  try {
    return (await task).slice();
  } finally {
    if (tl3D1ChunkInflight.get(inflightKey) === task) {
      tl3D1ChunkInflight.delete(inflightKey);
    }
  }
}

// Use only for sealed, immutable Spine v4 containers.
export async function readD1RangeCached(
  db: D1Database, key: string, start: number, end: number
): Promise<Uint8Array> {
  const s = Math.max(0, Math.floor(start));
  const e = Math.max(0, Math.floor(end));
  if (e <= s) return new Uint8Array();
  const first = Math.floor(s / D1_OBJECT_CHUNK_SIZE) + 1;
  const last = Math.floor((e - 1) / D1_OBJECT_CHUNK_SIZE) + 1;
  const out = new Uint8Array(e - s);
  let written = 0;
  for (let part = first; part <= last; part++) {
    const data = await readSealedD1Chunk(db, key, part);
    const partStart = (part - 1) * D1_OBJECT_CHUNK_SIZE;
    const from = Math.max(s, partStart);
    const to = Math.min(e, partStart + data.byteLength);
    if (to > from) {
      out.set(data.subarray(from - partStart, to - partStart), from - s);
      written += to - from;
    }
  }
  if (written !== out.byteLength) throw new Error('파일 데이터가 불완전합니다.');
  return out;
}

export async function readD1RangeFast(
  db: D1Database, key: string, start: number, end: number
): Promise<Uint8Array> {
  const s = Math.max(0, Math.floor(start));
  const e = Math.max(0, Math.floor(end));
  if (e <= s) return new Uint8Array();
  const first = Math.floor(s / D1_OBJECT_CHUNK_SIZE) + 1;
  const last = Math.floor((e - 1) / D1_OBJECT_CHUNK_SIZE) + 1;
  const rows = await db.prepare(
    'SELECT part_number, data FROM tl_d1_object_parts WHERE object_key=? AND part_number BETWEEN ? AND ? ORDER BY part_number'
  ).bind(key, first, last).all<any>();
  const out = new Uint8Array(e - s);
  let written = 0;
  for (const row of rows.results || []) {
    const b = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as ArrayBuffer);
    const pn = Number(row.part_number);
    const ps = (pn - 1) * D1_OBJECT_CHUNK_SIZE;
    const from = Math.max(s, ps);
    const to = Math.min(e, ps + b.byteLength);
    if (to > from) {
      out.set(b.slice(from - ps, to - ps), from - s);
      written += to - from;
    }
  }
  if (written !== out.byteLength) throw new Error('파일 데이터가 불완전합니다.');
  return out;
}