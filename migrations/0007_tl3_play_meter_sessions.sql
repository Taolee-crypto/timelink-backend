-- TL3 playback-time settlement tables. Created once by D1 migrations,
-- never lazily from the per-second playback request path.
CREATE TABLE IF NOT EXISTS tl3_assertion_guard (
  ok INTEGER NOT NULL CHECK(ok=1)
);

CREATE TABLE IF NOT EXISTS tl3_play_meter_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  billed_seconds INTEGER NOT NULL DEFAULT 0,
  played_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tl3_play_meter_user_file
  ON tl3_play_meter_sessions(user_id, file_id);
