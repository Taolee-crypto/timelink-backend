// TL3 per-player, per-session license wrapping (additive; V4 ciphertext format unchanged).
import { Hono } from 'hono';
import type { Env } from './types';
import { verifyToken } from './auth';
import { deriveLicenseBytes, hex } from './tl3v3';

const router = new Hono<{ Bindings: Env }>();
const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function randomId(bytes = 18): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
function validPlayerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(value);
}
function validP256Jwk(value: any): boolean {
  return !!value && value.kty === 'EC' && value.crv === 'P-256' &&
    typeof value.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.x) &&
    typeof value.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.y) &&
    !('d' in value);
}
async function userFromRequest(c: any): Promise<number> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!token) return 0;
  const payload = await verifyToken(token, c.env.JWT_SECRET);
  const userId = Number(payload?.sub || 0);
  if (!Number.isSafeInteger(userId) || userId <= 0) return 0;
  const user = await c.env.DB.prepare(
    'SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0'
  ).bind(userId).first<any>();
  return user ? userId : 0;
}

router.post('/register', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401);
    const body = await c.req.json<any>();
    const playerId = body?.player_id;
    const jwk = body?.public_key;
    if (!validPlayerId(playerId) || !validP256Jwk(jwk)) {
      return c.json({ ok: false, error: '플레이어 ID 또는 P-256 공개키 형식이 올바르지 않습니다.' }, 400);
    }
    // Import once to reject malformed/off-curve public keys before storing them.
    await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true, key_ops: [] },
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
    const thumb = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(canonical))));
    await c.env.DB.prepare(`
      INSERT INTO tl3_player_keys (user_id, player_id, public_jwk, key_thumbprint, created_at, last_used_at, revoked_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
      ON CONFLICT(user_id, player_id) DO UPDATE SET
        public_jwk=excluded.public_jwk,
        key_thumbprint=excluded.key_thumbprint,
        last_used_at=datetime('now'),
        revoked_at=NULL
    `).bind(userId, playerId, JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }), thumb).run();
    return c.json({ ok: true, player_id: playerId, key_thumbprint: thumb, algorithm: 'ECDH-P256/HKDF-SHA256/AES-256-GCM' });
  } catch (e: any) {
    console.error('[TL3_PLAYER_REGISTER]', e);
    return c.json({ ok: false, error: e?.message || '플레이어 키 등록 실패' }, 500);
  }
});

router.post('/session-license/:id', async (c) => {
  try {
    const userId = await userFromRequest(c);
    if (!userId) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401);
    const fileId = Number(c.req.param('id'));
    if (!Number.isSafeInteger(fileId) || fileId <= 0 || String(fileId) !== c.req.param('id')) {
      return c.json({ ok: false, error: '잘못된 file_id입니다.' }, 400);
    }
    const body = await c.req.json<any>();
    const playerId = body?.player_id;
    if (!validPlayerId(playerId)) return c.json({ ok: false, error: '등록된 플레이어 ID가 필요합니다.' }, 400);
    const player = await c.env.DB.prepare(
      'SELECT public_jwk,key_thumbprint FROM tl3_player_keys WHERE user_id=? AND player_id=? AND revoked_at IS NULL'
    ).bind(userId, playerId).first<any>();
    if (!player) return c.json({ ok: false, code: 'PLAYER_KEY_REQUIRED', error: '이 기기에 등록된 TimeLink Player 키가 없습니다.' }, 403);
    const release = await c.env.DB.prepare(
      "SELECT segment_count,share_id FROM tl3_spine_v4_releases WHERE file_id=? AND status='sealed' LIMIT 1"
    ).bind(fileId).first<any>();
    if (!release) return c.json({ ok: false, error: '봉인된 TL3 V4 자산을 찾을 수 없습니다.' }, 404);
    const segmentCount = Number(release.segment_count || 0);
    if (segmentCount < 1) return c.json({ ok: false, error: 'TL3 세그먼트 정보가 올바르지 않습니다.' }, 409);
    const masterSecret = c.env.TL3_MASTER_SECRET;
    if (!masterSecret) return c.json({ ok: false, error: 'TL3_MASTER_SECRET is not configured' }, 503);

    const publicJwk = JSON.parse(String(player.public_jwk));
    const memberPublic = await crypto.subtle.importKey('jwk', publicJwk,
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    ) as CryptoKeyPair;
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: memberPublic }, ephemeral.privateKey, 256
    ));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const requestedSessionId = String(body?.session_id || '');
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestedSessionId)) {
      return c.json({ ok: false, error: '재생 세션 ID 형식이 올바르지 않습니다.' }, 400);
    }
    const sessionId = requestedSessionId;
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const infoText = ['timelink:tl3:player-session:v1', userId, playerId, fileId, String(release.share_id), sessionId, expiresAt].join(':');
    const info = te.encode(infoText);
    const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info }, hkdf,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const license = await deriveLicenseBytes(masterSecret, String(release.share_id || ('tl3_' + fileId)));
    const aad = te.encode(infoText + ':' + String(player.key_thumbprint));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, wrapKey, license
    ));
    const ephemeralPublic = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
    await c.env.DB.prepare(
      "UPDATE tl3_player_keys SET last_used_at=datetime('now') WHERE user_id=? AND player_id=?"
    ).bind(userId, playerId).run();
    return c.json({
      ok: true, version: 1, algorithm: 'ECDH-P256/HKDF-SHA256/AES-256-GCM',
      player_id: playerId, user_id: userId, file_id: fileId, session_id: sessionId,
      expires_at: expiresAt, salt: b64url(salt), nonce: b64url(nonce),
      ephemeral_public_key: { kty: 'EC', crv: 'P-256', x: ephemeralPublic.x, y: ephemeralPublic.y },
      wrapped_license: b64url(wrapped), aad_thumbprint: String(player.key_thumbprint)
    });
  } catch (e: any) {
    console.error('[TL3_SESSION_LICENSE]', e);
    return c.json({ ok: false, error: e?.message || '세션 라이선스 발급 실패' }, 500);
  }
});

export default router;
