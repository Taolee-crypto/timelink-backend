-- V5 overseas TLC sale marketplace. No TL asset and no reverse conversion.
-- Feature remains disabled until identity, travel, payment provider and TON escrow are verified.
CREATE TABLE IF NOT EXISTS v5_travel_p2p_policy (
 country_code TEXT PRIMARY KEY CHECK(length(country_code)=2),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 max_trade_usd_cents INTEGER NOT NULL DEFAULT 50000 CHECK(max_trade_usd_cents>0),
 daily_limit_usd_cents INTEGER NOT NULL DEFAULT 50000 CHECK(daily_limit_usd_cents>0),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS v5_travel_p2p_orders (
 id TEXT PRIMARY KEY,
 seller_user_id INTEGER NOT NULL,
 seller_home_country TEXT NOT NULL CHECK(length(seller_home_country)=2),
 destination_country TEXT NOT NULL CHECK(length(destination_country)=2),
 currency_code TEXT NOT NULL CHECK(length(currency_code)=3),
 tlc_nano TEXT NOT NULL CHECK(length(tlc_nano)>0 AND tlc_nano NOT GLOB '*[^0-9]*' AND CAST(tlc_nano AS INTEGER)>0),
 fiat_minor INTEGER NOT NULL CHECK(fiat_minor>0),
 usd_equivalent_cents INTEGER NOT NULL CHECK(usd_equivalent_cents>0),
 exchange_rate_snapshot TEXT NOT NULL,
 payout_provider TEXT NOT NULL,
 payout_reference TEXT NOT NULL,
 seller_ton_address TEXT NOT NULL,
 escrow_deposit_reference TEXT UNIQUE,
 buyer_user_id INTEGER,
 buyer_ton_address TEXT,
 payment_provider_reference TEXT UNIQUE,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','pending_escrow','open','matched','payment_pending','payment_verified','release_pending','completed','cancelled','disputed','refunded')),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 CHECK(seller_home_country<>destination_country),
 CHECK(buyer_user_id IS NULL OR buyer_user_id<>seller_user_id)
);
CREATE INDEX IF NOT EXISTS idx_v5_travel_p2p_market ON v5_travel_p2p_orders(destination_country,state,created_at);
CREATE INDEX IF NOT EXISTS idx_v5_travel_p2p_seller ON v5_travel_p2p_orders(seller_user_id,created_at);
CREATE TABLE IF NOT EXISTS v5_travel_p2p_events (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES v5_travel_p2p_orders(id),
 actor_user_id INTEGER,
 event_type TEXT NOT NULL,
 evidence_reference TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v5_travel_p2p_events_order ON v5_travel_p2p_events(order_id,created_at);
-- Escrow receipt and fiat payment confirmation must be attested by trusted workers.
-- Browser-submitted payment flags must never release TLC.
