// src/tl3_crypto.ts
// TimeLink TL3 v3 — 최소 암호 유틸
//
// 원칙:
//   - TL3_MASTER_SECRET은 Worker Secret에만 존재. 파일·클라이언트에 절대 저장 X.
//   - 이 파일은 마스터 시크릿 import만 담당.
//   - 라이선스/세그먼트/토큰은 모두 tl3v3.ts에서 해시 체인으로 유도.

const enc = new TextEncoder();

/**
 * 마스터 시크릿 → HKDF CryptoKey
 * - 최소 16자 이상
 * - SHA-256으로 해시 후 HKDF 키로 import
 */
export async function importMasterSecret(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error('TL3_MASTER_SECRET must be at least 16 chars');
  }
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
}