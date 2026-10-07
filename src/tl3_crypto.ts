// src/tl3_crypto.ts
// TimeLink TL3 v3 암호 모듈
// 특허 보정서 3.3 (키 계층), 3.4 (타임토큰 HMAC), 3.5 (세그먼트 AEAD) 정합
//
// 설계 원칙 (C안):
//   - 마스터 비밀(TL3_MASTER_SECRET)은 Worker Secret 에만 존재. 파일·클라이언트에 절대 저장 X.
//   - 라이선스 키 = HKDF(master, info="license:"+content_id) → HMAC-SHA-256 (타임토큰 서명용)
//   - 세그먼트 키 = HKDF(master, info="segment:"+content_id+":"+session_id+":"+seg_idx) → AES-256-GCM
//   - Web Crypto 제약(HKDF base 는 HKDF 키만 가능) 을 회피하기 위해
//     "라이선스 → 세그먼트" 유도를 "마스터 → 세그먼트" 로 평탄화.
//     info 에 모든 바인딩(content_id/session_id/segment_index) 을 포함하므로 보안 등가는 유지.

const enc = new TextEncoder();

const HKDF_HASH = 'SHA-256';
const AEAD_ALG = 'AES-GCM';
const AEAD_TAG_BITS = 128;
const NONCE_BYTES = 12;
const KEY_BYTES = 32; // AES-256

// ─────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────
function toU8(b: BufferSource): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

function ascii(s: string): Uint8Array {
  return enc.encode(s);
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// ─────────────────────────────────────────
// 1) 마스터 비밀 import
// ─────────────────────────────────────────
export async function importMasterSecret(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error('TL3_MASTER_SECRET must be at least 16 chars');
  }
  const raw = await crypto.subtle.digest(HKDF_HASH, enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

// ─────────────────────────────────────────
// 2) 라이선스 키 유도 (content_id 바인딩) — HMAC 용
// ─────────────────────────────────────────
export async function deriveLicenseKey(
  master: CryptoKey,
  contentId: number | string
): Promise<CryptoKey> {
  const info = ascii('tl3:license:v3:' + String(contentId));
  const salt = ascii('tl3:salt:content:' + String(contentId));
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}

// ─────────────────────────────────────────
// 3) 세그먼트 키 유도 (content + session + segment 바인딩) — AES-GCM 용
// ─────────────────────────────────────────
export async function deriveSegmentKey(
  master: CryptoKey,
  contentId: number | string,
  sessionId: string,
  segmentIndex: number
): Promise<CryptoKey> {
  const info = ascii(
    'tl3:segment:v3:' + String(contentId) + ':' + sessionId + ':' + segmentIndex
  );
  const salt = ascii('tl3:salt:segment:' + segmentIndex);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    master,
    { name: AEAD_ALG, length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ─────────────────────────────────────────
// 4) AAD 조립 (세션/인가 바인딩)
// ─────────────────────────────────────────
export function buildAAD(
  contentId: number | string,
  sessionId: string,
  segmentIndex: number,
  authorizationId: string
): Uint8Array {
  const s = 'tl3:v3:' + String(contentId) + '|' + sessionId + '|' + segmentIndex + '|' + (authorizationId || '');
  return ascii(s);
}

// ─────────────────────────────────────────
// 5) 세그먼트 암호화 (AEAD)
// ─────────────────────────────────────────
export interface EncryptedSegment {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export async function encryptSegment(
  plain: Uint8Array,
  key: CryptoKey,
  aad: Uint8Array
): Promise<EncryptedSegment> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: AEAD_ALG, iv: nonce, additionalData: aad, tagLength: AEAD_TAG_BITS },
    key,
    plain
  );
  return { nonce, ciphertext: toU8(ct) };
}

// ─────────────────────────────────────────
// 6) 세그먼트 복호화 (AEAD)
// ─────────────────────────────────────────
export async function decryptSegment(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: CryptoKey,
  aad: Uint8Array
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: AEAD_ALG, iv: nonce, additionalData: aad, tagLength: AEAD_TAG_BITS },
    key,
    ciphertext
  );
  return toU8(pt);
}

// ─────────────────────────────────────────
// 7) 타임토큰 체인 (HMAC-SHA-256)
// ─────────────────────────────────────────
export async function deriveTimeToken(
  licenseKey: CryptoKey,
  prevToken: Uint8Array,
  segmentIndex: number,
  durationMs: number,
  contentId: number | string
): Promise<Uint8Array> {
  const input = concat(
    prevToken,
    ascii('|' + String(segmentIndex) + '|' + String(durationMs) + '|' + String(contentId))
  );
  const sig = await crypto.subtle.sign('HMAC', licenseKey, input);
  return toU8(sig);
}

export function initialToken(contentId: number | string): Uint8Array {
  return ascii('tl3:token0:' + String(contentId));
}

// ─────────────────────────────────────────
// 8) 세그먼트 와이어 인코딩/디코딩
// ─────────────────────────────────────────
export function packSegment(seg: EncryptedSegment): Uint8Array {
  return concat(seg.nonce, seg.ciphertext);
}

export function unpackSegment(bytes: Uint8Array, payloadLen: number): EncryptedSegment {
  if (bytes.length < NONCE_BYTES + payloadLen) {
    throw new Error('TL3 v3 segment too short');
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES, NONCE_BYTES + payloadLen);
  return { nonce, ciphertext };
}

export function segmentWireLen(ciphertextLen: number): number {
  return NONCE_BYTES + ciphertextLen;
}

export const TL3_CONST = {
  HKDF_HASH,
  AEAD_ALG,
  AEAD_TAG_BITS,
  NONCE_BYTES,
  KEY_BYTES,
} as const;
