-- Apply once after 20261025_v5_ai_music_gate_reviews.sql, before deploying the worker.
ALTER TABLE v5_music_gate_reviews ADD COLUMN analysis_token TEXT;
ALTER TABLE v5_music_gate_reviews ADD COLUMN analysis_lease_until INTEGER;
ALTER TABLE v5_music_gate_reviews ADD COLUMN analysis_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE v5_music_gate_reviews ADD COLUMN analysis_next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE v5_music_gate_reviews ADD COLUMN analysis_error TEXT;
ALTER TABLE v5_music_gate_reviews ADD COLUMN evidence_sha256 TEXT;
CREATE INDEX idx_v5_music_gate_analysis_queue
  ON v5_music_gate_reviews(status,analysis_next_at,analysis_lease_until);

CREATE TABLE v5_music_gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  analysis_attempt INTEGER NOT NULL,
  classifier_version TEXT,
  evidence_sha256 TEXT,
  analysis_error TEXT,
  reviewer_user_id INTEGER,
  reviewer_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_v5_music_gate_audit_review ON v5_music_gate_audit(review_id,id);
INSERT INTO v5_music_gate_audit(review_id,source_sha256,from_status,to_status,analysis_attempt,
  classifier_version,reviewer_user_id,reviewer_note)
SELECT id,source_sha256,NULL,status,analysis_attempts,classifier_version,reviewer_user_id,reviewer_note
  FROM v5_music_gate_reviews;
CREATE TRIGGER v5_music_gate_audit_insert AFTER INSERT ON v5_music_gate_reviews
BEGIN
  INSERT INTO v5_music_gate_audit(review_id,source_sha256,from_status,to_status,analysis_attempt)
    VALUES(NEW.id,NEW.source_sha256,NULL,NEW.status,NEW.analysis_attempts);
END;
CREATE TRIGGER v5_music_gate_audit_transition AFTER UPDATE ON v5_music_gate_reviews
WHEN OLD.status<>NEW.status OR OLD.analysis_attempts<>NEW.analysis_attempts
BEGIN
  INSERT INTO v5_music_gate_audit(review_id,source_sha256,from_status,to_status,analysis_attempt,
    classifier_version,evidence_sha256,analysis_error,reviewer_user_id,reviewer_note)
  VALUES(NEW.id,NEW.source_sha256,OLD.status,NEW.status,NEW.analysis_attempts,
    NEW.classifier_version,NEW.evidence_sha256,NEW.analysis_error,NEW.reviewer_user_id,NEW.reviewer_note);
END;
CREATE TRIGGER v5_music_gate_audit_no_update BEFORE UPDATE ON v5_music_gate_audit
BEGIN SELECT RAISE(ABORT,'MUSIC_GATE_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER v5_music_gate_audit_no_delete BEFORE DELETE ON v5_music_gate_audit
BEGIN SELECT RAISE(ABORT,'MUSIC_GATE_AUDIT_IMMUTABLE'); END;
