/**
 * TLD SCORE V5: the same TLNK/V5 AES-256-GCM framing technology as TL3 V5.
 *
 * An A4 score is *structured music notation* inside an encrypted TLD asset,
 * not a distributed PDF. File ownership alone never grants viewing rights.
 * The Viewer must obtain a server-authenticated LOVE CODE/short-lived session
 * and the existing TL3 P-256 player license transport before opening.
 *
 * This file is a codec and server proof contract, NOT a public issuance route.
 * Callers must enforce creator approval, registered asset state, license,
 * signed/bound viewer identity and one-time challenge consumption in D1.
 * Never put master keys or decrypted document bytes in client logs.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const MAGIC = new Uint8Array([0x54, 0x4c, 0x4e, 0x4b]); // TLNK
const VERSION = 5;
const MAX_SCORE_BYTES = 2 * 1024 * 1024;
const PROFILE = 'TLD-V5';
const ALGO = 'AES-256-GCM';

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
function combine(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {out.set(part, offset); offset += part.length;}
  return out;
}
function uint32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw Error('TLD_INVALID_LENGTH');
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
function readUint32(value: Uint8Array, position: number): number {
  if (position < 0 || position + 4 > value.length) throw Error('TLD_TRUNCATED');
  return ((value[position] << 24) | (value[position + 1] << 16) |
    (value[position + 2] << 8) | value[position + 3]) >>> 0;
}
function b64url(value: Uint8Array): string {
  let raw = '';
  for (const number of value) raw += String.fromCharCode(number);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromB64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('TLD_INVALID_ENCODING');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}
async function sha256(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(value)));
  return Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('');
}
function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw Error('TLD_CONTENT_KEY_REQUIRED');
}
export interface TldScoreManifest {
  profile: 'TLD-V5';
  content_type: 'score';
  asset_id: string;
  version: number;
  source_tl3_file_id: number;
  source_tl3_sha256: string;
  owner_id: number;
  title: string;
  rights_confirmed: true;
  score_revision: string;
  page: {paper: 'A4'; orientation: 'portrait'};
  lyrics_review_required: boolean;
  notation_codec: 'timelink-scoredata-v1';
}
function validateManifest(value: TldScoreManifest): void {
  if (!value || value.profile !== PROFILE || value.content_type !== 'score' || value.version !== VERSION ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(value.asset_id) ||
    !Number.isSafeInteger(value.owner_id) || value.owner_id <= 0 ||
    !Number.isSafeInteger(value.source_tl3_file_id) || value.source_tl3_file_id <= 0 ||
    !/^[0-9a-f]{64}$/.test(value.source_tl3_sha256) ||
    typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 200 ||
    value.rights_confirmed !== true || typeof value.score_revision !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(value.score_revision) ||
    value.page?.paper !== 'A4' || value.page.orientation !== 'portrait' ||
    typeof value.lyrics_review_required !== 'boolean' ||
    value.notation_codec !== 'timelink-scoredata-v1')
    throw Error('TLD_MANIFEST_INVALID');
}
function validateScore(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('TLD_SCORE_INVALID');
  const score = payload as Record<string, unknown>;
  if (score.part !== 'lead_vocal' || !Array.isArray(score.melody) ||
    score.melody.length < 1 || score.melody.length > 20000 ||
    (score.chords !== undefined && !Array.isArray(score.chords)) ||
    (score.lyrics_words !== undefined && !Array.isArray(score.lyrics_words)))
    throw Error('TLD_SCORE_INVALID');
  let end = 0;
  for (const note of score.melody) {
    if (typeof note !== 'object' || note === null) throw Error('TLD_SCORE_INVALID');
    const n = note as Record<string, unknown>;
    if (typeof n.s !== 'number' || !Number.isFinite(n.s) || n.s < end - 0.03 ||
      typeof n.d !== 'number' || !Number.isFinite(n.d) || n.d <= 0 ||
      typeof n.m !== 'number' || !Number.isInteger(n.m) || n.m < 21 || n.m > 108)
      throw Error('TLD_SCORE_INVALID');
    end = n.s + n.d;
  }
}
/** Same bytes as TL3 V5: TLNK | 0x05 | u32(header size) | header JSON | AES-GCM ciphertext. */
export async function sealTldScore(
  score: unknown, manifest: TldScoreManifest, contentKey: Uint8Array,
  nonce: Uint8Array
): Promise<{container: Uint8Array; sha256: string}> {
  validateManifest(manifest);
  validateScore(score);
  assertKey(contentKey);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) throw Error('TLD_NONCE_REQUIRED');
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const scoreBytes = encoder.encode(JSON.stringify(score));
  if (scoreBytes.byteLength > MAX_SCORE_BYTES || manifestBytes.length > 65536)
    throw Error('TLD_SCORE_TOO_LARGE');
  const plaintext = combine(uint32(manifestBytes.length), manifestBytes, scoreBytes);
  const bootstrap = encoder.encode(JSON.stringify({
    profile: PROFILE, content_type: 'score', algorithm: ALGO,
    nonce: b64url(nonce), ciphertext_bytes: plaintext.length + 16
  }));
  const prefix = combine(MAGIC, new Uint8Array([VERSION]), uint32(bootstrap.length), bootstrap);
  const key = await crypto.subtle.importKey('raw', arrayBuffer(contentKey), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {name:'AES-GCM', iv:arrayBuffer(nonce), additionalData:arrayBuffer(prefix), tagLength:128},
    key, arrayBuffer(plaintext)));
  const container = combine(prefix, ciphertext);
  return {container, sha256:await sha256(container)};
}
/**
 * Call ONLY after server LOVE CODE validation + server-granted viewer license.
 * The TLD master unwrap and P-256 license exchange are backend responsibilities.
 */
export async function openLicensedTldScore(
  container: Uint8Array, expectedSha256: string, contentKey: Uint8Array
): Promise<{manifest: TldScoreManifest; score: Record<string, unknown>}> {
  assertKey(contentKey);
  if (!(container instanceof Uint8Array) || container.length < 30 ||
    !MAGIC.every((v, i) => container[i] === v) || container[4] !== VERSION)
    throw Error('TLD_INVALID_MAGIC_VERSION');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || await sha256(container) !== expectedSha256)
    throw Error('TLD_CONTAINER_INTEGRITY_FAILED');
  const bootstrapLen = readUint32(container, 5);
  if (bootstrapLen > 65536 || bootstrapLen < 30 || 9 + bootstrapLen + 16 > container.length)
    throw Error('TLD_INVALID_HEADER_LENGTH');
  const prefix = container.slice(0, 9 + bootstrapLen);
  const bootstrap = JSON.parse(decoder.decode(prefix.slice(9)));
  if (bootstrap.profile !== PROFILE || bootstrap.content_type !== 'score' ||
    bootstrap.algorithm !== ALGO || bootstrap.ciphertext_bytes !== container.length-prefix.length)
    throw Error('TLD_BOOTSTRAP_MISMATCH');
  const nonce = fromB64url(String(bootstrap.nonce));
  if (nonce.length !== 12) throw Error('TLD_INVALID_NONCE');
  const key = await crypto.subtle.importKey('raw', arrayBuffer(contentKey), 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {name:'AES-GCM', iv:arrayBuffer(nonce), additionalData:arrayBuffer(prefix), tagLength:128},
    key, arrayBuffer(container.slice(prefix.length))));
  const length = readUint32(plaintext, 0);
  if (length < 1 || length > 65536 || 4 + length >= plaintext.length ||
    plaintext.length - (4+length) > MAX_SCORE_BYTES) throw Error('TLD_PAYLOAD_INVALID');
  const manifest: TldScoreManifest = JSON.parse(decoder.decode(plaintext.slice(4, 4+length)));
  const score = JSON.parse(decoder.decode(plaintext.slice(4+length)));
  validateManifest(manifest);
  validateScore(score);
  return {manifest, score};
}

export interface LoveCodeBinding {
  asset_id: string;
  container_sha256: string;
  user_id: number;
  viewer_id: string;
  viewer_key_thumbprint: string;
  session_id: string;
  rights_policy_id: string;
  nonce: string;
  expires_at: number;
}
function validateBinding(b: LoveCodeBinding, now: number): void {
  if (!b || !/^[A-Za-z0-9._:-]{1,100}$/.test(b.asset_id) ||
    !/^[0-9a-f]{64}$/.test(b.container_sha256) ||
    !Number.isSafeInteger(b.user_id) || b.user_id <= 0 ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(b.viewer_id) ||
    !/^[0-9a-f]{64}$/.test(b.viewer_key_thumbprint) ||
    !/^[A-Za-z0-9_-]{12,128}$/.test(b.session_id) ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(b.rights_policy_id) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(b.nonce) ||
    !Number.isSafeInteger(b.expires_at) || b.expires_at <= now ||
    b.expires_at > now + 600) throw Error('LOVE_BINDING_INVALID');
}
function canonicalLoveBytes(b: LoveCodeBinding): Uint8Array {
  // Explicit ordered binding; never sign arbitrary JSON property ordering.
  return encoder.encode(JSON.stringify([
    'timelink:tld:love-code:v1', b.asset_id, b.container_sha256,
    b.user_id, b.viewer_id, b.viewer_key_thumbprint, b.session_id,
    b.rights_policy_id, b.nonce, b.expires_at
  ]));
}
async function loveMacKey(existingMasterSecret: string): Promise<CryptoKey> {
  if (typeof existingMasterSecret !== 'string' || existingMasterSecret.length < 24)
    throw Error('TLD_EXISTING_MASTER_REQUIRED');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(existingMasterSecret));
  const hkdf = await crypto.subtle.importKey('raw', digest, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name:'HKDF', hash:'SHA-256',
    salt:encoder.encode('timelink:domain-separated:tld:love-code:v1'),
    info:encoder.encode('timelink:tld:love-code:server-only:v1')
  }, hkdf, {name:'HMAC',hash:'SHA-256',length:256}, false, ['sign','verify']);
}
/** The LOVE CODE is server-issued, not stored in TLD and not a static password. */
export async function issueLoveCode(
  existingMasterSecret: string, binding: LoveCodeBinding, now = Math.floor(Date.now()/1000)
): Promise<string> {
  validateBinding(binding, now);
  const key = await loveMacKey(existingMasterSecret);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, arrayBuffer(canonicalLoveBytes(binding)))));
}
/**
 * Server must additionally consume nonce atomically, confirm D1 asset/version,
 * ownership/rights/session and ensure viewer key has not been revoked.
 */
export async function verifyLoveCode(
  existingMasterSecret: string, binding: LoveCodeBinding, code: string,
  now = Math.floor(Date.now()/1000)
): Promise<boolean> {
  try {
    validateBinding(binding, now);
    const value = fromB64url(code);
    if (value.length !== 32) return false;
    return crypto.subtle.verify('HMAC', await loveMacKey(existingMasterSecret),
      arrayBuffer(value), arrayBuffer(canonicalLoveBytes(binding)));
  } catch {return false;}
}
