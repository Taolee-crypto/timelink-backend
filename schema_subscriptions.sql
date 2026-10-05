CREATE TABLE IF NOT EXISTS cafe_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cafe_channel_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'basic',
  status TEXT NOT NULL DEFAULT 'trialing',
  trial_started_at INTEGER,
  trial_ends_at INTEGER,
  current_period_start INTEGER,
  current_period_end INTEGER,
  amount_tl REAL DEFAULT 50000,
  discount_code TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  canceled_at INTEGER,
  auto_renew INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_cafe ON cafe_subscriptions(cafe_channel_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_owner ON cafe_subscriptions(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_trial ON cafe_subscriptions(status, trial_ends_at);

CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  amount_tl REAL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_event ON subscription_events(subscription_id, created_at);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value REAL NOT NULL,
  applies_to TEXT NOT NULL,
  max_uses INTEGER,
  uses INTEGER DEFAULT 0,
  per_user_limit INTEGER DEFAULT 1,
  starts_at INTEGER,
  expires_at INTEGER,
  conditions TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discount_code ON discounts(code, is_active);

CREATE TABLE IF NOT EXISTS discount_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discount_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  target_type TEXT,
  target_id TEXT,
  amount_saved REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_du_user ON discount_uses(user_id, discount_id);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  banner_url TEXT,
  type TEXT,
  discount_code TEXT,
  target_audience TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  is_active INTEGER DEFAULT 1,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_active ON promotions(is_active, expires_at);
