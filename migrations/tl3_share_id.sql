-- tl3_stream_sessions 테이블이 없으면 먼저 생성
CREATE TABLE IF NOT EXISTS tl3_stream_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  next_segment INTEGER NOT NULL DEFAULT 0,
  last_segment_at INTEGER NOT NULL DEFAULT 0,
  pending_segment INTEGER,
  pending_cost REAL DEFAULT 0,
  pending_duration_ms INTEGER DEFAULT 0,
  pending_delivered_at INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- share_id 컬럼 추가 (이미 있으면 에러 무시)
ALTER TABLE tl3_releases ADD COLUMN share_id TEXT;
ALTER TABLE tl3_segments ADD COLUMN share_id TEXT;
ALTER TABLE tl3_stream_sessions ADD COLUMN share_id TEXT;
ALTER TABLE tl3_play_blocks ADD COLUMN share_id TEXT;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_tl3_releases_share ON tl3_releases(share_id);
CREATE INDEX IF NOT EXISTS idx_tl3_segments_share ON tl3_segments(share_id, segment_index);
CREATE INDEX IF NOT EXISTS idx_tl3_sessions_share ON tl3_stream_sessions(share_id);
CREATE INDEX IF NOT EXISTS idx_tl3_blocks_share ON tl3_play_blocks(share_id);