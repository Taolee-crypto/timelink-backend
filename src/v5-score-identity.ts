/** GitHub workload identity; no long-lived CI secret or encryption key. */
const ISSUER = 'https://token.actions.githubusercontent.com';
export const SCORE_AUDIENCE = 'https://api.timelink.digital/v5-vocal-score';
const REPO = 'Taolee-crypto/timelink-backend';
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export function validateScoreClaims(p: Record<string, unknown>, now = Date.now()/1000): string {
  if (p.iss !== ISSUER || p.aud !== SCORE_AUDIENCE ||
      p.repository !== REPO || p.repository_id !== '1162984214' || p.repository_owner_id !== '85010918' ||
      p.ref !== 'refs/heads/main' || p.sub !== `repo:${REPO}:environment:production` ||
      p.environment !== 'production' || p.runner_environment !== 'github-hosted' ||
      p.workflow_ref !== `${REPO}/.github/workflows/v5-vocal-inference.yml@refs/heads/main` ||
      !['schedule','workflow_dispatch','workflow_run'].includes(String(p.event_name)) ||
      typeof p.exp !== 'number' || p.exp <= now || typeof p.nbf !== 'number' || p.nbf > now + 30 ||
      typeof p.iat !== 'number' || p.iat > now + 30 || now - p.iat > 600 ||
      !/^\d+$/.test(String(p.run_id)) || !/^\d+$/.test(String(p.run_attempt))) throw Error('INVALID_WORKLOAD');
  return `${p.run_id}:${p.run_attempt}`;
}
export async function verifyScoreIdentity(authorization: string): Promise<string | null> {
  try {
    if (!authorization.startsWith('Bearer ') || authorization.length > 16000) return null;
    const parts = authorization.slice(7).split('.');
    if(parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    const identity = validateScoreClaims(claims);
    if(header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const response = await fetch(ISSUER + '/.well-known/jwks', {signal: AbortSignal.timeout(10000), redirect:'manual'});
    if(!response.ok) return null;
    const jwks = await response.json<{keys: (JsonWebKey & {kid?:string})[]}>();
    const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && k.alg === 'RS256');
    if(!jwk) return null;
    const key = await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
    return valid ? identity : null;
  } catch { return null; }
}
