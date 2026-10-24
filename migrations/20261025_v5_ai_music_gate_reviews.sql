-- V5 AI Music Gate: durable pre-TL3 review workflow (not enabled until API integration).
CREATE TABLE IF NOT EXISTS v5_music_gate_reviews (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  registration_mode TEXT NOT NULL CHECK(registration_mode IN ('original_creation','existing_release_share')),
  status TEXT NOT NULL DEFAULT 'pending_analysis'
    CHECK(status IN ('pending_analysis','analyzing','review_required','approved','rejected','cancelled')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  classifier_version TEXT,
  evidence_json TEXT,
  reviewer_user_id INTEGER,
  reviewer_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE(user_id,source_sha256,registration_mode)
);
CREATE INDEX IF NOT EXISTS idx_v5_music_gate_reviews_user_status
  ON v5_music_gate_reviews(user_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_v5_music_gate_reviews_status
  ON v5_music_gate_reviews(status,created_at);
-- A decision may only be approved by a reviewer or by a later explicitly
-- implemented and audited automated-approval path. Fail closed for now.
CREATE TRIGGER IF NOT EXISTS v5_music_gate_approval_requires_reviewer
BEFORE UPDATE OF status ON v5_music_gate_reviews
WHEN NEW.status='approved' AND (NEW.reviewer_user_id IS NULL OR NEW.decided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'MUSIC_GATE_APPROVAL_REQUIRES_REVIEWER');
END;
CREATE TRIGGER IF NOT EXISTS v5_music_gate_rejection_requires_reviewer
BEFORE UPDATE OF status ON v5_music_gate_reviews
WHEN NEW.status='rejected' AND (NEW.reviewer_user_id IS NULL OR NEW.decided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'MUSIC_GATE_REJECTION_REQUIRES_REVIEWER');
END;
