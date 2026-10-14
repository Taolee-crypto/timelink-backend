-- V3 moderation audit trail. Additive only; no legacy table is altered.
CREATE TABLE IF NOT EXISTS v3_rights_review_events (
  id TEXT PRIMARY KEY,
  rights_id TEXT NOT NULL REFERENCES v3_track_rights(id),
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('verified','rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v3_rights_review_track_time
  ON v3_rights_review_events(track_id, created_at DESC);

CREATE TABLE IF NOT EXISTS v3_release_review_events (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES v3_track_releases(id),
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v3_release_review_track_time
  ON v3_release_review_events(track_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_rights_one_final_review
  ON v3_rights_review_events(rights_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_release_one_review_decision
  ON v3_release_review_events(release_id, decision);
