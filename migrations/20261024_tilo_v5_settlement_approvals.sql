-- TILO V5: separate administrator approval from financial posting.
-- This migration does not enable payouts or expose a public settlement endpoint.
CREATE TABLE IF NOT EXISTS tilo_v5_settlement_approvals (
  settlement_id TEXT PRIMARY KEY,
  country TEXT NOT NULL CHECK(country IN ('KR','JP','US','CN','TH','VN')),
  local_date TEXT NOT NULL,
  creator_id INTEGER NOT NULL CHECK(creator_id > 0),
  local_month TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
  evidence_event_count INTEGER NOT NULL CHECK(evidence_event_count > 0),
  previous_monthly_creator_gross_atoms INTEGER NOT NULL CHECK(previous_monthly_creator_gross_atoms >= 0),
  new_creator_gross_atoms INTEGER NOT NULL CHECK(new_creator_gross_atoms > 0),
  new_platform_share_atoms INTEGER NOT NULL CHECK(new_platform_share_atoms >= 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','posted')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by_admin_user_id INTEGER,
  review_note TEXT,
  posted_transaction_id TEXT UNIQUE,
  posted_at TEXT,
  CHECK(local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK(local_month = substr(local_date,1,7)),
  CHECK((state IN ('pending','rejected') AND posted_transaction_id IS NULL)
     OR state IN ('approved','posted')),
  CHECK(state != 'approved' OR (reviewed_at IS NOT NULL AND reviewed_by_admin_user_id IS NOT NULL)),
  CHECK(state != 'posted' OR (posted_transaction_id IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tilo_v5_approval_scope
 ON tilo_v5_settlement_approvals(country,local_date,creator_id);
CREATE INDEX IF NOT EXISTS idx_tilo_v5_approval_pending
 ON tilo_v5_settlement_approvals(state,requested_at);
CREATE TABLE IF NOT EXISTS tilo_v5_settlement_approval_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id TEXT NOT NULL REFERENCES tilo_v5_settlement_approvals(settlement_id),
  action TEXT NOT NULL CHECK(action IN ('request','approve','reject','post')),
  actor_user_id INTEGER,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT,
  evidence_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tilo_v5_approval_audit_id
 ON tilo_v5_settlement_approval_audit(settlement_id,id);
