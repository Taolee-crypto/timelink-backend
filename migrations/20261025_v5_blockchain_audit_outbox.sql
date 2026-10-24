-- V5 audit outbox foundation. Apply with the project's migration runner before enabling anchoring.
-- This table stores only internal transaction identifiers; never expose directly on-chain.
CREATE TABLE IF NOT EXISTS v5_blockchain_audit_outbox (
  transaction_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sealed','anchored','error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_batch_id TEXT,
  last_error TEXT,
  FOREIGN KEY(transaction_id) REFERENCES v3_economy_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_v5_audit_outbox_status_created ON v5_blockchain_audit_outbox(status, created_at);
-- SQLite trigger runs in the same transaction as the original ledger INSERT.
-- Any failure rolls back the ledger insert too. Existing rows are intentionally NOT backfilled.
CREATE TRIGGER IF NOT EXISTS trg_v5_economy_audit_enqueue
AFTER INSERT ON v3_economy_transactions
BEGIN
  INSERT INTO v5_blockchain_audit_outbox(transaction_id) VALUES (NEW.id);
END;
