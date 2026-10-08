// src/tl3v3.ts
// TimeLink TL3 v3 — 정식 구현
// 파일: mp3 + LP PCM16 (1초 세그먼트, AES-256-GCM) + 최신 토큰만
// 서버: 라이선스 키(마스터), 전체 타임토큰 체인, 회계
//
// 파일 레이아웃:
//   [0..3]   "TLNK" (0x54 0x4C 0x4E 0x4B)
//   [4]      version = 0x03
//   [5..8]   headerLen (uint32 BE)
//   [9..]    header JSON (UTF-8)
//   [mp3 세그먼트 × N]   각: ciphertext (AES-GCM, iv=[4B 0][8B n])
//   [LP  세그먼트 × N]   각: ciphertext
//
// 헤더 JSON:
//   v, title, artist, cid, name, genre, bpm, dur_sec,
//   fs, ch,
//   mp3: { N, seg_bytes, last_bytes, first_offset },
//   lp:  { N, seg_bytes, last_bytes, first_offset },
//   hash_mp3, hash_lp,
//   fid, salt, lic_id,
//   token_latest, ts, rights
//
// 키 유도 (매 초 다른 키):
//   lic  = HKDF(master, info="license:"+shareId)  [서버만]
//   T_0  = SHA256(fid ‖ hash_mp3 ‖ salt)
//   k_n  = SHA256(T_{n-1} ‖ lic ‖ "K"+n)  → AES-GCM key
//   T_n  = SHA256(T_{n-1} ‖ fid ‖ str(n) ‖ SHA256(ciphertext_n))

import { importMasterSecret } from './tl3_crypto';

const MAGIC = new Uint8Array([0x54, 0x4c, 0x4e, 0x4b]);
const VERSION = 0x03;
const SEG_SECONDS = 1;      // 1초 세그먼트
const FS_DEFAULT = 44100;
const CH_DEFAULT = 2;
const BYTES_PER_SAMPLE = 2; // PCM16
const GCM_TAG_BYTES = 16;
const TOKEN_BYTES = 32;

// ─────────────────────────────────────────
export interface TL3Header {
  v: 3;
  aead: 'AES-256-GCM';
  kdf: 'HKDF-SHA-256';
  title: string;
  artist: string;
  cid: string;
  name: string;
  genre?: string;
  bpm?: number;
  dur_sec: number;
  fs: number;
  ch: number;
  mp3: { N: number; seg_bytes: number; last_bytes: number; first_offset: number };
  lp:  { N: number; seg_bytes: number; last_bytes: number; first_offset: number } | null;
  hash_mp3: string;
  hash_lp: string | null;
  fid: string;
  salt: string;
  lic_id: string;
  token_latest: string;
  mp3_tokens?: string[];   // 스파인 코드: T_0 ~ T_N 전체
  ts: string;
  rights: { creator_id: number; license: string; ownership: string };
}

export interface BuildInput {
  title: string;
  artist: string;
  cid: string;
  name: string;
  genre?: string;
  bpm?: number;
  creator_id: number;
  fs: number;
  ch: number;
  mp3Pcm: Int16Array;   // 원본 mp3을 디코딩한 PCM (또는 원본 mp3 raw)
  masterSecret: string;
  shareId: string;
  licId?: string;
}

export interface BuildResult {
  data: Uint8Array;
  header: TL3Header;
  mp3Tokens: string[];  // T_0..T_N (hex)
}

// ─────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────
function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const buf = concat(...parts);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(h);
}

export function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function unhex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function readU32be(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function enc(s: string): Uint8Array { return new TextEncoder().encode(s); }
function dec(b: Uint8Array): string { return new TextDecoder().decode(b); }

/** 12바이트 nonce: [4B 0][8B n] */
function ivFor(n: number): Uint8Array {
  const v = new Uint8Array(12);
  new DataView(v.buffer).setBigUint64(4, BigInt(n), false);
  return v;
}

/** 매 초 다른 AES-GCM 키 유도: SHA256(T_{n-1} ‖ lic ‖ "K"+n) */
async function deriveSegKey(Tprev: Uint8Array, lic: Uint8Array, n: number): Promise<CryptoKey> {
  const raw = await sha256(Tprev, lic, enc('K' + n));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 최초 토큰: SHA256(fid ‖ hash ‖ salt) */
export async function initialToken(fid: Uint8Array, hash: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return sha256(fid, hash, salt);
}

/** 다음 토큰: SHA256(T_{n-1} ‖ fid ‖ str(n) ‖ SHA256(ct_n)) */
async function nextToken(Tprev: Uint8Array, fid: Uint8Array, n: number, ct: Uint8Array): Promise<Uint8Array> {
  const ctHash = await sha256(ct);
  return sha256(Tprev, fid, enc(String(n)), ctHash);
}

/** PCM (Int16Array) → Uint8Array (little-endian) */
function pcmToBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

// ─────────────────────────────────────────
// 라이선스 유도 (서버 마스터 → 파일별 lic)
// ─────────────────────────────────────────
export async function deriveLicenseBytes(masterSecret: string, shareId: string): Promise<Uint8Array> {
  // HKDF(master, info="license:"+shareId) → 32B
  const master = await importMasterSecret(masterSecret);
  // (deriveLicenseKey 호출 제거 — 결과 unused)
  // HMAC 키 → raw export 대신, HKDF 별도 유도
  // tl3_crypto의 importMasterSecret + crypto.subtle.deriveBits 사용
  const hkdfBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('tl3:lic:salt:' + shareId), info: enc('tl3:lic:' + shareId) },
    master,
    256
  );
  return new Uint8Array(hkdfBits);
}

// ─────────────────────────────────────────
// MP3 raw + 세그먼트 배열 입력 버전 (v2 호환)
// - PCM 디코딩 없이 mp3 프레임 경계를 그대로 사용
// - 세그먼트별 AES-256-GCM + 타임토큰 체인
// ─────────────────────────────────────────
export interface BuildFromMp3Input {
  title: string;
  artist: string;
  cid: string;
  name: string;
  genre?: string;
  bpm?: number;
  creator_id: number;
  mp3Raw: Uint8Array;
  segments: Array<{ offset: number; length: number; durationMs: number }>;
  masterSecret: string;
  shareId: string;
  licId?: string;
}

export interface BuildFromMp3Result {
  data: Uint8Array;
  header: TL3Header;
  mp3Tokens: string[];
  ctLens: number[];   // 세그먼트별 ciphertext 길이 (nonce 없음, mp3 프레임 방식)
}

export async function buildTL3V3FromMp3(input: BuildFromMp3Input): Promise<BuildFromMp3Result> {
  const { mp3Raw, segments } = input;
  const totalSec = segments.length;

  // 라이선스 (서버 유도)
  const lic = await deriveLicenseBytes(input.masterSecret, input.shareId);

  // fid, salt (랜덤)
  const fid = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 해시
  const hashMp3 = await sha256(mp3Raw);

  // T_0
  const mp3T0 = await initialToken(fid, hashMp3, salt);

  // 세그먼트 암호화 (5초 단위 mp3 프레임 그대로)
  const mp3Enc: Uint8Array[] = [];
  const mp3Tokens: string[] = [hex(mp3T0)];
  let T_mp3 = mp3T0;

  for (let n = 1; n <= totalSec; n++) {
    const seg = segments[n - 1];
    const segBytes = mp3Raw.subarray(seg.offset, seg.offset + seg.length);

    const kMp3 = await deriveSegKey(T_mp3, lic, n);
    const ctMp3 = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivFor(n), tagLength: 128 },
      kMp3,
      segBytes
    ));
    mp3Enc.push(ctMp3);
    T_mp3 = await nextToken(T_mp3, fid, n, ctMp3);
    mp3Tokens.push(hex(T_mp3));
  }

  // 헤더
  const header: TL3Header = {
    v: 3,
    aead: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    title: input.title,
    artist: input.artist,
    cid: input.cid,
    name: input.name,
    genre: input.genre,
    bpm: input.bpm,
    dur_sec: totalSec,
    fs: 0,         // mp3 프레임 방식이라 fs/ch는 참고용
    ch: 0,
    mp3: { N: totalSec, seg_bytes: 0, last_bytes: mp3Enc[mp3Enc.length - 1].length, first_offset: 0 },
    lp: null,
    hash_mp3: hex(hashMp3),
    hash_lp: null,
    fid: hex(fid),
    salt: hex(salt),
    lic_id: input.licId || 'k_2026_01',
    token_latest: hex(T_mp3),
    mp3_tokens: mp3Tokens,   // 스파인 코드 전체
    ts: new Date().toISOString(),
    rights: { creator_id: input.creator_id, license: 'TL3-v3', ownership: 'creator' },
  };

  // 2-pass offset 계산
  const headerJson1 = enc(JSON.stringify(header));
  const headerTotal1 = 4 + 1 + 4 + headerJson1.length;
  const mp3TotalBytes = mp3Enc.reduce((a, b) => a + b.length, 0);

  header.mp3.first_offset = headerTotal1;

  const headerJson2 = enc(JSON.stringify(header));
  const headerTotal2 = 4 + 1 + 4 + headerJson2.length;
  if (headerTotal2 !== headerTotal1) {
    const shift = headerTotal2 - headerTotal1;
    header.mp3.first_offset += shift;
  }

  const headerJsonFinal = enc(JSON.stringify(header));
  const headerTotalFinal = 4 + 1 + 4 + headerJsonFinal.length;

  // 조립
  const out = new Uint8Array(headerTotalFinal + mp3TotalBytes);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  out[o++] = VERSION;
  out.set(u32be(headerJsonFinal.length), o); o += 4;
  out.set(headerJsonFinal, o); o += headerJsonFinal.length;
  for (const b of mp3Enc) { out.set(b, o); o += b.length; }

  const ctLens = mp3Enc.map(b => b.length);
  return { data: out, header, mp3Tokens, ctLens };
}

// ─────────────────────────────────────────
// TL3 v3 빌드
// ─────────────────────────────────────────
export async function buildTL3V3(input: BuildInput): Promise<BuildResult> {
  const { fs, ch, mp3Pcm } = input;
  const segBytes = fs * SEG_SECONDS * ch * BYTES_PER_SAMPLE;  // 예: 44100*2*2 = 176400
  const totalSamples = mp3Pcm.length;
  const totalSec = Math.ceil(totalSamples / (fs * ch));

  // 라이선스 (서버 유도)
  const lic = await deriveLicenseBytes(input.masterSecret, input.shareId);

  // fid, salt (랜덤)
  const fid = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 해시
  const hashMp3 = await sha256(new Uint8Array(mp3Pcm.buffer, mp3Pcm.byteOffset, mp3Pcm.byteLength));

  // T_0 (mp3, lp 각각)
  const mp3T0 = await initialToken(fid, hashMp3, salt);

  // 세그먼트 암호화
  const mp3Enc: Uint8Array[] = [];
  const mp3Tokens: string[] = [hex(mp3T0)];

  const mp3Bytes = pcmToBytes(mp3Pcm);

  let T_mp3 = mp3T0;

  for (let n = 1; n <= totalSec; n++) {
    const fromByte = (n - 1) * segBytes;
    const toByte = Math.min(n * segBytes, mp3Bytes.length);
    const mp3Seg = mp3Bytes.subarray(fromByte, toByte);

    // mp3
    const kMp3 = await deriveSegKey(T_mp3, lic, n);
    const ctMp3 = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivFor(n), tagLength: 128 },
      kMp3,
      mp3Seg
    ));
    mp3Enc.push(ctMp3);
    T_mp3 = await nextToken(T_mp3, fid, n, ctMp3);
    mp3Tokens.push(hex(T_mp3));
  }

  // 헤더
  const mp3FirstOffsetTemp = 0;

  const header: TL3Header = {
    v: 3,
    aead: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    title: input.title,
    artist: input.artist,
    cid: input.cid,
    name: input.name,
    genre: input.genre,
    bpm: input.bpm,
    dur_sec: totalSec,
    fs,
    ch,
    mp3: { N: totalSec, seg_bytes: segBytes, last_bytes: mp3Enc[mp3Enc.length - 1].length, first_offset: 0 },
    lp: null,
    hash_mp3: hex(hashMp3),
    hash_lp: null,
    fid: hex(fid),
    salt: hex(salt),
    lic_id: input.licId || 'k_2026_01',
    token_latest: hex(T_mp3),  // mp3 기준 (또는 별도 필드)
    ts: new Date().toISOString(),
    rights: { creator_id: input.creator_id, license: 'TL3-v3', ownership: 'creator' },
  };

  // 2-pass offset 계산
  const headerJson1 = enc(JSON.stringify(header));
  const headerTotal1 = 4 + 1 + 4 + headerJson1.length;
  const mp3TotalBytes = mp3Enc.reduce((a, b) => a + b.length, 0);

  header.mp3.first_offset = headerTotal1;

  const headerJson2 = enc(JSON.stringify(header));
  const headerTotal2 = 4 + 1 + 4 + headerJson2.length;
  if (headerTotal2 !== headerTotal1) {
    const shift = headerTotal2 - headerTotal1;
    header.mp3.first_offset += shift;
  }

  const headerJsonFinal = enc(JSON.stringify(header));
  const headerTotalFinal = 4 + 1 + 4 + headerJsonFinal.length;

  // 조립
  const out = new Uint8Array(headerTotalFinal + mp3TotalBytes);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  out[o++] = VERSION;
  out.set(u32be(headerJsonFinal.length), o); o += 4;
  out.set(headerJsonFinal, o); o += headerJsonFinal.length;
  for (const b of mp3Enc) { out.set(b, o); o += b.length; }

  return { data: out, header, mp3Tokens };
}

// ─────────────────────────────────────────
// 파싱 (헤더만)
// ─────────────────────────────────────────
export function parseTL3V3(data: Uint8Array): { header: TL3Header; headerLen: number } {
  if (data.length < 9) throw new Error('TL3 too small');
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) throw new Error('Not TL3');
  if (data[4] !== VERSION) throw new Error('Not TL3 v3');
  const hlen = readU32be(data, 5);
  if (9 + hlen > data.length) throw new Error('Header length out of range');
  const header = JSON.parse(dec(data.subarray(9, 9 + hlen))) as TL3Header;
  return { header, headerLen: 9 + hlen };
}

// ─────────────────────────────────────────
// 세그먼트 복호화
// ─────────────────────────────────────────
export async function decryptSingleSegment(
  ciphertext: Uint8Array,
  n: number,
  Tprev: Uint8Array,
  lic: Uint8Array
): Promise<Uint8Array> {
  const key = await deriveSegKey(Tprev, lic, n);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivFor(n), tagLength: 128 },
    key,
    ciphertext
  );
  return new Uint8Array(plain);
}

export async function decryptSegmentV3(
  fileData: Uint8Array,
  header: TL3Header,
  kind: 'mp3' | 'lp',
  n: number,                // 1-based
  Tprev: Uint8Array,        // T_{n-1}
  lic: Uint8Array
): Promise<Uint8Array> {
  const section = header[kind];
  // 세그먼트 위치 계산
  const segmentLen = section.seg_bytes + GCM_TAG_BYTES;
  const lastLen = section.last_bytes;
  let offset = section.first_offset;
  for (let i = 1; i < n; i++) {
    offset += (i < section.N) ? segmentLen : lastLen;
  }
  const thisLen = (n < section.N) ? segmentLen : lastLen;
  const ct = fileData.subarray(offset, offset + thisLen);

  const key = await deriveSegKey(Tprev, lic, n);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivFor(n), tagLength: 128 },
    key,
    ct
  );
  return new Uint8Array(plain);
}

// ─────────────────────────────────────────
// 다음 토큰 계산 (검증용)
// ─────────────────────────────────────────
export async function computeNextToken(
  Tprev: Uint8Array, fid: Uint8Array, n: number, ct: Uint8Array
): Promise<Uint8Array> {
  return nextToken(Tprev, fid, n, ct);
}

export const TL3_V3_CONST = {
  MAGIC, VERSION, SEG_SECONDS, FS_DEFAULT, CH_DEFAULT,
  BYTES_PER_SAMPLE, GCM_TAG_BYTES, TOKEN_BYTES
};