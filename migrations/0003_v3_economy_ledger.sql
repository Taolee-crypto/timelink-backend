-- TimeLink V3 additive economy ledger foundation
-- This migration creates new V3 tables only. It does not alter, copy, or delete legacy data.
-- Amounts are integer atoms: TL uses 1 atom = 1 TL; TLC uses 1 atom = 10^-9 TLC.
-- POC is a contribution index, not a transferable currency or wallet asset.

CREATE TABLE IF NOT EXISTS v3_economy_assets (
  asset_code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 12),
  is_transferable INTEGER NOT NULL DEFAULT 1 CHECK (is_transferable IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO v3_economy_assets (asset_code, display_name, decimals, is_transferable)
VALUES
  ('TL', 'TimeLink Unit', 0, 1),
  ('TLC', 'TimeLink Coin', 9, 1);

CREATE TABLE IF NOT EXISTS v3_economy_accounts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','platform','escrow','system','partner')),
  owner_id TEXT NOT NULL,
  asset_code TEXT NOT NULL REFERENCES v3_economy_assets(asset_code),
  bucket TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_type, owner_id, asset_code, bucket)
);

CREATE TABLE IF NOT EXISTS v3_economy_balances (
  account_id TEXT PRIMARY KEY REFERENCES v3_economy_accounts(id),
  available_atoms INTEGER NOT NULL DEFAULT 0 CHECK (available_atoms >= 0),
  held_atoms INTEGER NOT NULL DEFAULT 0 CHECK (held_atoms >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS v3_economy_transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status = 'posted'),
  source TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  actor_user_id TEXT,
  description TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS v3_economy_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES v3_economy_transactions(id),
  account_id TEXT NOT NULL REFERENCES v3_economy_accounts(id),
  asset_code TEXT NOT NULL REFERENCES v3_economy_assets(asset_code),
  amount_atoms INTEGER NOT NULL CHECK (amount_atoms <> 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_v3_economy_entries_transaction
  ON v3_economy_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_v3_economy_entries_account_time
  ON v3_economy_entries(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_v3_economy_transactions_reference
  ON v3_economy_transactions(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_v3_economy_transactions_actor_time
  ON v3_economy_transactions(actor_user_id, created_at);

-- POC events are verified contribution facts. They are deliberately separate from TL/TLC.
CREATE TABLE IF NOT EXISTS v3_poc_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_reference TEXT,
  base_value REAL NOT NULL DEFAULT 0,
  contribution_value REAL NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'verified'
    CHECK (verification_status IN ('pending','verified','rejected','reversed')),
  formula_version TEXT NOT NULL,
  metadata_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_v3_poc_events_user_time
  ON v3_poc_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_v3_poc_events_source
  ON v3_poc_events(source, source_reference);

CREATE TABLE IF NOT EXISTS v3_poc_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  poc_index REAL NOT NULL CHECK (poc_index >= 0.1 AND poc_index <= 5.0),
  components_json TEXT NOT NULL,
  formula_version TEXT NOT NULL,
  source_event_count INTEGER NOT NULL DEFAULT 0,
  calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, period_start, period_end, formula_version)
);

CREATE INDEX IF NOT EXISTS idx_v3_poc_snapshots_user_period
  ON v3_poc_snapshots(user_id, period_end);

CREATE TABLE IF NOT EXISTS v3_tlc_mining_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  period_date TEXT NOT NULL,
  poc_snapshot_id TEXT REFERENCES v3_poc_snapshots(id),
  eligible_tl_spend_atoms INTEGER NOT NULL DEFAULT 0 CHECK (eligible_tl_spend_atoms >= 0),
  poc_index REAL NOT NULL CHECK (poc_index >= 0.1 AND poc_index <= 5.0),
  plan_code TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  requested_atoms INTEGER NOT NULL DEFAULT 0 CHECK (requested_atoms >= 0),
  minted_atoms INTEGER NOT NULL DEFAULT 0 CHECK (minted_atoms >= 0),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted','rejected','reversed')),
  chain_tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, period_date)
);

CREATE INDEX IF NOT EXISTS idx_v3_tlc_mining_user_date
  ON v3_tlc_mining_records(user_id, period_date);

-- Records the provenance and reconciliation state of each legacy balance import.
-- No legacy balance is imported by this schema migration.
CREATE TABLE IF NOT EXISTS v3_economy_legacy_imports (
  id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  legacy_bucket TEXT NOT NULL,
  source_amount TEXT NOT NULL,
  target_account_id TEXT REFERENCES v3_economy_accounts(id),
  imported_atoms INTEGER,
  source_checksum TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (reconciliation_status IN ('pending','matched','imported','quarantined','conflict')),
  notes TEXT,
  imported_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_table, source_row_id, source_field)
);

CREATE INDEX IF NOT EXISTS idx_v3_legacy_imports_status
  ON v3_economy_legacy_imports(reconciliation_status);

-- Posted ledger facts and POC/mining evidence are append-only.
CREATE TRIGGER IF NOT EXISTS trg_v3_economy_transactions_no_update
BEFORE UPDATE ON v3_economy_transactions
BEGIN
  SELECT RAISE(ABORT, 'V3 economy transactions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_economy_transactions_no_delete
BEFORE DELETE ON v3_economy_transactions
BEGIN
  SELECT RAISE(ABORT, 'V3 economy transactions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_economy_entries_no_update
BEFORE UPDATE ON v3_economy_entries
BEGIN
  SELECT RAISE(ABORT, 'V3 economy entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_economy_entries_no_delete
BEFORE DELETE ON v3_economy_entries
BEGIN
  SELECT RAISE(ABORT, 'V3 economy entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_poc_events_no_update
BEFORE UPDATE ON v3_poc_events
BEGIN
  SELECT RAISE(ABORT, 'V3 POC events are immutable; record a compensating event');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_poc_events_no_delete
BEFORE DELETE ON v3_poc_events
BEGIN
  SELECT RAISE(ABORT, 'V3 POC events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_tlc_mining_no_delete
BEFORE DELETE ON v3_tlc_mining_records
BEGIN
  SELECT RAISE(ABORT, 'V3 TLC mining records are immutable');
END;

-- Keep cached balances non-negative and prevent cross-asset postings.
CREATE TRIGGER IF NOT EXISTS trg_v3_balances_nonnegative
BEFORE UPDATE ON v3_economy_balances
WHEN NEW.available_atoms < 0 OR NEW.held_atoms < 0
BEGIN
  SELECT RAISE(ABORT, 'V3 account balance cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_entries_asset_matches_account
BEFORE INSERT ON v3_economy_entries
WHEN (SELECT asset_code FROM v3_economy_accounts WHERE id = NEW.account_id) <> NEW.asset_code
BEGIN
  SELECT RAISE(ABORT, 'V3 entry asset does not match account asset');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_poc_snapshots_no_update
BEFORE UPDATE ON v3_poc_snapshots
BEGIN
  SELECT RAISE(ABORT, 'V3 POC snapshots are immutable; create a new formula version');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_poc_snapshots_no_delete
BEFORE DELETE ON v3_poc_snapshots
BEGIN
  SELECT RAISE(ABORT, 'V3 POC snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_tlc_mining_posted_no_update
BEFORE UPDATE ON v3_tlc_mining_records
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'Posted V3 TLC mining records are immutable');
END;
