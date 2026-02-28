import type { JWTPayload } from './types';

// ── Password hashing (PBKDF2 via Web Crypto) ──
export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = new Uint8Array(bits);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2,'0')).join('');
  const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2,'0')).join('');
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = new Uint8Array(bits);
  const computedHex = Array.from(hash).map(b => b.toString(16).padStart(2,'0')).join('');
  return computedHex === hashHex;
}

// ── JWT (HMAC-SHA256) ──
async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str: string): string {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

export async function createToken(payload: JWTPayload, secret: string): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

export async function verifyToken(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const [header, body, sig] = token.split('.');
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key,
      new Uint8Array(base64urlDecode(sig).split('').map(c => c.charCodeAt(0))),
      new TextEncoder().encode(`${header}.${body}`)
    );
    if (!valid) return null;
    const payload: JWTPayload = JSON.parse(base64urlDecode(body));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function makeAccessToken(userId: number, secret: string): Promise<string> {
  return createToken(
    { sub: String(userId), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 },
    secret
  );
}
