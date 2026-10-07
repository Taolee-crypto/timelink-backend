CREATE TABLE IF NOT EXISTS tl3_segments (
  file_id INTEGER NOT NULL,
  segment_index INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (file_id, segment_index)
);

CREATE TABLE IF NOT EXISTS tl3_play_blocks (
  id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  prev_token TEXT,
  session_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  segment_index INTEGER NOT NULL,
  played_ms INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  device_hash TEXT,
  ip_hash TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pb_file ON tl3_play_blocks(file_id);
CREATE INDEX IF NOT EXISTS idx_pb_user ON tl3_play_blocks(user_id);
CREATE INDEX IF NOT EXISTS idx_pb_session ON tl3_play_blocks(session_id);

CREATE TABLE IF NOT EXISTS tl3_offline_grants (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  granted_tl REAL NOT NULL,
  used_tl REAL NOT NULL DEFAULT 0,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device_hash TEXT,
  hmac_sig TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_offline_user ON tl3_offline_grants(user_id, status);