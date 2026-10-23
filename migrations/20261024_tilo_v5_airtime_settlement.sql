-- TILO V5 verified broadcaster evidence, durable deduplication, and settlement checkpoints.
-- This migration is storage-only: it does not credit or debit any TL account.
CREATE TABLE IF NOT EXISTS tilo_v5_verified_airtime (
  event_id TEXT PRIMARY KEY,
  country TEXT NOT NULL CHECK(country IN ('KR','JP','US','CN','TH','VN')),
  service_id TEXT NOT NULL,
  creator_id INTEGER NOT NULL CHECK(creator_id > 0),
  file_id INTEGER NOT NULL CHECK(file_id > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  local_month TEXT NOT NULL,
  audible_ms INTEGER NOT NULL CHECK(audible_ms > 0 AND audible_ms <= 3600000),
  creator_atoms INTEGER NOT NULL CHECK(creator_atoms >= 0),
  platform_atoms INTEGER NOT NULL CHECK(platform_atoms >= 0),
  evidence_digest TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(local_month)=7)
);
CREATE INDEX IF NOT EXISTS idx_tilo_v5_airtime_month_creator
  ON tilo_v5_verified_airtime(country,local_month,creator_id);
CREATE INDEX IF NOT EXISTS idx_tilo_v5_airtime_service
  ON tilo_v5_verified_airtime(service_id,started_at);
CREATE TABLE IF NOT EXISTS tilo_v5_monthly_settlement_checkpoints (
  country TEXT NOT NULL CHECK(country IN ('KR','JP','US','CN','TH','VN')),
  local_month TEXT NOT NULL,
  creator_id INTEGER NOT NULL CHECK(creator_id > 0),
  gross_creator_atoms INTEGER NOT NULL DEFAULT 0 CHECK(gross_creator_atoms >= 0),
  contribution_atoms INTEGER NOT NULL DEFAULT 0 CHECK(contribution_atoms >= 0),
  policy_version TEXT NOT NULL,
  last_settlement_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(country,local_month,creator_id)
);
CREATE TABLE IF NOT EXISTS tilo_v5_settlement_runs (
  settlement_id TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  local_date TEXT NOT NULL,
  creator_id INTEGER NOT NULL CHECK(creator_id > 0),
  gross_creator_atoms INTEGER NOT NULL CHECK(gross_creator_atoms >= 0),
  contribution_atoms INTEGER NOT NULL CHECK(contribution_atoms >= 0),
  ledger_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(country,local_date,creator_id)
);
