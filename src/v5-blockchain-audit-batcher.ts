import { auditLeafHash, auditMerkleRoot, type AuditTransaction } from './v5-blockchain-audit';

/**
 * Seal a bounded batch of V5 ledger postings. Invoke from a single scheduled worker.
 * The outbox claim is conditional; the D1 batch is atomic. Never sends TON transactions.
 */
export async function sealV5AuditBatch(db: D1Database, limit = 100): Promise<
  { status: 'empty' | 'sealed'; batchId?: string; count?: number; root?: string }
> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_AUDIT_BATCH_LIMIT');
  const pending = await db.prepare(`
    SELECT o.transaction_id
    FROM v5_blockchain_audit_outbox o
    WHERE o.status='pending'
    ORDER BY o.created_at ASC, o.transaction_id ASC
    LIMIT ?
  `).bind(limit).all<{transaction_id: string}>();
  const ids = (pending.results || []).map(row => row.transaction_id);
  if (!ids.length) return {status:'empty'};

  const transactions: AuditTransaction[] = [];
  for (const id of ids) {
    const tx = await db.prepare(`
      SELECT id,transaction_type,source,reference_type,reference_id
      FROM v3_economy_transactions WHERE id=?
    `).bind(id).first<any>();
    if (!tx) throw new Error('AUDIT_TRANSACTION_MISSING:'+id);
    const entries = await db.prepare(`
      SELECT account_id AS accountId, asset_code AS assetCode, amount_atoms AS amountAtoms
      FROM v3_economy_entries WHERE transaction_id=?
      ORDER BY account_id, asset_code, amount_atoms
    `).bind(id).all<any>();
    transactions.push({
      id: String(tx.id), transactionType: String(tx.transaction_type),
      source: String(tx.source), referenceType: tx.reference_type ?? null,
      referenceId: tx.reference_id ?? null,
      entries: (entries.results || []).map((e:any) => ({
        accountId: String(e.accountId), assetCode: e.assetCode,
        amountAtoms: Number(e.amountAtoms)
      }))
    });
  }

  const leaves = await Promise.all(transactions.map(auditLeafHash));
  const root = await auditMerkleRoot(leaves);
  const batchId = crypto.randomUUID();
  // D1 batches are atomic. A stale concurrent sealer must fail rather than double-seal.
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO v5_blockchain_audit_batches
      (id,merkle_root,leaf_count,first_transaction_id,last_transaction_id)
      VALUES (?,?,?,?,?)`).bind(batchId,root,ids.length,ids[0],ids[ids.length-1])
  ];
  for (let i=0; i<ids.length; i++) {
    statements.push(db.prepare(`INSERT INTO v5_blockchain_audit_batch_leaves
      (batch_id,leaf_index,transaction_id,leaf_hash) VALUES (?,?,?,?)`)
      .bind(batchId,i,ids[i],leaves[i]));
    // Constraint failure aborts entire batch if another worker already claimed the transaction.
    statements.push(db.prepare(`UPDATE v5_blockchain_audit_outbox
      SET status='sealed',sealed_batch_id=?
      WHERE transaction_id=? AND status='pending'`).bind(batchId,ids[i]));
  }
  // Concurrent sealers may race. The UNIQUE(transaction_id) leaf constraint prevents duplicates.
  await db.batch(statements);
  return {status:'sealed',batchId,count:ids.length,root};
}
