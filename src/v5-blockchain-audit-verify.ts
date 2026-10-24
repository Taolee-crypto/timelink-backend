import { auditMerkleRoot, auditMerkleProof, verifyAuditMerkleProof } from './v5-blockchain-audit';

/** Read-only verification of a sealed audit batch against stored immutable leaf hashes. */
export async function verifyStoredV5AuditBatch(db: D1Database, batchId: string) {
  if (!batchId || batchId.length > 128) throw new Error('INVALID_AUDIT_BATCH_ID');
  const batch = await db.prepare(
    'SELECT id,merkle_root,leaf_count,status FROM v5_blockchain_audit_batches WHERE id=?'
  ).bind(batchId).first<{id:string;merkle_root:string;leaf_count:number;status:string}>();
  if (!batch) throw new Error('AUDIT_BATCH_NOT_FOUND');
  const rows = await db.prepare(
    'SELECT leaf_index,transaction_id,leaf_hash FROM v5_blockchain_audit_batch_leaves WHERE batch_id=? ORDER BY leaf_index'
  ).bind(batchId).all<{leaf_index:number;transaction_id:string;leaf_hash:string}>();
  const leaves = rows.results || [];
  if (leaves.length !== Number(batch.leaf_count)) return {batchId, valid:false, reason:'LEAF_COUNT_MISMATCH'};
  if (leaves.some((row,i) => Number(row.leaf_index) !== i)) return {batchId, valid:false, reason:'LEAF_SEQUENCE_GAP'};
  const root = await auditMerkleRoot(leaves.map(row => row.leaf_hash));
  return {batchId,valid:root === batch.merkle_root,root,expectedRoot:batch.merkle_root,count:leaves.length};
}

/** Produce a proof for an individual transaction; recompute root before returning. */
export async function getV5AuditTransactionProof(db: D1Database, transactionId: string) {
  if (!transactionId || transactionId.length > 128) throw new Error('INVALID_AUDIT_TRANSACTION_ID');
  const row = await db.prepare(
    'SELECT batch_id,leaf_index,leaf_hash FROM v5_blockchain_audit_batch_leaves WHERE transaction_id=?'
  ).bind(transactionId).first<{batch_id:string;leaf_index:number;leaf_hash:string}>();
  if (!row) return null;
  const verified = await verifyStoredV5AuditBatch(db,row.batch_id);
  if (!verified.valid || !verified.root) throw new Error('AUDIT_BATCH_INTEGRITY_FAILED');
  const result = await db.prepare(
    'SELECT leaf_hash FROM v5_blockchain_audit_batch_leaves WHERE batch_id=? ORDER BY leaf_index'
  ).bind(row.batch_id).all<{leaf_hash:string}>();
  const leaves = (result.results || []).map(item => item.leaf_hash);
  const proof = await auditMerkleProof(leaves,Number(row.leaf_index));
  const valid = await verifyAuditMerkleProof(row.leaf_hash,proof,verified.root);
  if (!valid) throw new Error('AUDIT_PROOF_VERIFICATION_FAILED');
  return {transactionId,batchId:row.batch_id,leafHash:row.leaf_hash,
    merkleRoot:verified.root,leafIndex:Number(row.leaf_index),proof,valid};
}
