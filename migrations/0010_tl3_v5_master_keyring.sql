-- TL3 V5 master-key identifiers. Existing releases are assigned to the legacy key.
ALTER TABLE tl3_v5_releases
  ADD COLUMN key_id TEXT NOT NULL DEFAULT 'legacy';
