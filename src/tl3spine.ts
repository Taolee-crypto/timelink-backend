/**
 * TimeLink TL3 Spine Converter — additive TLNK v4 profile.
 *
 * v3 remains readable and unchanged. This module creates a new authenticated
 * container profile in which the license and complete spine are NOT embedded
 * in the public header. The returned token chain is server-side material.
 */
import { deriveLicenseBytes, hex } from './tl3v3';

const MAGIC = new Uint8Array([0x54, 0x4c, 0x4e, 0x4b]);
const VERSION = 0x04;
const GCM_TAG_BYTES = 16;
const enc = (value: string) => new TextEncoder().encode(value);

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 255, (value >>> 16) & 255,
    (value >>> 8) & 255, value & 255
  ]);
}

function nonce(prefix: Uint8Array, index: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index), false);
  return iv;
}

export interface TL3SpineSegment {
  offset: number;
  length: number;
  durationMs: number;
}

export interface TL3SpineBuildInput {
  fileId: number;
  shareId: string;
  title: string;
  artist: string;
  creatorId: number;
  mp3Raw: Uint8Array;
  segments: TL3SpineSegment[];
  masterSecret: string;
  licId: string;
  rightsConfirmed: true;
  lpMeta?: Record<string, any> | null;
}

export interface TL3SpineHeader {
  v: 4;
  profile: 'TL3-SPINE-1';
  aead: 'AES-256-GCM';
  kdf: 'HKDF-SHA-256';
  title: string;
  artist: string;
  creator_id: number;
  share_id: string;
  file_id: number;
  fid: string;
  salt: string;
  nonce_prefix: string;
  hash_mp3: string;
  rights_digest: string;
  lic_id: string;
  duration_ms: number;
  segment_count: number;
  segment_lengths: number[];
  segment_durations_ms: number[];
  spine_root: string;
  spine_latest: string;
  rights: { ownership: 'creator'; license: 'TL3-SPINE-1'; rights_confirmed: true };
  created_at: string;
  lp_meta?: Record<string, any> | null;
}

export interface TL3SpineBuildResult {
  data: Uint8Array;
  header: TL3SpineHeader;
  /** Store this array in server-side storage only. Never place it in the TL3 header. */
  spineTokens: string[];
  ciphertextLengths: number[];
}

async function deriveSegmentKey(
  license: Uint8Array,
  previousToken: Uint8Array,
  index: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', license, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: previousToken, info: enc('timelink:tl3:spine:v1:segment:' + index) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
}

function validateSegments(raw: Uint8Array, segments: TL3SpineSegment[]): number {
  if (!segments.length) throw new Error('TL3에는 하나 이상의 세그먼트가 필요합니다.');
  let expectedOffset = 0;
  let totalDuration = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!Number.isInteger(segment.offset) || !Number.isInteger(segment.length) ||
        segment.offset !== expectedOffset || segment.length <= 0 ||
        segment.offset + segment.length > raw.length) {
      throw new Error('TL3 세그먼트의 위치 또는 길이가 연속적이지 않습니다. index=' + i);
    }
    if (!Number.isFinite(segment.durationMs) || segment.durationMs <= 0 || segment.durationMs > 1000.5) {
      throw new Error('TL3 Spine v1은 세그먼트당 최대 1초를 요구합니다. index=' + i);
    }
    expectedOffset += segment.length;
    totalDuration += segment.durationMs;
  }
  if (expectedOffset !== raw.length) throw new Error('세그먼트가 원본 MP3 전체를 포함하지 않습니다.');
  return Math.round(totalDuration);
}

export async function buildTL3SpineV4(input: TL3SpineBuildInput): Promise<TL3SpineBuildResult> {
  if (input.rightsConfirmed !== true) throw new Error('권리 확인이 완료되지 않았습니다.');
  if (!input.fileId || !input.shareId || !input.title || !input.artist) throw new Error('TL3 자산 식별정보가 부족합니다.');
  const durationMs = validateSegments(input.mp3Raw, input.segments);
  const license = await deriveLicenseBytes(input.masterSecret, input.shareId);
  const fid = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(4));
  const sourceHash = await sha256(input.mp3Raw);
  const rights = {
    ownership: 'creator' as const,
    license: 'TL3-SPINE-1' as const,
    rights_confirmed: true as const
  };
  const rightsDigest = await sha256(enc(JSON.stringify({
    creator_id: input.creatorId, file_id: input.fileId, share_id: input.shareId, rights
  })));
  const root = await sha256(enc('TL3-SPINE-ROOT-V1'), fid, sourceHash, salt, rightsDigest);
  let previous = root;
  const tokens = [hex(root)];
  const ciphertexts: Uint8Array[] = [];
  const ciphertextLengths: number[] = [];
  const segmentLengths: number[] = [];
  const segmentDurations: number[] = [];
  let startMs = 0;

  for (let i = 0; i < input.segments.length; i++) {
    const segment = input.segments[i];
    const index = i + 1;
    const endMs = startMs + Math.round(segment.durationMs);
    const plain = input.mp3Raw.subarray(segment.offset, segment.offset + segment.length);
    const key = await deriveSegmentKey(license, previous, index);
    const aadObject = {
      profile: 'TL3-SPINE-1', fid: hex(fid), file_id: input.fileId,
      share_id: input.shareId, index, start_ms: startMs, end_ms: endMs,
      previous: hex(previous), rights_digest: hex(rightsDigest)
    };
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce(noncePrefix, index), additionalData: enc(JSON.stringify(aadObject)), tagLength: 128 },
      key,
      plain
    ));
    const cipherHash = await sha256(ciphertext);
    previous = await sha256(
      enc('TL3-SPINE-LINK-V1'), previous, fid, u32be(index),
      u32be(startMs), u32be(endMs), rightsDigest, cipherHash
    );
    tokens.push(hex(previous));
    ciphertexts.push(ciphertext);
    ciphertextLengths.push(ciphertext.length);
    segmentLengths.push(ciphertext.length);
    segmentDurations.push(endMs - startMs);
    startMs = endMs;
  }

  const header: TL3SpineHeader = {
    v: 4,
    profile: 'TL3-SPINE-1',
    aead: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    title: input.title,
    artist: input.artist,
    creator_id: input.creatorId,
    share_id: input.shareId,
    file_id: input.fileId,
    fid: hex(fid),
    salt: hex(salt),
    nonce_prefix: hex(noncePrefix),
    hash_mp3: hex(sourceHash),
    rights_digest: hex(rightsDigest),
    lic_id: input.licId,
    duration_ms: durationMs,
    segment_count: input.segments.length,
    segment_lengths: segmentLengths,
    segment_durations_ms: segmentDurations,
    spine_root: tokens[0],
    spine_latest: tokens[tokens.length - 1],
    rights,
    lp_meta: input.lpMeta ? {
      enabled: input.lpMeta.lp_enabled === true,
      price_tl: Math.max(0, Math.floor(Number(input.lpMeta.lp_price_tl || 0))),
      patent: String(input.lpMeta.lp_patent || ''),
      seed: Number(input.lpMeta.lp_seed || 7),
      g: input.lpMeta.lp_g || null,
      fs: Number(input.lpMeta.lp_fs || 0),
      n: Number(input.lpMeta.lp_n || 0),
      version: String(input.lpMeta.lp_version || 'lp-v1-runtime'),
      processing: 'player-realtime',
      audio_payload_bytes: 0
    } : null,
    created_at: new Date().toISOString()
  };
  const headerBytes = enc(JSON.stringify(header));
  const prefix = concat(MAGIC, new Uint8Array([VERSION]), u32be(headerBytes.length), headerBytes);
  const payload = concat(...ciphertexts);
  return {
    data: concat(prefix, payload),
    header,
    spineTokens: tokens,
    ciphertextLengths
  };
}

export const TL3_SPINE_V4 = {
  version: VERSION,
  magic: 'TLNK',
  profile: 'TL3-SPINE-1',
  gcmTagBytes: GCM_TAG_BYTES
};

function unhexBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error('잘못된 hex 값입니다.');
  const out=new Uint8Array(value.length/2);
  for(let i=0;i<out.length;i++) out[i]=parseInt(value.slice(i*2,i*2+2),16);
  return out;
}

/** Verify the serialized v4 container and every server-held spine link against ciphertext bytes. */
export async function verifyTL3SpineV4Container(
  data: Uint8Array,
  expectedHeader: TL3SpineHeader,
  storedTokens: string[]
): Promise<{valid:boolean;reason?:string}> {
  try {
    if(data.length<9 || data[0]!==MAGIC[0] || data[1]!==MAGIC[1] || data[2]!==MAGIC[2] || data[3]!==MAGIC[3] || data[4]!==VERSION) {
      return {valid:false,reason:'TLNK v4 magic/version 불일치'};
    }
    const headerLength=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(5,false);
    if(headerLength<=0 || 9+headerLength>data.length) return {valid:false,reason:'헤더 길이 오류'};
    const actualHeader=JSON.parse(new TextDecoder().decode(data.subarray(9,9+headerLength))) as TL3SpineHeader;
    if(JSON.stringify(actualHeader)!==JSON.stringify(expectedHeader)) return {valid:false,reason:'저장된 헤더와 컨테이너 헤더 불일치'};
    if(actualHeader.profile!=='TL3-SPINE-1' || actualHeader.segment_count!==actualHeader.segment_lengths.length ||
       actualHeader.segment_count!==actualHeader.segment_durations_ms.length ||
       storedTokens.length!==actualHeader.segment_count+1) return {valid:false,reason:'세그먼트/스파인 개수 불일치'};
    const fid=unhexBytes(actualHeader.fid);
    const sourceHash=unhexBytes(actualHeader.hash_mp3);
    const salt=unhexBytes(actualHeader.salt);
    const rightsDigest=unhexBytes(actualHeader.rights_digest);
    const root=await sha256(enc('TL3-SPINE-ROOT-V1'),fid,sourceHash,salt,rightsDigest);
    if(hex(root)!==actualHeader.spine_root || storedTokens[0]!==hex(root)) return {valid:false,reason:'Spine root 불일치'};
    let previous=root;
    let offset=9+headerLength;
    let startMs=0;
    for(let i=0;i<actualHeader.segment_count;i++){
      const length=actualHeader.segment_lengths[i];
      const duration=actualHeader.segment_durations_ms[i];
      if(!Number.isInteger(length)||length<=GCM_TAG_BYTES||offset+length>data.length||
         !Number.isInteger(duration)||duration<=0||duration>1000) return {valid:false,reason:'세그먼트 범위/시간 오류: '+i};
      const ciphertext=data.subarray(offset,offset+length);
      const cipherHash=await sha256(ciphertext);
      const endMs=startMs+duration;
      previous=await sha256(enc('TL3-SPINE-LINK-V1'),previous,fid,u32be(i+1),
        u32be(startMs),u32be(endMs),rightsDigest,cipherHash);
      if(storedTokens[i+1]!==hex(previous)) return {valid:false,reason:'Spine link 불일치: '+(i+1)};
      offset+=length;
      startMs=endMs;
    }
    if(offset!==data.length) return {valid:false,reason:'컨테이너 끝에 미등록 데이터가 있습니다.'};
    if(hex(previous)!==actualHeader.spine_latest) return {valid:false,reason:'최종 Spine 토큰 불일치'};
    return {valid:true};
  } catch(error:any) {
    return {valid:false,reason:error?.message||'Spine 검증 오류'};
  }
}
