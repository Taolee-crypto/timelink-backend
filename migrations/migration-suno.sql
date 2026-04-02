-- migrations/0004_suno_verification.sql
-- wrangler d1 execute timelink-db --file=migrations/0004_suno_verification.sql

-- Suno 플랜 인증 테이블
CREATE TABLE IF NOT EXISTS suno_verifications (
  user_id     TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,           -- Pro Plan / Premier Plan
  end_date    TEXT,                    -- Mar 11, 2026
  credits     TEXT,                    -- 1812
  verified_at TEXT DEFAULT (datetime('now')),
  expires_at  TEXT                     -- Plan End Date 기준
);

-- 인증 이력 (감사용)
CREATE TABLE IF NOT EXISTS suno_verification_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  result      TEXT NOT NULL,           -- ok / fail
  plan        TEXT,
  reason      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
