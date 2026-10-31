-- Fractional TL carry is internal only. Wallets and externally payable TL remain whole numbers.
-- Apply through the normal migration process before wiring settlement writers.
CREATE TABLE IF NOT EXISTS v5_tl_fractional_carry (
  carry_key TEXT PRIMARY KEY,
  beneficiary_type TEXT NOT NULL CHECK (beneficiary_type IN ('creator','platform','user','escrow')),
  beneficiary_id TEXT NOT NULL,
  funding_source TEXT NOT NULL,
  policy_code TEXT NOT NULL,
  carry_atoms INTEGER NOT NULL DEFAULT 0 CHECK (carry_atoms >= 0 AND carry_atoms < 10000),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS v5_tl_fractional_carry_events (
  event_key TEXT PRIMARY KEY,
  carry_key TEXT NOT NULL REFERENCES v5_tl_fractional_carry(carry_key),
  earned_atoms INTEGER NOT NULL CHECK (earned_atoms >= 0),
  paid_whole_tl INTEGER NOT NULL CHECK (paid_whole_tl >= 0),
  carry_before_atoms INTEGER NOT NULL CHECK (carry_before_atoms >= 0 AND carry_before_atoms < 10000),
  carry_after_atoms INTEGER NOT NULL CHECK (carry_after_atoms >= 0 AND carry_after_atoms < 10000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
