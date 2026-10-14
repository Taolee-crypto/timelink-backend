-- V3 TL3 conversion evidence and retry lifecycle.
-- The encrypted container stays in creator-controlled storage; D1 stores references and verification evidence only.
CREATE TABLE IF NOT EXISTS v3_tl3_conversion_jobs (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  source_asset_id TEXT NOT NULL REFERENCES v3_track_assets(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  license_reference TEXT NOT NULL UNIQUE,
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  output_asset_id TEXT UNIQUE REFERENCES v3_track_assets(id),
  output_content_hash TEXT CHECK (output_content_hash IS NULL OR length(output_content_hash) = 64),
  output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR output_size_bytes > 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  segment_count INTEGER CHECK (segment_count IS NULL OR segment_count > 0),
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building','built','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_v3_tl3_conversion_owner_time
  ON v3_tl3_conversion_jobs(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_v3_tl3_conversion_source_time
  ON v3_tl3_conversion_jobs(source_asset_id, created_at DESC);
