-- V3 ledger opening-balance support.
-- Only the dedicated system/genesis_equity control account may carry a negative balance.
-- User, escrow, partner, and ordinary platform accounts remain non-negative.

CREATE TABLE v3_economy_balances_new (
  account_id TEXT PRIMARY KEY REFERENCES v3_economy_accounts(id),
  available_atoms INTEGER NOT NULL DEFAULT 0,
  held_atoms INTEGER NOT NULL DEFAULT 0 CHECK (held_atoms >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO v3_economy_balances_new
  (account_id, available_atoms, held_atoms, version, updated_at)
SELECT account_id, available_atoms, held_atoms, version, updated_at
FROM v3_economy_balances;

DROP TRIGGER IF EXISTS trg_v3_balances_nonnegative;
DROP TABLE v3_economy_balances;
ALTER TABLE v3_economy_balances_new RENAME TO v3_economy_balances;

CREATE TRIGGER trg_v3_balances_nonnegative
BEFORE UPDATE ON v3_economy_balances
WHEN NEW.held_atoms < 0
  OR (
    NEW.available_atoms < 0
    AND NOT EXISTS (
      SELECT 1 FROM v3_economy_accounts a
      WHERE a.id = NEW.account_id
        AND a.owner_type = 'system'
        AND a.bucket = 'genesis_equity'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Only system genesis equity may have a negative available balance');
END;

CREATE TRIGGER trg_v3_balances_insert_nonnegative
BEFORE INSERT ON v3_economy_balances
WHEN NEW.held_atoms < 0
  OR (
    NEW.available_atoms < 0
    AND NOT EXISTS (
      SELECT 1 FROM v3_economy_accounts a
      WHERE a.id = NEW.account_id
        AND a.owner_type = 'system'
        AND a.bucket = 'genesis_equity'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Only system genesis equity may have a negative available balance');
END;

CREATE TABLE IF NOT EXISTS v3_economy_opening_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','posting','posted','rejected')),
  created_by TEXT NOT NULL,
  approved_by TEXT,
  reason TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  posted_at TEXT
);

CREATE TABLE IF NOT EXISTS v3_economy_opening_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES v3_economy_opening_batches(id),
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  amount_atoms INTEGER NOT NULL CHECK (amount_atoms > 0),
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  evidence_note TEXT NOT NULL,
  ledger_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','posted','conflict')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at TEXT,
  UNIQUE (batch_id, user_id, bucket, source_table, source_row_id, source_field)
);

CREATE INDEX IF NOT EXISTS idx_v3_opening_items_batch
  ON v3_economy_opening_items(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_v3_opening_items_user
  ON v3_economy_opening_items(user_id, bucket);

-- A source field can be imported only once across all opening batches.
CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_opening_source_once
  ON v3_economy_opening_items(user_id, bucket, source_table, source_row_id, source_field);
