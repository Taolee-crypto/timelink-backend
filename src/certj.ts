// cert3.ts — 증명서/이미지 전용 TLJ 빌더
// 증명서 이미지(PNG)를 TL3 컨테이너로 래핑

const MAGIC = new Uint8Array([0x54, 0x4C, 0x4E, 0x4B]); // "TLNK"
const VERSION = 0x03;

export interface CertTLJMeta {
  cert_no: string;
  asset_id: string;
  title: string;
  artist: string;
  snapshot: any;
  cert_hash: string;
  issued_at: string;
  issuer: string;
}

export async function buildCertTLJ(
  imageBytes: Uint8Array,
  meta: CertTLJMeta
): Promise<Uint8Array> {
  const enc = (s: string) => new TextEncoder().encode(s);
  const u32be = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  };

  // 1차 헤더 (offset 미정)
  const header: any = {
    v: 3,
    type: 'certj',
    aead: 'none',
    kdf: 'none',
    title: meta.title,
    artist: meta.artist,
    cid: '',
    name: '',
    genre: meta.snapshot?.genre || '',
    bpm: 0,
    dur_sec: 0,
    fs: 0,
    ch: 0,
    mp3: null,
    lp: null,
    hash_mp3: '',
    hash_lp: null,
    fid: '',
    salt: '',
    lic_id: '',
    token_latest: '',
    lic: '',
    ts: new Date().toISOString(),
    rights: { creator_id: 0, license: 'TL3-v3-cert', ownership: 'creator' },
    // certificate 확장
    cert_no: meta.cert_no,
    asset_id: meta.asset_id,
    cert_hash: meta.cert_hash,
    issued_at: meta.issued_at,
    issuer: meta.issuer,
    snapshot: meta.snapshot,
    img: {
      format: 'png',
      size: imageBytes.length,
      offset: 0,
    },
  };

  // 2-pass offset 계산
  const h1 = enc(JSON.stringify(header));
  const h1Total = 4 + 1 + 4 + h1.length;
  header.img.offset = h1Total;

  const h2 = enc(JSON.stringify(header));
  const h2Total = 4 + 1 + 4 + h2.length;
  if (h2Total !== h1Total) header.img.offset += (h2Total - h1Total);

  const hFinal = enc(JSON.stringify(header));
  const hFinalTotal = 4 + 1 + 4 + hFinal.length;
  header.img.offset = hFinalTotal;

  const hOut = enc(JSON.stringify(header));

  // 최종 조립: MAGIC(4) + VER(1) + hLen(4) + header + image
  const out = new Uint8Array(hFinalTotal + imageBytes.length);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  out[o++] = VERSION;
  out.set(u32be(hOut.length), o); o += 4;
  out.set(hOut, o); o += hOut.length;
  out.set(imageBytes, o);

  return out;
}

// TLJ 파싱 (검증용)
export function parseCertTLJ(data: Uint8Array): { header: any; imageOffset: number; imageSize: number } {
  if (data.length < 9) throw new Error('too small');
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) throw new Error('Not TL3');
  if (data[4] !== VERSION) throw new Error('Not TL3 v3');
  const hlen = new DataView(data.buffer, data.byteOffset + 5, 4).getUint32(0, false);
  if (9 + hlen > data.length) throw new Error('Header length OOB');
  const header = JSON.parse(new TextDecoder().decode(data.subarray(9, 9 + hlen)));
  return {
    header,
    imageOffset: 9 + hlen,
    imageSize: data.length - (9 + hlen)
  };
}
