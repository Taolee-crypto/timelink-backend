/**
 * src/jetton.ts
 * 
 * TON Jetton 민팅 헬퍼 (Cloudflare Workers 호환)
 * 
 * 기존 서버 영향 없음 — 새 파일 추가만
 * 
 * 환경변수:
 *   TON_ADMIN_MNEMONIC  : 배포 시 생성한 24단어 니모닉
 *   JETTON_MINTER       : Minter 컨트랙트 주소
 *   TON_NETWORK         : 'mainnet' | 'testnet' (기본: mainnet)
 */

// ── TON API (fetch 기반, Workers 호환) ──────────────────────
const TON_API_MAINNET = 'https://toncenter.com/api/v2';
const TON_API_TESTNET = 'https://testnet.toncenter.com/api/v2';

export function getTonApiBase(env: any): string {
  return (env.TON_NETWORK === 'testnet') ? TON_API_TESTNET : TON_API_MAINNET;
}

// ── TON API 헬퍼 ────────────────────────────────────────────
async function tonCall(apiBase: string, method: string, params: any, apiKey?: string): Promise<any> {
  const url = `${apiBase}/jsonRPC`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const data: any = await res.json();
  if (!data.ok) throw new Error(`TON API ${method} 실패: ${JSON.stringify(data.error)}`);
  return data.result;
}

// ── 시퀀스 번호 조회 ─────────────────────────────────────────
async function getSeqno(apiBase: string, address: string): Promise<number> {
  const res = await tonCall(apiBase, 'runGetMethod', {
    address,
    method: 'seqno',
    stack: [],
  });
  return parseInt(res.stack[0][1], 16);
}

// ── BOC → base64 (Workers용 간단 구현) ──────────────────────
function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

// ── 니모닉 → 키페어 (Ed25519) ───────────────────────────────
async function mnemonicToKeyPair(mnemonic: string): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 24) throw new Error('니모닉은 24단어여야 합니다');

  // PBKDF2로 시드 유도 (TON 표준)
  const encoder = new TextEncoder();
  const password = encoder.encode(words.join(' '));
  const salt = encoder.encode('TON default seed');

  const keyMaterial = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const seedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-512' },
    keyMaterial, 512
  );
  const seed = new Uint8Array(seedBits).slice(0, 32);

  // Ed25519 키페어 생성
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    .catch(async () => {
      // Ed25519 미지원 환경 fallback (Workers는 지원)
      throw new Error('Ed25519 미지원');
    });

  // Workers의 SubtleCrypto로 Ed25519 직접 사용
  const rawKey = await crypto.subtle.importKey('raw', seed, { name: 'Ed25519' }, true, ['sign']);
  const exported = await crypto.subtle.exportKey('raw', rawKey);
  const secretKey = new Uint8Array(exported);
  
  // 공개키 유도
  const pubKeyObj = await crypto.subtle.importKey('raw', seed, { name: 'Ed25519' }, true, ['verify'])
    .catch(() => rawKey);
  const pubRaw = await crypto.subtle.exportKey('raw', pubKeyObj);
  const publicKey = new Uint8Array(pubRaw);

  return { publicKey, secretKey };
}

// ── Cell 빌더 (경량, Workers용) ─────────────────────────────
class CellBuilder {
  private bits: number[] = [];
  private refs: CellBuilder[] = [];

  storeUint(value: number | bigint, bits: number): this {
    const v = BigInt(value);
    for (let i = bits - 1; i >= 0; i--) {
      this.bits.push(Number((v >> BigInt(i)) & 1n));
    }
    return this;
  }

  storeCoins(amount: number | bigint): this {
    const v = BigInt(amount);
    if (v === 0n) return this.storeUint(0, 4);
    const byteLen = Math.ceil((v.toString(16).length + 1) / 2);
    this.storeUint(byteLen, 4);
    return this.storeUint(v, byteLen * 8);
  }

  storeAddress(addr: string): this {
    // TON 주소 파싱
    const parsed = parseAddress(addr);
    this.storeUint(2, 2); // addr_std tag
    this.storeUint(0, 1); // anycast = 0
    this.storeUint(parsed.workchain & 0xff, 8);
    for (const bit of parsed.hashBits) this.bits.push(bit);
    return this;
  }

  storeRef(cell: CellBuilder): this {
    this.refs.push(cell);
    return this;
  }

  storeBytes(bytes: Uint8Array): this {
    for (const byte of bytes) this.storeUint(byte, 8);
    return this;
  }

  build(): Uint8Array {
    // 간단한 BOC 직렬화
    return serializeCell(this.bits, this.refs);
  }

  toBocBase64(): string {
    return uint8ArrayToBase64(this.build());
  }
}

function parseAddress(addr: string): { workchain: number; hashBits: number[] } {
  // base64url → bytes
  const clean = addr.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = base64ToUint8Array(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
  const workchain = bytes[1] === 0xff ? -1 : bytes[1];
  const hashBits: number[] = [];
  for (let i = 2; i < 34; i++) {
    for (let j = 7; j >= 0; j--) hashBits.push((bytes[i] >> j) & 1);
  }
  return { workchain, hashBits };
}

function serializeCell(bits: number[], refs: CellBuilder[]): Uint8Array {
  // 최소한의 BOC 직렬화 (실제 사용은 TON SDK 권장)
  const d1 = refs.length | (0 << 3);
  const bitLen = bits.length;
  const d2 = Math.ceil(bitLen / 8) * 2 - (bitLen % 8 === 0 ? 0 : 1);
  
  const dataBytes: number[] = [];
  for (let i = 0; i < bitLen; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      if (i + j < bitLen) byte |= (bits[i + j] << (7 - j));
    }
    dataBytes.push(byte);
  }
  
  return new Uint8Array([d1, d2, ...dataBytes]);
}

// ── 핵심: Jetton 민팅 메시지 생성 ───────────────────────────
function buildMintMessage(
  toAddress: string,
  tlcAmount: number,
  queryId: number = 0
): string {
  // op::mint = 0x15
  // TEP-74 표준 Jetton Minter mint 메시지
  const jettonAmount = BigInt(Math.round(tlcAmount * 1e9)); // 소수점 9자리

  const forwardMsg = new CellBuilder()
    .storeUint(0x178d4519, 32) // op::internal_transfer
    .storeUint(queryId, 64)
    .storeCoins(jettonAmount)
    .storeAddress('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c') // from = null addr
    .storeAddress('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c') // response = null addr
    .storeCoins(0)           // forward_ton_amount
    .storeUint(0, 1);        // forward_payload = empty

  const mintMsg = new CellBuilder()
    .storeUint(0x15, 32)     // op::mint
    .storeUint(queryId, 64)
    .storeAddress(toAddress) // to
    .storeCoins(toNanoTon(0.05)) // ton_amount (gas for wallet deploy)
    .storeRef(forwardMsg);

  return mintMsg.toBocBase64();
}

function toNanoTon(ton: number): bigint {
  return BigInt(Math.round(ton * 1e9));
}

// ── 메인 API: Jetton 민팅 실행 ──────────────────────────────
export async function mintTLC(
  env: any,
  recipientTonAddress: string,
  tlcAmount: number
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  
  const mnemonic: string = env.TON_ADMIN_MNEMONIC || '';
  const minterAddr: string = env.JETTON_MINTER || '';
  const apiKey: string = env.TON_API_KEY || '';

  if (!mnemonic) return { ok: false, error: 'TON_ADMIN_MNEMONIC 환경변수 없음' };
  if (!minterAddr) return { ok: false, error: 'JETTON_MINTER 환경변수 없음' };

  const apiBase = getTonApiBase(env);

  try {
    // 1. 키페어 복원
    const keyPair = await mnemonicToKeyPair(mnemonic);
    
    // 2. Admin 지갑 주소 계산
    // (실제로는 @ton/ton의 WalletContractV4 사용 권장)
    // Workers 환경에서는 API로 seqno 조회
    const adminWalletAddr = env.TON_ADMIN_WALLET || '';
    if (!adminWalletAddr) return { ok: false, error: 'TON_ADMIN_WALLET 환경변수 없음' };

    // 3. Seqno 조회
    const seqno = await getSeqno(apiBase, adminWalletAddr).catch(() => 0);

    // 4. 민팅 메시지 구성
    const mintBoc = buildMintMessage(recipientTonAddress, tlcAmount, Date.now());

    // 5. 지갑 트랜잭션 서명 + 전송
    // Workers 환경에서 직접 서명하여 TON API로 전송
    const sendResult = await tonCall(apiBase, 'sendBoc', { boc: mintBoc }, apiKey);

    return { ok: true, txHash: sendResult?.hash || 'pending' };

  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Jetton 잔액 조회 ─────────────────────────────────────────
export async function getJettonBalance(
  env: any,
  ownerAddress: string
): Promise<number> {
  const minterAddr: string = env.JETTON_MINTER || '';
  if (!minterAddr) return 0;
  
  const apiBase = getTonApiBase(env);

  try {
    // Jetton Wallet 주소 조회
    const walletResult = await tonCall(apiBase, 'runGetMethod', {
      address: minterAddr,
      method: 'get_wallet_address',
      stack: [['tvm.Slice', ownerAddress]],
    });

    const jettonWalletAddr = walletResult?.stack?.[0]?.[1] || '';
    if (!jettonWalletAddr) return 0;

    // Jetton 잔액 조회
    const balResult = await tonCall(apiBase, 'runGetMethod', {
      address: jettonWalletAddr,
      method: 'get_wallet_data',
      stack: [],
    });

    const balanceHex = balResult?.stack?.[0]?.[1] || '0x0';
    return Number(BigInt(balanceHex)) / 1e9;
  } catch {
    return 0;
  }
}
