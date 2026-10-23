-- TILO V5 broadcasting targeting schema, additive and non-destructive.
-- Run via the established D1 migration workflow before enabling promotion writes.
CREATE TABLE IF NOT EXISTS tilo_track_languages (
  file_id INTEGER NOT NULL,
  language_code TEXT NOT NULL CHECK(length(language_code) BETWEEN 2 AND 12),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  source TEXT NOT NULL DEFAULT 'creator' CHECK(source IN ('creator','verified_analysis','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(file_id,language_code),
  FOREIGN KEY(file_id) REFERENCES tl_files(id)
);
CREATE INDEX IF NOT EXISTS idx_tilo_track_languages_code ON tilo_track_languages(language_code,file_id);

CREATE TABLE IF NOT EXISTS tilo_promotion_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  requester_user_id INTEGER NOT NULL,
  target_country TEXT NOT NULL CHECK(length(target_country)=2),
  target_language TEXT NOT NULL CHECK(length(target_language) BETWEEN 2 AND 12),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','active','paused','completed','rejected')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  budget_atoms INTEGER NOT NULL DEFAULT 0 CHECK(budget_atoms>=0),
  spent_atoms INTEGER NOT NULL DEFAULT 0 CHECK(spent_atoms>=0 AND spent_atoms<=budget_atoms),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(file_id) REFERENCES tl_files(id)
);
CREATE INDEX IF NOT EXISTS idx_tilo_campaign_target ON tilo_promotion_campaigns(target_country,target_language,status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_tilo_campaign_file ON tilo_promotion_campaigns(file_id,status);

CREATE TABLE IF NOT EXISTS tilo_broadcast_airtime (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_session_id TEXT NOT NULL,
  channel_country TEXT NOT NULL,
  channel_language TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  campaign_id INTEGER,
  played_ms INTEGER NOT NULL CHECK(played_ms>0),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  settlement_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(broadcast_session_id,file_id,started_at),
  FOREIGN KEY(file_id) REFERENCES tl_files(id),
  FOREIGN KEY(campaign_id) REFERENCES tilo_promotion_campaigns(id)
);
CREATE INDEX IF NOT EXISTS idx_tilo_airtime_channel ON tilo_broadcast_airtime(channel_country,channel_language,started_at);
