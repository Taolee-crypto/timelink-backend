// src/tl3v3.ts
// TimeLink TL3 v4 — MP3 + LP Opus 통합 암호화 컨테이너
// 파일: mp3(1초 세그먼트) + lp_opus(1개 세그먼트) + 타임토큰 체인(스파인)
// 서버: 라이선스 키(마스터), 전체 타임토큰 체인, 회계

import { importMasterSecret } from './tl3_crypto';

const MAGIC = new Uint8Array([0x54, 0x4c, 0x4e, 0x4b]);
const VERSION = 0x04; // ★ V4로 버전업
const TOKEN_BYTES = 32;

// ─────────────────────────────────────────
export interface TL3HeaderV4 {
  v: 4;
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
  lp_opus: { N: number; seg_bytes: number; last_bytes: number; first_offset: number } | null;
  hash_mp3: string;
  hash_lp_opus: string | null;
  fid: string;
  salt: string;
  lic_id: string;
  token_latest: string;
  lic: string;
  share_id?: string;
  track_id?: number;
  mp3_tokens?: string[];
  lp_tokens?: string[];
  mp3_seg_lens?: number[];
  lp_seg_lens?: number[];
  ts: string;
  rights: { creator_id: number; license: string; ownership: string };
}

export interface BuildFromMp3V4Input {
  mp3Raw: Uint8Array;
  segments: Array<{ offset: number; length: number; durationMs: number }>;
  lpOpusData?: Uint8Array | null;
  masterSecret: string;
  shareId: string;
  fileId: number;
  title: string;
  artist: string;
  cid: string;
  name: string;
  genre?: string;
  bpm?: number;
  creator_id: number;
  licId?: string;
}

export interface BuildFromMp3V4Result {
  data: Uint8Array;
  header: TL3HeaderV4;
  mp3Tokens: string[];
  lpTokens: string[];
  ctLens: number[];
  lpCtLens: number[];
}

// ─────────────────────────────────────────
// 유틸리티
async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

async function deriveLicenseBytes(masterSecret: string, shareId: string): Promise<Uint8Array> {
  const key = await importMasterSecret(masterSecret);
  const info = new TextEncoder().encode('license:' + shareId);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    key, 256
  );
  return new Uint8Array(derived);
}

async function deriveSegKey(Tprev: Uint8Array, lic: Uint8Array, n: number): Promise<CryptoKey> {
  const nBytes = new TextEncoder().encode(String(n));
  const combined = new Uint8Array(Tprev.length + lic.length + nBytes.length + 1);
  combined.set(Tprev, 0);
  combined.set(lic, Tprev.length);
  combined.set(nBytes, Tprev.length + lic.length);
  combined[Tprev.length + lic.length + nBytes.length] = 0x4B; // 'K'
  const hash = await crypto.subtle.digest('SHA-256', combined);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function initialToken(fid: Uint8Array, hashMp3: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return sha256(fid, hashMp3, salt);
}

async function nextToken(Tprev: Uint8Array, fid: Uint8Array, n: number, ct: Uint8Array): Promise<Uint8Array> {
  const nBytes = new TextEncoder().encode(String(n));
  const ctHash = await sha256(ct);
  return sha256(Tprev, fid, nBytes, ctHash);
}

function ivFor(n: number): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(n), false);
  return iv;
}

function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
}

function hex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ─────────────────────────────────────────
// V4 핵심: MP3 + LP Opus 통합 제조
export async function buildTL3V4FromMp3(input: BuildFromMp3V4Input): Promise<BuildFromMp3V4Result> {
  const { mp3Raw, segments, lpOpusData } = input;
  if (!(mp3Raw instanceof Uint8Array) || mp3Raw.length === 0) {
    throw new Error('TL3 원본 MP3가 비어 있습니다.');
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('TL3 제조에는 하나 이상의 MP3 세그먼트가 필요합니다.');
  }

  // 1. 세그먼트 검증
  let expectedOffset = 0;
  let durationMs = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!Number.isInteger(segment.offset) || !Number.isInteger(segment.length) ||
        segment.offset !== expectedOffset || segment.length <= 0 ||
        segment.offset + segment.length > mp3Raw.length) {
      throw new Error('TL3 MP3 세그먼트의 위치 또는 길이가 연속적이지 않습니다. index=' + i);
    }
    if (!Number.isFinite(segment.durationMs) || segment.durationMs <= 0 || segment.durationMs > 1000.5) {
      throw new Error('TL3 MP3 세그먼트는 1초 이하여야 합니다. index=' + i);
    }
    expectedOffset += segment.length;
    durationMs += segment.durationMs;
  }
  if (expectedOffset !== mp3Raw.length) {
    throw new Error('TL3 MP3 세그먼트가 원본 전체 바이트를 포함하지 않습니다.');
  }
  const segmentCount = segments.length;
  const durationSeconds = Number((durationMs / 1000).toFixed(3));

  // 2. 라이선스 키 유도
  const lic = await deriveLicenseBytes(input.masterSecret, input.shareId);

  // 3. fid, salt 생성
  const fid = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 4. 해시 및 T_0
  const hashMp3 = await sha256(mp3Raw);
  const mp3T0 = await initialToken(fid, hashMp3, salt);

  // 5. MP3 세그먼트 암호화 (스파인 체인)
  const mp3Enc: Uint8Array[] = [];
  const mp3Tokens: string[] = [hex(mp3T0)];
  let T_mp3 = mp3T0;

  for (let n = 1; n <= segmentCount; n++) {
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

  // 6. LP Opus 세그먼트 암호화 (스파인 체인에 연결)
  const lpEnc: Uint8Array[] = [];
  const lpTokens: string[] = [];
  let hashLpOpus: string | null = null;

  if (lpOpusData && lpOpusData.length > 0) {
    hashLpOpus = hex(await sha256(lpOpusData));
    // LP Opus는 통째로 1개 세그먼트로 처리
    const lpN = 1;
    const kLp = await deriveSegKey(T_mp3, lic, segmentCount + lpN);
    const ctLp = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivFor(segmentCount + lpN), tagLength: 128 },
      kLp,
      lpOpusData
    ));
    lpEnc.push(ctLp);
    const T_lp = await nextToken(T_mp3, fid, segmentCount + lpN, ctLp);
    lpTokens.push(hex(T_lp));
    T_mp3 = T_lp; // 스파인 체인 연결
  }

  // 7. 헤더 조립
  const header: TL3HeaderV4 = {
    v: 4, // ★ V4
    aead: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    title: input.title,
    artist: input.artist,
    cid: input.cid,
    name: input.name,
    genre: input.genre,
    bpm: input.bpm,
    dur_sec: durationSeconds,
    fs: 0,
    ch: 0,
    mp3: { N: segmentCount, seg_bytes: 0, last_bytes: mp3Enc[mp3Enc.length - 1].length, first_offset: 0 },
    lp_opus: lpEnc.length > 0 ? { N: 1, seg_bytes: 0, last_bytes: lpEnc[0].length, first_offset: 0 } : null,
    hash_mp3: hex(hashMp3),
    hash_lp_opus: hashLpOpus,
    fid: hex(fid),
    salt: hex(salt),
    lic_id: input.licId || 'k_2026_01',
    token_latest: hex(T_mp3),
    lic: hex(lic),
    share_id: input.shareId,
    track_id: input.fileId,
    mp3_tokens: mp3Tokens,
    lp_tokens: lpTokens.length > 0 ? lpTokens : undefined,
    mp3_seg_lens: mp3Enc.map(b => b.length),
    lp_seg_lens: lpEnc.length > 0 ? lpEnc.map(b => b.length) : undefined,
    ts: new Date().toISOString(),
    rights: { creator_id: input.creator_id, license: 'TL3-v4', ownership: 'creator' },
  };

  // 8. first_offset 안정화
  const mp3TotalBytes = mp3Enc.reduce((a, b) => a + b.length, 0);
  const lpTotalBytes = lpEnc.reduce((a, b) => a + b.length, 0);
  let prevTotal = -1;
  let safety = 0;
  while (safety++ < 10) {
    const json = enc(JSON.stringify(header));
    const total = 4 + 1 + 4 + json.length;
    if (total === prevTotal) break;
    header.mp3.first_offset = total;
    if (header.lp_opus) header.lp_opus.first_offset = total + mp3TotalBytes;
    prevTotal = total;
  }

  const headerJsonFinal = enc(JSON.stringify(header));
  const headerTotalFinal = 4 + 1 + 4 + headerJsonFinal.length;

  // 9. TLNK V4 컨테이너 조립
  const out = new Uint8Array(headerTotalFinal + mp3TotalBytes + lpTotalBytes);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  out[o++] = VERSION; // 0x04
  out.set(u32be(headerJsonFinal.length), o); o += 4;
  out.set(headerJsonFinal, o); o += headerJsonFinal.length;
  for (const b of mp3Enc) { out.set(b, o); o += b.length; }
  for (const b of lpEnc) { out.set(b, o); o += b.length; }

  const ctLens = mp3Enc.map(b => b.length);
  const lpCtLens = lpEnc.map(b => b.length);
  return { data: out, header, mp3Tokens, lpTokens, ctLens, lpCtLens };
}

// ─────────────────────────────────────────
// 기존 V3 호환을 위한 래퍼 (legacy)
export { 
  buildTL3V4FromMp3 as buildTL3V3FromMp3,
  deriveLicenseBytes,
  initialToken,
  nextToken,
  ivFor,
  u32be,
  hex,
  enc,
  sha256,
};
