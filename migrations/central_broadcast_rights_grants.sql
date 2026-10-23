-- Broadcast licenses are separate from SharePlace publication rights.
-- Only a trusted rights-administration workflow may insert/update grants.
CREATE TABLE IF NOT EXISTS central_broadcast_rights_grants (
  grant_id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  country TEXT NOT NULL CHECK(length(country)=2),
  status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('inactive','active','revoked')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_id,country,grant_id)
);
CREATE INDEX IF NOT EXISTS idx_central_broadcast_rights
  ON central_broadcast_rights_grants(file_id,creator_id,country,status);
