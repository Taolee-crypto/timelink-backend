-- Audit batches: deterministic, immutable commitments prepared for TON anchoring.
-- Deploy only after 20261025_v5_blockchain_audit_outbox.sql.
CREATE TABLE IF NOT EXISTS v5_blockchain_audit_batches (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  merkle_root TEXT NOT NULL CHECK(length(merkle_root) = 64),
  leaf_count INTEGER NOT NULL CHECK(leaf_count > 0),
  first_transaction_id TEXT NOT NULL,
  last_transaction_id TEXT NOT NULL,
  previous_batch_id TEXT,
  previous_merkle_root TEXT,
  status TEXT NOT NULL DEFAULT 'sealed' CHECK(status IN ('sealed','submitted','confirmed','error')),
  ton_tx_hash TEXT,
  ton_confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS v5_blockchain_audit_batch_leaves (
  batch_id TEXT NOT NULL,
  leaf_index INTEGER NOT NULL CHECK(leaf_index >= 0),
  transaction_id TEXT NOT NULL UNIQUE,
  leaf_hash TEXT NOT NULL CHECK(length(leaf_hash) = 64),
  PRIMARY KEY(batch_id, leaf_index),
  FOREIGN KEY(batch_id) REFERENCES v5_blockchain_audit_batches(id),
  FOREIGN KEY(transaction_id) REFERENCES v3_economy_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_v5_audit_batches_status ON v5_blockchain_audit_batches(status, created_at);
-- A batch's proof material must not change after sealing. State changes are handled separately.
CREATE TRIGGER IF NOT EXISTS trg_v5_audit_batch_no_delete BEFORE DELETE ON v5_blockchain_audit_batches
BEGIN SELECT RAISE(ABORT,'AUDIT_BATCH_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_v5_audit_batch_no_rewrite BEFORE UPDATE OF merkle_root,leaf_count,first_transaction_id,last_transaction_id,previous_batch_id,previous_merkle_root ON v5_blockchain_audit_batches
BEGIN SELECT RAISE(ABORT,'AUDIT_BATCH_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_v5_audit_leaf_no_update BEFORE UPDATE ON v5_blockchain_audit_batch_leaves
BEGIN SELECT RAISE(ABORT,'AUDIT_LEAF_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_v5_audit_leaf_no_delete BEFORE DELETE ON v5_blockchain_audit_batch_leaves
BEGIN SELECT RAISE(ABORT,'AUDIT_LEAF_IMMUTABLE'); END;
