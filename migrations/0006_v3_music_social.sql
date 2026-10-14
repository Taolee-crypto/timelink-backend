-- V3 public music discovery and Track social layer.
-- MP3 publication must be streamable through an explicit HTTPS asset URI; TL3 remains a protected product.
CREATE TABLE IF NOT EXISTS v3_track_likes (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(track_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_v3_track_likes_track
  ON v3_track_likes(track_id,created_at DESC);

CREATE TABLE IF NOT EXISTS v3_track_comments (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
  moderation_status TEXT NOT NULL DEFAULT 'visible'
    CHECK (moderation_status IN ('visible','hidden','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v3_track_comments_track_time
  ON v3_track_comments(track_id,created_at DESC);

CREATE TABLE IF NOT EXISTS v3_track_comment_reports (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES v3_track_comments(id),
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(comment_id,reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_v3_track_comment_reports_status
  ON v3_track_comment_reports(status,created_at);

CREATE TABLE IF NOT EXISTS v3_track_follows (
  id TEXT PRIMARY KEY,
  follower_user_id INTEGER NOT NULL REFERENCES users(id),
  followed_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(follower_user_id,followed_user_id),
  CHECK (follower_user_id <> followed_user_id)
);
CREATE INDEX IF NOT EXISTS idx_v3_track_follows_target
  ON v3_track_follows(followed_user_id,created_at DESC);

-- Recreate publication triggers so free MP3s cannot be published without a stream URL.
DROP TRIGGER IF EXISTS trg_v3_release_asset_insert;
DROP TRIGGER IF EXISTS trg_v3_release_asset_update;
CREATE TRIGGER trg_v3_release_asset_insert
BEFORE INSERT ON v3_track_releases
WHEN NEW.status = 'published'
BEGIN
  SELECT CASE WHEN NEW.asset_id IS NULL
    THEN RAISE(ABORT, 'Published release requires an asset') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_assets a
    WHERE a.id = NEW.asset_id AND a.track_id = NEW.track_id
      AND a.availability_status = 'available'
      AND ((NEW.release_type = 'MP3' AND a.asset_type = 'mp3_audio' AND a.storage_uri_ref IS NOT NULL)
        OR (NEW.release_type = 'TL3' AND a.asset_type = 'tl3_release_file'))
  ) THEN RAISE(ABORT, 'Published release requires a matching available asset; MP3 also requires a stream URI') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_rights r
    WHERE r.track_id = NEW.track_id AND r.verification_status = 'verified'
  ) THEN RAISE(ABORT, 'Published release requires verified rights') END;
  SELECT CASE WHEN NEW.release_type = 'MP3' AND NEW.price_tl <> 0
    THEN RAISE(ABORT, 'MP3 must be free') END;
END;

CREATE TRIGGER trg_v3_release_asset_update
BEFORE UPDATE OF status, asset_id, track_id, release_type ON v3_track_releases
WHEN NEW.status = 'published'
BEGIN
  SELECT CASE WHEN NEW.asset_id IS NULL
    THEN RAISE(ABORT, 'Published release requires an asset') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_assets a
    WHERE a.id = NEW.asset_id AND a.track_id = NEW.track_id
      AND a.availability_status = 'available'
      AND ((NEW.release_type = 'MP3' AND a.asset_type = 'mp3_audio' AND a.storage_uri_ref IS NOT NULL)
        OR (NEW.release_type = 'TL3' AND a.asset_type = 'tl3_release_file'))
  ) THEN RAISE(ABORT, 'Published release requires a matching available asset; MP3 also requires a stream URI') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_rights r
    WHERE r.track_id = NEW.track_id AND r.verification_status = 'verified'
  ) THEN RAISE(ABORT, 'Published release requires verified rights') END;
  SELECT CASE WHEN NEW.release_type = 'MP3' AND NEW.price_tl <> 0
    THEN RAISE(ABORT, 'MP3 must be free') END;
END;

CREATE TABLE IF NOT EXISTS v3_track_comment_moderation_events (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES v3_track_comments(id),
  moderator_user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('visible','hidden','removed')),
  moderation_note TEXT NOT NULL CHECK (length(moderation_note) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v3_track_comment_moderation_time
  ON v3_track_comment_moderation_events(comment_id,created_at DESC);
