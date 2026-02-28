-- Migration 001: Initial Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tl_balance REAL DEFAULT 0.0,
  tl_locked REAL DEFAULT 0.0,
  tlc_balance REAL DEFAULT 0.0,
  total_tl_spent REAL DEFAULT 0.0,
  total_tl_earned REAL DEFAULT 0.0,
  total_tl_exchanged REAL DEFAULT 0.0,
  poc_index REAL DEFAULT 1.0,
  false_dispute_strikes INTEGER DEFAULT 0,
  account_forfeited INTEGER DEFAULT 0,
  tl_suspended INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tl_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  artist TEXT,
  genre TEXT,
  country TEXT,
  file_type TEXT DEFAULT 'audio',
  file_url TEXT,
  file_size_bytes INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  file_tl REAL DEFAULT 0.0,
  max_file_tl REAL DEFAULT 0.0,
  revenue REAL DEFAULT 0.0,
  hold_revenue REAL DEFAULT 0.0,
  auth_status TEXT DEFAULT 'unverified',
  auth_type TEXT DEFAULT 'manual',
  auth_proof_url TEXT,
  shared INTEGER DEFAULT 0,
  pulse REAL DEFAULT 0.0,
  play_count INTEGER DEFAULT 0,
  revenue_held INTEGER DEFAULT 0,
  revenue_started_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  file_id INTEGER REFERENCES tl_files(id),
  tx_type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  counterpart_user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES tl_files(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  source_url TEXT,
  profile_url TEXT,
  capture_path TEXT,
  payment_proof_path TEXT,
  email_proof TEXT,
  plan_type TEXT,
  creation_month TEXT,
  extra_notes TEXT,
  status TEXT DEFAULT 'pending',
  ocr_result TEXT,
  reviewer_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS play_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES tl_files(id),
  player_user_id INTEGER REFERENCES users(id),
  tl_deducted REAL DEFAULT 0.0,
  revenue_credited REAL DEFAULT 0.0,
  file_tl_after REAL DEFAULT 0.0,
  play_duration_seconds INTEGER DEFAULT 0,
  car_mode INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES tl_files(id),
  disputer_user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_paths TEXT DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  result_note TEXT,
  days_remaining INTEGER DEFAULT 30,
  false_strike_added INTEGER DEFAULT 0,
  poc_delta_applied REAL DEFAULT 0.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS poc_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta REAL NOT NULL,
  poc_after REAL NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);
CREATE INDEX IF NOT EXISTS ix_tl_files_user_id ON tl_files(user_id);
CREATE INDEX IF NOT EXISTS ix_tl_files_auth_status ON tl_files(auth_status);
CREATE INDEX IF NOT EXISTS ix_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS ix_disputes_file_id ON disputes(file_id);
