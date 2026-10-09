-- TimeLink 오프라인 재생 세션
-- 2026-10-09
-- 목적: 오프라인 다운로드 시 선차감, 온라인 복귀 시 정산

CREATE TABLE IF NOT EXISTS tl3_offline_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  share_id TEXT NOT NULL,
  total_segments INTEGER NOT NULL,
  reserved_tl REAL NOT NULL DEFAULT 0,
  settled_tl REAL DEFAULT 0,
  refunded_tl REAL DEFAULT 0,
  lic_delivered INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  device_hint TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  settled_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_offline_sessions_user
  ON tl3_offline_sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_offline_sessions_expires
  ON tl3_offline_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_offline_sessions_share
  ON tl3_offline_sessions(share_id);
