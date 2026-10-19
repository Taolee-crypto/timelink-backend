-- TL3 V5 whole-container encryption and Player-bound session licenses.
CREATE TABLE IF NOT EXISTS tl3_v5_releases (
  file_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  share_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  container_sha256 TEXT NOT NULL,
  wrapped_content_key TEXT NOT NULL,
  container_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sealed',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tl3_v5_share ON tl3_v5_releases(share_id,status);

CREATE TABLE IF NOT EXISTS tl3_player_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  key_thumbprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE(user_id,player_id)
);
CREATE INDEX IF NOT EXISTS idx_tl3_player_keys_user_active
  ON tl3_player_keys(user_id,revoked_at);

CREATE TABLE IF NOT EXISTS tl3_v5_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tl3_v5_sessions_user_file
  ON tl3_v5_sessions(user_id,file_id,expires_at);
