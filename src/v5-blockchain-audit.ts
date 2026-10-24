/** V5 audit proof primitives. No blockchain transaction is sent by this module. */
export interface AuditEntry {
  accountId: string;
  assetCode: 'TL' | 'TLC';
  amountAtoms: number;
}
export interface AuditTransaction {
  id: string;
  transactionType: string;
  source: string;
  referenceType: string | null;
  referenceId: string | null;
  entries: AuditEntry[];
}
const encoder = new TextEncoder();
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('INVALID_AUDIT_HASH');
  return new Uint8Array(hex.match(/../g)!.map(s => parseInt(s, 16)));
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hash));
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}
/** Explicit field order and sorted ledger entries; never hash display names. */
export function canonicalAuditTransaction(input: AuditTransaction): string {
  if (!input.id || !input.transactionType || !input.source || input.entries.length < 2)
    throw new Error('INVALID_AUDIT_TRANSACTION');
  const entries = input.entries.map(e => {
    if (!e.accountId || !['TL', 'TLC'].includes(e.assetCode) ||
        !Number.isSafeInteger(e.amountAtoms) || e.amountAtoms === 0)
      throw new Error('INVALID_AUDIT_ENTRY');
    return { accountId: e.accountId, assetCode: e.assetCode, amountAtoms: e.amountAtoms };
  }).sort((a,b) => a.accountId.localeCompare(b.accountId) ||
    a.assetCode.localeCompare(b.assetCode) || a.amountAtoms - b.amountAtoms);
  const totals: Record<string, number> = { TL: 0, TLC: 0 };
  for (const entry of entries) {
    totals[entry.assetCode] += entry.amountAtoms;
    if (!Number.isSafeInteger(totals[entry.assetCode])) throw new Error('AUDIT_AMOUNT_OVERFLOW');
  }
  if (totals.TL !== 0 || totals.TLC !== 0) throw new Error('UNBALANCED_AUDIT_TRANSACTION');
  return JSON.stringify({
    schema: 'timelink.v5.audit.transaction.v1',
    id: input.id,
    transactionType: input.transactionType,
    source: input.source,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    entries
  });
}
/** Domain separation prevents leaves being confused with internal Merkle nodes. */
export async function auditLeafHash(input: AuditTransaction): Promise<string> {
  return digest(concat(new Uint8Array([0]), encoder.encode(canonicalAuditTransaction(input))));
}
async function parentHash(left: string, right: string): Promise<string> {
  return digest(concat(new Uint8Array([1]), concat(hexToBytes(left), hexToBytes(right))));
}
/** Duplicates the final leaf at odd-width levels. Inputs must be ordered by batch sequence. */
export async function auditMerkleRoot(leaves: string[]): Promise<string> {
  if (!leaves.length) throw new Error('EMPTY_AUDIT_BATCH');
  let level = leaves.map(h => { hexToBytes(h); return h; });
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(await parentHash(level[i], level[i+1] ?? level[i]));
    level = next;
  }
  return level[0];
}
export async function auditMerkleProof(leaves: string[], index: number):
  Promise<Array<{hash: string; side: 'left' | 'right'}>> {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
    throw new Error('INVALID_AUDIT_LEAF_INDEX');
  let level = leaves.map(h => { hexToBytes(h); return h; });
  let position = index;
  const proof: Array<{hash: string; side: 'left' | 'right'}> = [];
  while (level.length > 1) {
    const sibling = position ^ 1;
    proof.push({hash: level[sibling] ?? level[position],
      side: position % 2 === 0 ? 'right' : 'left'});
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(await parentHash(level[i], level[i+1] ?? level[i]));
    level = next;
    position = Math.floor(position / 2);
  }
  return proof;
}
export async function verifyAuditMerkleProof(leaf: string,
  proof: Array<{hash: string; side: 'left' | 'right'}>, root: string): Promise<boolean> {
  hexToBytes(leaf);
  hexToBytes(root);
  let current = leaf;
  for (const step of proof) {
    if (step.side !== 'left' && step.side !== 'right') throw new Error('INVALID_AUDIT_PROOF');
    current = step.side === 'left'
      ? await parentHash(step.hash, current)
      : await parentHash(current, step.hash);
  }
  return current === root;
}
