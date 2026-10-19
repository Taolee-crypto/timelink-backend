/**
 * TimeLink TL3 V5 — MP3-preserving, whole-container authenticated encryption.
 * V4/Spine files and routes remain unchanged.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { ensureD1Storage, putD1Object, getD1ObjectMeta, readD1Range } from '../d1-storage';

const router = new Hono<{ Bindings: Env }>();
const te = new TextEncoder();
const td = new TextDecoder();
const MAGIC = new Uint8Array([0x54, 0x4c, 0x4e, 0x4b]);
const MAX_MP3_BYTES = 99 * 1024 * 1024;

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
function readU32(value: Uint8Array, offset: number): number {
  return (((value[offset] << 24) | (value[offset + 1] << 16) | (value[offset + 2] << 8) | value[offset + 3]) >>> 0);
}
function b64u(value: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < value.length; i += 0x8000) raw += String.fromCharCode(...value.subarray(i, i + 0x8000));
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function unb64u(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}
function randomId(size = 18): string {
  return b64u(crypto.getRandomValues(new Uint8Array(size)));
}
function validPlayerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(value);
}
function validP256Jwk(value: any): boolean {
  return !!value && value.kty === 'EC' && value.crv === 'P-256' &&
    typeof value.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.x) &&
    typeof value.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.y) && !('d' in value);
}
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data)));
}
function hex(data: Uint8Array): string {
  return Array.from(data, n => n.toString(16).padStart(2, '0')).join('');
}
async function userFromRequest(c: any): Promise<number> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!token) return 0;
  const payload = await verifyToken(token, c.env.JWT_SECRET);
  const userId = Number(payload?.sub || 0);
  if (!Number.isSafeInteger(userId) || userId <= 0) return 0;
  const user = await c.env.DB.prepare(
    'SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0'
  ).bind(userId).first();
  return user ? userId : 0;
}
async function ensureV5Tables(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tl3_v5_releases (
      file_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, share_id TEXT NOT NULL,
      object_key TEXT NOT NULL, duration_ms INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
      container_sha256 TEXT NOT NULL, wrapped_content_key TEXT NOT NULL,
      container_bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'sealed',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tl3_v5_share ON tl3_v5_releases(share_id,status);
    CREATE TABLE IF NOT EXISTS tl3_player_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, player_id TEXT NOT NULL,
      public_jwk TEXT NOT NULL, key_thumbprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, revoked_at TEXT,
      UNIQUE(user_id,player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tl3_player_keys_user_active ON tl3_player_keys(user_id,revoked_at);
    CREATE TABLE IF NOT EXISTS tl3_v5_sessions (
      session_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, file_id INTEGER NOT NULL,
      player_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tl3_v5_sessions_user_file ON tl3_v5_sessions(user_id,file_id,expires_at);
  `);
}

/** Approximate MPEG Layer III duration from frame headers; browser duration is cross-checked separately. */
function mp3FrameDurationMs(data: Uint8Array): number {
  let offset = 0;
  if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    offset = Math.min(data.length, 10 + size + ((data[5] & 0x10) ? 10 : 0));
  }
  const mpeg1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const mpeg2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  let duration = 0, frames = 0, cursor = offset;
  while (cursor + 4 <= data.length) {
    const h = ((data[cursor] << 24) | (data[cursor+1] << 16) | (data[cursor+2] << 8) | data[cursor+3]) >>> 0;
    if ((h >>> 21) !== 0x7ff) { cursor++; continue; }
    const version = (h >>> 19) & 3, layer = (h >>> 17) & 3;
    const bitrateIndex = (h >>> 12) & 15, sampleIndex = (h >>> 10) & 3, padding = (h >>> 9) & 1;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) { cursor++; continue; }
    const rates = version === 3 ? [44100,48000,32000] : version === 2 ? [22050,24000,16000] : [11025,12000,8000];
    const sampleRate = rates[sampleIndex];
    const bitrate = (version === 3 ? mpeg1L3 : mpeg2L3)[bitrateIndex];
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
    if (frameLength < 24 || cursor + frameLength > data.length) break;
    duration += (version === 3 ? 1152 : 576) * 1000 / sampleRate;
    frames++;
    cursor += frameLength;
  }
  if (frames < 10 || !Number.isFinite(duration) || duration <= 0) throw new Error('유효한 MP3 Layer III 프레임을 확인할 수 없습니다.');
  return Math.round(duration);
}

async function masterWrapKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 24) throw new Error('TL3_MASTER_SECRET은 24자 이상이어야 합니다.');
  const digest = await sha256(te.encode(secret));
  return crypto.subtle.importKey('raw', bytes(digest), { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
}
async function wrapAssetKey(secret: string, fileId: number, shareId: string, contentKey: Uint8Array): Promise<string> {
  const key = await masterWrapKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = te.encode('timelink:tl3:v5:asset-key:' + fileId + ':' + shareId);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:aad, tagLength:128 }, key, bytes(contentKey)));
  return b64u(concat(iv, cipher));
}
async function unwrapAssetKey(secret: string, fileId: number, shareId: string, wrapped: string): Promise<Uint8Array> {
  const value = unb64u(wrapped);
  if (value.length !== 60) throw new Error('V5 자산 키 봉투가 손상되었습니다.');
  const key = await masterWrapKey(secret);
  const iv = value.slice(0,12), cipher = value.slice(12);
  const aad = te.encode('timelink:tl3:v5:asset-key:' + fileId + ':' + shareId);
  return new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv, additionalData:aad, tagLength:128 }, key, bytes(cipher)));
}
function resolveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw ? n : null;
}

router.post('/manufacture', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ ok:false, error:'로그인이 필요합니다.' }, 401);
    const form = await c.req.parseBody();
    const sourceFile = form['file'] instanceof File ? form['file'] as File : null;
    let metadata: any = {};
    try { metadata = JSON.parse(String(form['metadata'] || '{}')); } catch { metadata = {}; }
    if (!sourceFile || sourceFile.size <= 0 || sourceFile.size > MAX_MP3_BYTES) {
      return c.json({ ok:false, error:'MP3 원본은 100MB 이하만 지원합니다.' }, 413);
    }
    if (metadata.rights_confirmed !== true) return c.json({ ok:false, error:'저작권 또는 적법한 이용 권한 확인이 필요합니다.' }, 400);
    const fileId = Number(metadata.file_id || 0);
    const shareId = String(metadata.share_id || '');
    const clientDuration = Number(metadata.duration_ms || 0);
    if (!Number.isSafeInteger(fileId) || fileId <= 0 || !shareId || shareId.length > 180 || !Number.isFinite(clientDuration) || clientDuration <= 0) {
      return c.json({ ok:false, error:'file_id, share_id, duration_ms가 필요합니다.' }, 400);
    }
    const file = await c.env.DB.prepare('SELECT id,user_id,title,artist FROM tl_files WHERE id=?').bind(fileId).first<any>();
    if (!file || Number(file.user_id) !== userId) return c.json({ ok:false, error:'본인의 음원만 TL3로 자산화할 수 있습니다.' }, 403);
    const raw = new Uint8Array(await sourceFile.arrayBuffer());
    const frameDuration = mp3FrameDurationMs(raw);
    if (Math.abs(frameDuration - clientDuration) > 3000) {
      return c.json({ ok:false, error:'브라우저 재생시간과 MP3 프레임 분석 결과가 일치하지 않습니다.', code:'MP3_DURATION_MISMATCH', browser_duration_ms:clientDuration, frame_duration_ms:frameDuration }, 422);
    }
    const durationMs = Math.round(clientDuration);
    const masterSecret = String(c.env.TL3_MASTER_SECRET || '');
    if (!masterSecret) return c.json({ ok:false, error:'TL3_MASTER_SECRET is not configured' }, 503);
    await ensureV5Tables(c.env.DB);
    await ensureD1Storage(c.env.DB);

    const sourceHash = hex(await sha256(raw));
    const manifest = {
      profile:'TL3-V5', version:5, file_id:fileId, share_id:shareId,
      creator_id:userId, title:String(metadata.title || file.title || '').slice(0,200),
      artist:String(metadata.artist || file.artist || '').slice(0,200),
      duration_ms:durationMs, tl_required:Math.ceil(durationMs / 1000),
      source_sha256:sourceHash, rights_confirmed:true,
      rights:{ confirmed:true, owner_user_id:userId },
      lp_meta:metadata.lp_license || null,
      created_at:new Date().toISOString()
    };
    const manifestBytes = te.encode(JSON.stringify(manifest));
    const plain = concat(u32(manifestBytes.byteLength), manifestBytes, raw);
    const contentKey = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const bootstrap = {
      profile:'TL3-V5', algorithm:'AES-256-GCM', nonce:b64u(nonce),
      ciphertext_bytes:plain.byteLength + 16
    };
    const bootstrapBytes = te.encode(JSON.stringify(bootstrap));
    const prefix = concat(MAGIC, new Uint8Array([5]), u32(bootstrapBytes.byteLength), bootstrapBytes);
    const cipher = new Uint8Array(await crypto.subtle.encrypt(
      { name:'AES-GCM', iv:nonce, additionalData:bytes(prefix), tagLength:128 },
      await crypto.subtle.importKey('raw', bytes(contentKey), {name:'AES-GCM'}, false, ['encrypt']),
      bytes(plain)
    ));
    const container = concat(prefix, cipher);
    const containerHash = hex(await sha256(container));
    const wrappedKey = await wrapAssetKey(masterSecret, fileId, shareId, contentKey);
    const objectKey = 'tl3/v5/' + fileId + '/' + Date.now() + '-' + randomId(8) + '.tl3';
    await putD1Object(c.env.DB, objectKey, container, 'application/octet-stream', String(file.title || 'asset') + '.tl3');
    await c.env.DB.prepare(`
      INSERT INTO tl3_v5_releases
        (file_id,user_id,share_id,object_key,duration_ms,source_sha256,container_sha256,wrapped_content_key,container_bytes,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'sealed',datetime('now'),datetime('now'))
      ON CONFLICT(file_id) DO UPDATE SET user_id=excluded.user_id,share_id=excluded.share_id,
        object_key=excluded.object_key,duration_ms=excluded.duration_ms,source_sha256=excluded.source_sha256,
        container_sha256=excluded.container_sha256,wrapped_content_key=excluded.wrapped_content_key,
        container_bytes=excluded.container_bytes,status='sealed',updated_at=datetime('now')
    `).bind(fileId,userId,shareId,objectKey,durationMs,sourceHash,containerHash,wrappedKey,container.byteLength).run();
    await c.env.DB.prepare(
      "UPDATE tl_files SET file_type='audio/tl3',stream_url=?,shared=1,shared_to_shareplace=1,updated_at=datetime('now') WHERE id=? AND user_id=?"
    ).bind('https://api.timelink.digital/api/v1/tl3/v5/resolve/' + fileId,fileId,userId).run();
    return c.json({
      ok:true, profile:'TL3-V5', version:5, status:'released',
      file_id:fileId, share_id:shareId, duration_ms:durationMs,
      required_tl:Math.ceil(durationMs/1000), container_bytes:container.byteLength,
      source_sha256:sourceHash, container_sha256:containerHash,
      message:'TL3 V5 암호화 컨테이너 생성 및 저장이 완료되었습니다.'
    });
  } catch (e:any) {
    console.error('[TL3_V5_MANUFACTURE]', e);
    return c.json({ ok:false, error:e?.message || 'TL3 V5 컨테이너 생성 실패' }, 500);
  }
});

router.get('/resolve/:id', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    await ensureV5Tables(c.env.DB);
    const rawId = String(c.req.param('id') || '');
    const numeric = resolveId(rawId);
    const row = numeric
      ? await c.env.DB.prepare("SELECT v.file_id,v.user_id,v.share_id,v.duration_ms,v.container_bytes,v.status,f.title,f.artist FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id WHERE v.file_id=? AND v.status='sealed'").bind(numeric).first<any>()
      : await c.env.DB.prepare("SELECT v.file_id,v.user_id,v.share_id,v.duration_ms,v.container_bytes,v.status,f.title,f.artist FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id WHERE v.share_id=? AND v.status='sealed'").bind(rawId).first<any>();
    if (!row) return c.json({ok:false,error:'TL3 V5 자산을 찾을 수 없습니다.'},404);
    return c.json({ok:true,version:5,profile:'TL3-V5',file_id:Number(row.file_id),share_id:String(row.share_id),
      title:String(row.title||''),artist:String(row.artist||''),duration_ms:Number(row.duration_ms),
      required_tl:Math.ceil(Number(row.duration_ms)/1000),container_bytes:Number(row.container_bytes)});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'TL3 V5 자산 조회 실패'},500); }
});

router.post('/player/register', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    await ensureV5Tables(c.env.DB);
    const body = await c.req.json<any>();
    const playerId = body?.player_id, jwk = body?.public_key;
    if (!validPlayerId(playerId) || !validP256Jwk(jwk)) return c.json({ok:false,error:'Player ID 또는 P-256 공개키 형식이 올바르지 않습니다.'},400);
    await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,ext:true,key_ops:[]},{name:'ECDH',namedCurve:'P-256'},false,[]);
    const canonical = JSON.stringify({crv:'P-256',kty:'EC',x:jwk.x,y:jwk.y});
    const thumb = hex(await sha256(te.encode(canonical)));
    await c.env.DB.prepare(`
      INSERT INTO tl3_player_keys(user_id,player_id,public_jwk,key_thumbprint,created_at,last_used_at,revoked_at)
      VALUES(?,?,?,?,datetime('now'),datetime('now'),NULL)
      ON CONFLICT(user_id,player_id) DO UPDATE SET public_jwk=excluded.public_jwk,
        key_thumbprint=excluded.key_thumbprint,last_used_at=datetime('now'),revoked_at=NULL
    `).bind(userId,playerId,JSON.stringify({kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}),thumb).run();
    return c.json({ok:true,player_id:playerId,key_thumbprint:thumb,algorithm:'ECDH-P256/HKDF-SHA256/AES-256-GCM'});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'Player 키 등록 실패'},500); }
});

router.post('/session-license/:id', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    await ensureV5Tables(c.env.DB);
    const fileId = Number(c.req.param('id'));
    if (!Number.isSafeInteger(fileId) || fileId <= 0) return c.json({ok:false,error:'file_id가 올바르지 않습니다.'},400);
    const body = await c.req.json<any>();
    const playerId = body?.player_id, sessionId = String(body?.session_id || '');
    if (!validPlayerId(playerId) || !/^[A-Za-z0-9_-]{12,128}$/.test(sessionId)) return c.json({ok:false,error:'Player 또는 재생 세션 정보가 올바르지 않습니다.'},400);
    const [player, release, wallet] = await Promise.all([
      c.env.DB.prepare('SELECT public_jwk,key_thumbprint FROM tl3_player_keys WHERE user_id=? AND player_id=? AND revoked_at IS NULL').bind(userId,playerId).first<any>(),
      c.env.DB.prepare("SELECT share_id,wrapped_content_key FROM tl3_v5_releases WHERE file_id=? AND status='sealed'").bind(fileId).first<any>(),
      c.env.DB.prepare('SELECT (CASE WHEN COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0)=0 THEN COALESCE(NULLIF(tl_balance,0),tl,0) ELSE COALESCE(tl_p,0)+COALESCE(tl_a,0)+COALESCE(tl_b,0) END) AS total FROM users WHERE id=? AND is_active=1').bind(userId).first<any>()
    ]);
    if (!player) return c.json({ok:false,code:'PLAYER_KEY_REQUIRED',error:'이 기기에 등록된 TimeLink Player 키가 없습니다.'},403);
    if (!release) return c.json({ok:false,error:'봉인된 TL3 V5 자산을 찾을 수 없습니다.'},404);
    if (Number(wallet?.total || 0) < 1) return c.json({ok:false,code:'TL_INSUFFICIENT',error:'TL이 없어 재생 권한을 발급할 수 없습니다.'},402);
    const masterSecret = String(c.env.TL3_MASTER_SECRET || '');
    if (!masterSecret) return c.json({ok:false,error:'TL3_MASTER_SECRET is not configured'},503);
    const contentKey = await unwrapAssetKey(masterSecret,fileId,String(release.share_id),String(release.wrapped_content_key));
    const publicJwk = JSON.parse(String(player.public_jwk));
    const memberPublic = await crypto.subtle.importKey('jwk',publicJwk,{name:'ECDH',namedCurve:'P-256'},false,[]);
    const ephemeral = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']) as CryptoKeyPair;
    const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:memberPublic} as any,ephemeral.privateKey,256));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const expiresAt = Math.floor(Date.now()/1000)+21600;
    const infoText = ['timelink:tl3:v5:player-session:v1',userId,playerId,fileId,String(release.share_id),sessionId,expiresAt].join(':');
    const hkdf = await crypto.subtle.importKey('raw',bytes(shared),'HKDF',false,['deriveKey']);
    const wrapKey = await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:bytes(salt),info:te.encode(infoText)},hkdf,{name:'AES-GCM',length:256},false,['encrypt']);
    const thumb = String(player.key_thumbprint || '');
    const wrapped = new Uint8Array(await crypto.subtle.encrypt(
      {name:'AES-GCM',iv:bytes(nonce),additionalData:te.encode(infoText+':'+thumb),tagLength:128},
      wrapKey,bytes(contentKey)
    ));
    const ephemeralPublic = await crypto.subtle.exportKey('jwk',ephemeral.publicKey) as JsonWebKey;
    await c.env.DB.prepare('INSERT OR REPLACE INTO tl3_v5_sessions(session_id,user_id,file_id,player_id,expires_at) VALUES(?,?,?,?,?)')
      .bind(sessionId,userId,fileId,playerId,expiresAt).run();
    await c.env.DB.prepare("UPDATE tl3_player_keys SET last_used_at=datetime('now') WHERE user_id=? AND player_id=?").bind(userId,playerId).run();
    return c.json({ok:true,version:1,algorithm:'ECDH-P256/HKDF-SHA256/AES-256-GCM',
      player_id:playerId,user_id:userId,file_id:fileId,share_id:String(release.share_id),session_id:sessionId,
      expires_at:expiresAt,salt:b64u(salt),nonce:b64u(nonce),
      ephemeral_public_key:{kty:'EC',crv:'P-256',x:ephemeralPublic.x,y:ephemeralPublic.y},
      wrapped_license:b64u(wrapped),aad_thumbprint:thumb});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'TL3 V5 세션 라이선스 발급 실패'},500); }
});

router.get('/container/:id', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    await ensureV5Tables(c.env.DB);
    const fileId = Number(c.req.param('id'));
    const sessionId = String(c.req.query('session_id') || '');
    if (!Number.isSafeInteger(fileId) || fileId <= 0 || !/^[A-Za-z0-9_-]{12,128}$/.test(sessionId)) return c.json({ok:false,error:'자산 또는 세션 정보가 올바르지 않습니다.'},400);
    const session = await c.env.DB.prepare('SELECT session_id FROM tl3_v5_sessions WHERE session_id=? AND user_id=? AND file_id=? AND expires_at>?')
      .bind(sessionId,userId,fileId,Math.floor(Date.now()/1000)).first();
    if (!session) return c.json({ok:false,error:'유효한 V5 Player 세션이 없습니다.'},403);
    const release = await c.env.DB.prepare("SELECT object_key,container_bytes FROM tl3_v5_releases WHERE file_id=? AND status='sealed'").bind(fileId).first<any>();
    if (!release) return c.json({ok:false,error:'TL3 V5 컨테이너를 찾을 수 없습니다.'},404);
    const meta = await getD1ObjectMeta(c.env.DB,String(release.object_key));
    if (!meta || meta.size !== Number(release.container_bytes)) return c.json({ok:false,error:'TL3 V5 컨테이너 저장 상태가 올바르지 않습니다.'},409);
    const container = await readD1Range(c.env.DB,String(release.object_key),0,meta.size);
    return new Response(container,{status:200,headers:{
      'Content-Type':'application/octet-stream','Content-Length':String(container.byteLength),
      'Cache-Control':'private, no-store','X-TL3-Version':'5'
    }});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'TL3 V5 컨테이너 조회 실패'},500); }
});

router.get('/verify/:id', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
    await ensureV5Tables(c.env.DB);
    const fileId = Number(c.req.param('id'));
    const row = await c.env.DB.prepare("SELECT user_id,object_key,container_bytes,container_sha256,status FROM tl3_v5_releases WHERE file_id=?").bind(fileId).first<any>();
    if (!row) return c.json({ok:false,error:'TL3 V5 자산을 찾을 수 없습니다.'},404);
    if (Number(row.user_id) !== userId) return c.json({ok:false,error:'본인 자산만 검증할 수 있습니다.'},403);
    const meta = await getD1ObjectMeta(c.env.DB,String(row.object_key));
    if (!meta || meta.size !== Number(row.container_bytes)) return c.json({ok:true,valid:false,reason:'컨테이너 크기 불일치'});
    const container = await readD1Range(c.env.DB,String(row.object_key),0,meta.size);
    const hash = hex(await sha256(container));
    const prefixOk = container.length > 9 && MAGIC.every((v,i)=>container[i]===v) && container[4]===5;
    return c.json({ok:true,valid:prefixOk && hash===String(row.container_sha256),version:5,
      file_id:fileId,container_bytes:container.length,container_sha256:hash});
  } catch(e:any) { return c.json({ok:false,error:e?.message||'TL3 V5 무결성 검증 실패'},500); }
});

export default router;
