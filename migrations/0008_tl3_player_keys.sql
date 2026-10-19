-- Per-member TimeLink Player public keys. Private keys never leave the client device.
CREATE TABLE IF NOT EXISTS tl3_player_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  key_thumbprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE(user_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_tl3_player_keys_user_active
  ON tl3_player_keys(user_id, revoked_at);
