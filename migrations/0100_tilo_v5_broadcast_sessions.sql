-- V5 TILO session control plane. Does not grant audio decryption or settlement.
CREATE TABLE IF NOT EXISTS tilo_broadcast_sessions (
  id TEXT PRIMARY KEY,
  channel_country TEXT NOT NULL,
  channel_language TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','ready','broadcasting','paused','stopped','failed')),
  current_file_id INTEGER,
  current_campaign_id INTEGER,
  started_at TEXT,
  ended_at TEXT,
  last_verified_at TEXT,
  playback_license_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(current_file_id) REFERENCES tl_files(id),
  FOREIGN KEY(current_campaign_id) REFERENCES tilo_promotion_campaigns(id)
);
CREATE INDEX IF NOT EXISTS idx_tilo_sessions_channel ON tilo_broadcast_sessions(channel_country,channel_language,state,updated_at);
CREATE TABLE IF NOT EXISTS tilo_broadcast_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','ready','started','paused','resumed','stopped','failed','track_changed','verified_audio')),
  file_id INTEGER,
  verified_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(verified_played_ms>=0),
  verifier_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(session_id) REFERENCES tilo_broadcast_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_tilo_events_session ON tilo_broadcast_events(session_id,id);
