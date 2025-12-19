/**
 * auth.js
 *  - 6자리 코드 생성, Cloudflare KV에 저장/검증 로직
 *  - TTL 기반 만료(5분)
 */

export function generateCode() {
  // 6자리 숫자 (100000~999999)
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * saveCode
 * @param {KVNamespace} AUTH_CODES - wrangler toml 바인딩 이름
 * @param {string} email
 * @param {string} code
 */
export async function saveCode(AUTH_CODES, email, code) {
  if (!AUTH_CODES) throw new Error("AUTH_CODES KV binding is not provided");

  const payload = {
    code,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes (ms)
  };

  // KV의 expirationTtl은 초 단위
  await AUTH_CODES.put(normalizeEmail(email), JSON.stringify(payload), { expirationTtl: 5 * 60 });
}

/**
 * verifyCode
 * @param {KVNamespace} AUTH_CODES
 * @param {string} email
 * @param {string} code
 * @returns {object} { ok: boolean, reason?: string }
 */
export async function verifyCode(AUTH_CODES, email, code) {
  if (!AUTH_CODES) throw new Error("AUTH_CODES KV binding is not provided");

  const raw = await AUTH_CODES.get(normalizeEmail(email));
  if (!raw) return { ok: false, reason: "NO_CODE" };

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // corrupt data -> delete and fail
    await AUTH_CODES.delete(normalizeEmail(email));
    return { ok: false, reason: "CORRUPT" };
  }

  if (Date.now() > data.expiresAt) {
    await AUTH_CODES.delete(normalizeEmail(email));
    return { ok: false, reason: "EXPIRED" };
  }

  if (data.code !== code) {
    return { ok: false, reason: "INVALID" };
  }

  // 성공하면 KV에서 삭제
  await AUTH_CODES.delete(normalizeEmail(email));
  return { ok: true };
}

/**
 * Normalize email as key (simple lowercasing; do NOT use as sole security measure)
 */
function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}
