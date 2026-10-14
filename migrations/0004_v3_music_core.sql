-- TimeLink V3 music core: canonical Track, metadata, assets, rights and releases.
-- Additive only. Legacy tl_files/tl_shares/tl3_releases are not modified or backfilled.
-- MP3 is a creator source Asset; TL3 is the initial commercial Release.
-- Audio bytes are never stored in D1. Assets contain approved storage references only.

CREATE TABLE IF NOT EXISTS v3_tracks (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','hidden','under_review','removed')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','unlisted','public')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v3_tracks_owner_updated
  ON v3_tracks(owner_user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_v3_tracks_discovery
  ON v3_tracks(status, visibility, updated_at);

CREATE TABLE IF NOT EXISTS v3_track_metadata_versions (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  version INTEGER NOT NULL CHECK (version > 0),
  original_filename TEXT NOT NULL,
  extracted_title TEXT,
  extracted_artist TEXT,
  extracted_album TEXT,
  fallback_title TEXT,
  verified_title TEXT,
  verified_artist TEXT,
  verified_album TEXT,
  display_title TEXT NOT NULL,
  metadata_source TEXT NOT NULL
    CHECK (metadata_source IN ('id3','filename_fallback','manual','mixed')),
  metadata_status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (metadata_status IN ('pending_review','confirmed','needs_attention')),
  extracted_payload_json TEXT
    CHECK (extracted_payload_json IS NULL OR length(extracted_payload_json) <= 16384),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(track_id, version)
);
CREATE INDEX IF NOT EXISTS idx_v3_track_metadata_track_version
  ON v3_track_metadata_versions(track_id, version DESC);

CREATE TABLE IF NOT EXISTS v3_track_assets (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  asset_type TEXT NOT NULL
    CHECK (asset_type IN ('mp3_audio','tl3_release_file','cover_art','lyrics','sheet_music','local_source_reference','other')),
  storage_provider TEXT
    CHECK (storage_provider IS NULL OR storage_provider IN ('local_agent','google_drive','onedrive','r2','external')),
  storage_object_id TEXT,
  storage_uri_ref TEXT,
  content_hash TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  mime_type TEXT,
  availability_status TEXT NOT NULL DEFAULT 'local_only'
    CHECK (availability_status IN ('local_only','available','unavailable','revoked')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    availability_status <> 'available'
    OR (storage_provider IS NOT NULL AND
        (storage_object_id IS NOT NULL OR storage_uri_ref IS NOT NULL))
  )
);
CREATE INDEX IF NOT EXISTS idx_v3_track_assets_track_type
  ON v3_track_assets(track_id, asset_type, created_at);
CREATE INDEX IF NOT EXISTS idx_v3_track_assets_hash
  ON v3_track_assets(content_hash);

CREATE TABLE IF NOT EXISTS v3_track_rights (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  claimant_user_id INTEGER NOT NULL REFERENCES users(id),
  rights_role TEXT NOT NULL
    CHECK (rights_role IN ('author','composer','lyricist','performer','producer','label','administrator','other')),
  ownership_share_bps INTEGER
    CHECK (ownership_share_bps IS NULL OR ownership_share_bps BETWEEN 0 AND 10000),
  territory TEXT,
  valid_from TEXT,
  valid_until TEXT,
  evidence_ref TEXT,
  verification_status TEXT NOT NULL DEFAULT 'declared'
    CHECK (verification_status IN ('declared','pending','verified','disputed','rejected')),
  terms_version TEXT NOT NULL,
  attested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v3_track_rights_track_status
  ON v3_track_rights(track_id, verification_status);

CREATE TABLE IF NOT EXISTS v3_track_releases (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  release_type TEXT NOT NULL CHECK (release_type IN ('TL3')),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','preparing','ready_for_review','published','suspended','withdrawn')),
  asset_id TEXT REFERENCES v3_track_assets(id),
  rights_snapshot_json TEXT NOT NULL DEFAULT '{}'
    CHECK (length(rights_snapshot_json) <= 32768),
  price_tl INTEGER NOT NULL DEFAULT 0 CHECK (price_tl >= 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  format_version TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(track_id, release_type, version),
  CHECK (price_tl > 0)
);
CREATE INDEX IF NOT EXISTS idx_v3_track_releases_track_status
  ON v3_track_releases(track_id, release_type, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_track_one_published_release
  ON v3_track_releases(track_id, release_type)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS v3_shareplace_entries (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL UNIQUE REFERENCES v3_tracks(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL DEFAULT 'Music',
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('private','unlisted','public')),
  featured_state TEXT NOT NULL DEFAULT 'normal'
    CHECK (featured_state IN ('normal','featured','limited')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_v3_shareplace_discovery
  ON v3_shareplace_entries(visibility, published_at DESC);

-- Explicit mapping only; this migration does not import or mutate legacy records.
CREATE TABLE IF NOT EXISTS v3_legacy_track_links (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES v3_tracks(id),
  legacy_source TEXT NOT NULL
    CHECK (legacy_source IN ('tl_files','tl_shares','tl3_releases')),
  legacy_record_id TEXT NOT NULL,
  mapping_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (mapping_status IN ('pending','matched','conflict','skipped')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(legacy_source, legacy_record_id)
);
CREATE INDEX IF NOT EXISTS idx_v3_legacy_track_links_track
  ON v3_legacy_track_links(track_id);

-- A published release must point to an available asset of the matching product type.
CREATE TRIGGER IF NOT EXISTS trg_v3_release_asset_insert
BEFORE INSERT ON v3_track_releases
WHEN NEW.status = 'published'
BEGIN
  SELECT CASE WHEN NEW.asset_id IS NULL
    THEN RAISE(ABORT, 'Published release requires an asset') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_assets a
    WHERE a.id = NEW.asset_id
      AND a.track_id = NEW.track_id
      AND a.availability_status = 'available'
      AND NEW.release_type = 'TL3' AND a.asset_type = 'tl3_release_file'
  ) THEN RAISE(ABORT, 'Published TL3 release requires a matching available TL3 asset') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_rights r
    WHERE r.track_id = NEW.track_id
      AND r.verification_status = 'verified'
  ) THEN RAISE(ABORT, 'Published release requires verified rights') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_release_asset_update
BEFORE UPDATE OF status, asset_id, track_id, release_type ON v3_track_releases
WHEN NEW.status = 'published'
BEGIN
  SELECT CASE WHEN NEW.asset_id IS NULL
    THEN RAISE(ABORT, 'Published release requires an asset') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_assets a
    WHERE a.id = NEW.asset_id
      AND a.track_id = NEW.track_id
      AND a.availability_status = 'available'
      AND NEW.release_type = 'TL3' AND a.asset_type = 'tl3_release_file'
  ) THEN RAISE(ABORT, 'Published release requires a matching available asset') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM v3_track_rights r
    WHERE r.track_id = NEW.track_id
      AND r.verification_status = 'verified'
  ) THEN RAISE(ABORT, 'Published release requires verified rights') END;
END;

-- Published rights/metadata are snapshots on releases; later edits create new versions.
