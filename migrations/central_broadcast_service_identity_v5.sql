-- V5 central broadcast service identity and narrowly scoped playback grants.
-- The service is a child identity of an existing administrator, not a listener wallet.
-- These grants authorize internal playback access only; they do not replace
-- copyright-holder broadcast permission or grant access to downloadable files.
CREATE TABLE IF NOT EXISTS central_broadcast_service_accounts (
  service_id TEXT PRIMARY KEY,
  parent_admin_user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','active','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_central_broadcast_service_parent
  ON central_broadcast_service_accounts(parent_admin_user_id,status);

CREATE TABLE IF NOT EXISTS central_broadcast_service_file_grants (
  service_id TEXT NOT NULL REFERENCES central_broadcast_service_accounts(service_id),
  file_id INTEGER NOT NULL,
  country TEXT NOT NULL CHECK(length(country)=2 AND country=upper(country)),
  permission TEXT NOT NULL DEFAULT 'stream' CHECK(permission='stream'),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','active','revoked')),
  expires_at TEXT,
  granted_by_admin_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(service_id,file_id,country)
);
CREATE INDEX IF NOT EXISTS idx_central_broadcast_service_file
  ON central_broadcast_service_file_grants(file_id,country,status);

-- Server-side checks must require BOTH active service grants and separate
-- active rights-holder broadcast grants, as well as a sealed V5 release.
-- Do not use these tables to debit a listener or mint rewards on playback.
