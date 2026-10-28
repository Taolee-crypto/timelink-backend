-- Global genre normalization model for imported commercial catalog metadata.
-- Source names are preserved; canonical IDs must be assigned only after a reviewed crosswalk.
CREATE TABLE IF NOT EXISTS v5_genre_standard (
  genre_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  parent_genre_id TEXT REFERENCES v5_genre_standard(genre_id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS v5_genre_source_mapping (
  source_system TEXT NOT NULL,
  source_genre TEXT NOT NULL,
  canonical_genre_id TEXT REFERENCES v5_genre_standard(genre_id),
  mapping_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(mapping_status IN ('unreviewed','approved','rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  PRIMARY KEY(source_system,source_genre)
);
CREATE TABLE IF NOT EXISTS v5_track_genre_assignments (
  track_source TEXT NOT NULL,
  track_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_genre TEXT NOT NULL,
  canonical_genre_id TEXT REFERENCES v5_genre_standard(genre_id),
  classification_status TEXT NOT NULL DEFAULT 'pending' CHECK(classification_status IN ('pending','verified','rejected')),
  PRIMARY KEY(track_source,track_id,source_system,source_genre)
);
CREATE INDEX IF NOT EXISTS idx_v5_track_genre_canonical ON v5_track_genre_assignments(canonical_genre_id,classification_status);
CREATE INDEX IF NOT EXISTS idx_v5_genre_mapping_canonical ON v5_genre_source_mapping(canonical_genre_id,mapping_status);
