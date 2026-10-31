-- TL -> TLC escrow orders. Apply through the existing migration pipeline before enabling trading.
-- All TL quantities are whole units; TLC is represented in nano-TLC atoms.
CREATE TABLE IF NOT EXISTS v5_exchange_orders (
 order_id TEXT PRIMARY KEY,
 owner_user_id INTEGER NOT NULL CHECK(owner_user_id>0),
 idempotency_key TEXT NOT NULL,
 tl_amount INTEGER NOT NULL CHECK(tl_amount>0),
 tlc_atoms INTEGER NOT NULL CHECK(tlc_atoms>0),
 quote_id TEXT NOT NULL,
 quote_expires_at TEXT NOT NULL,
 wallet_address TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reserved','settling','settled','cancelled','expired','failed')),
 reservation_ledger_id TEXT UNIQUE,
 payout_tx_hash TEXT UNIQUE,
 payout_confirmed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_user_id,idempotency_key),
 CHECK(status!='settled' OR (reservation_ledger_id IS NOT NULL AND payout_tx_hash IS NOT NULL AND payout_confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_v5_exchange_owner_created ON v5_exchange_orders(owner_user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS v5_exchange_events (
 event_id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES v5_exchange_orders(order_id),
 event_type TEXT NOT NULL,
 ledger_entry_id TEXT,
 chain_tx_hash TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,event_type,ledger_entry_id,chain_tx_hash)
);
CREATE TABLE IF NOT EXISTS v5_exchange_policy (
 policy_id INTEGER PRIMARY KEY CHECK(policy_id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 tlc_jetton_master TEXT,
 quote_tlc_atoms_per_tl INTEGER CHECK(quote_tlc_atoms_per_tl>0),
 min_tl INTEGER NOT NULL DEFAULT 1,
 max_tl INTEGER NOT NULL DEFAULT 10000,
 daily_tl_limit INTEGER NOT NULL DEFAULT 10000,
 liquidity_tlc_atoms INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(enabled=0 OR (tlc_jetton_master IS NOT NULL AND quote_tlc_atoms_per_tl IS NOT NULL))
);
INSERT OR IGNORE INTO v5_exchange_policy(policy_id,enabled) VALUES(1,0);
