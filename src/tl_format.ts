// ════════════════════════════════════════════════════════
// TL 파일 포맷 v1
// 구조:
//   [0-3]   매직: 0x544C4E4B (TLNK)
//   [4-5]   버전: 0x0001
//   [6-9]   헤더 길이 (4바이트 LE)
//   [10-N]  JSON 헤더 (UTF-8)
//   [N+10~] XOR 암호화된 원본 데이터
// ════════════════════════════════════════════════════════

export const TL_MAGIC = new Uint8Array([0x54, 0x4C, 0x4E, 0x4B]); // TLNK
export const TL_VERSION = new Uint8Array([0x00, 0x01]);

export interface TLHeader {
  shareId:     string;
  creatorId:   number;
  creatorName: string;
  title:       string;
  artist:      string;
  fileType:    string;   // 'audio/mpeg', 'video/mp4' 등
  ext:         string;   // 'mp3', 'mp4' 등
  duration:    number;   // 초
  tl_per_sec:  number;   // 초당 차감 TL
  plan:        string;   // 'A' | 'B'
  uploadedAt:  string;   // ISO 8601
  contentHash: string;   // 원본 SHA-256 (검증용)
  platform:    string;   // 'timelink.digital'
  version:     number;   // 1
}

// ── XOR 키 생성 (shareId + 플랫폼 시크릿 기반) ──
export function makeTLKey(shareId: string, secret: string): Uint8Array {
  const seed = shareId + secret + 'TIMELINK_v1';
  const key = new Uint8Array(256);
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  // 256바이트 키 생성 (반복 FNV-1a)
  for (let i = 0; i < 256; i++) {
    h ^= (i * 0x9e3779b9) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (h * 0x01000193) >>> 0;
    key[i] = h & 0xff;
  }
  return key;
}

// ── 원본 데이터 XOR 암호화 ──
export function xorEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out;
}

// ── .tl 파일 생성 ──
export function buildTLFile(header: TLHeader, rawData: Uint8Array, secret: string): Uint8Array {
  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  const headerLen = headerBytes.length;

  // 암호화
  const key = makeTLKey(header.shareId, secret);
  const encrypted = xorEncrypt(rawData, key);

  // 헤더 길이 4바이트 LE
  const lenBytes = new Uint8Array(4);
  lenBytes[0] = headerLen & 0xff;
  lenBytes[1] = (headerLen >> 8) & 0xff;
  lenBytes[2] = (headerLen >> 16) & 0xff;
  lenBytes[3] = (headerLen >> 24) & 0xff;

  // 조합
  const total = 4 + 2 + 4 + headerLen + encrypted.length;
  const out = new Uint8Array(total);
  let pos = 0;
  out.set(TL_MAGIC, pos);   pos += 4;
  out.set(TL_VERSION, pos); pos += 2;
  out.set(lenBytes, pos);   pos += 4;
  out.set(headerBytes, pos);pos += headerLen;
  out.set(encrypted, pos);
  return out;
}

// ── .tl 파일 파싱 ──
export function parseTLFile(data: Uint8Array): { header: TLHeader; encryptedData: Uint8Array } | null {
  // 매직 확인
  if (data[0]!==0x54||data[1]!==0x4C||data[2]!==0x4E||data[3]!==0x4B) return null;
  // 버전
  // const version = (data[4] << 8) | data[5];
  // 헤더 길이
  const headerLen = data[6] | (data[7]<<8) | (data[8]<<16) | (data[9]<<24);
  const headerBytes = data.slice(10, 10 + headerLen);
  const header: TLHeader = JSON.parse(new TextDecoder().decode(headerBytes));
  const encryptedData = data.slice(10 + headerLen);
  return { header, encryptedData };
}

// ── 복호화 ──
export function decryptTLData(encryptedData: Uint8Array, shareId: string, secret: string): Uint8Array {
  const key = makeTLKey(shareId, secret);
  return xorEncrypt(encryptedData, key); // XOR은 대칭
}
