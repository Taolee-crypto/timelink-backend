-- migrations/tl_ledger.sql
-- TimeLink 회계장부 (특허 보정서 3.8: 사용량 확정의 멱등 처리)
-- 이중 기록 원칙: 모든 이벤트는 짝을 이루며, SUM(amount) = users.tl_balance

CREATE TABLE IF NOT EXISTS tl_ledger (
  id              TEXT PRIMARY KEY,           -- event_id (UUID)
  idempotency     TEXT UNIQUE,                -- 멱등키 (재전송 방지)
  ts              INTEGER NOT NULL,           -- unix seconds
  user_id         INTEGER NOT NULL,           -- 당사자
  counterparty    INTEGER,                    -- 상대 (창작자/플랫폼)
  event_type      TEXT NOT NULL,              -- charge|debit|refund|revenue|fee|withdraw
  amount          REAL NOT NULL,              -- 부호 있음 (+입금, -출금)
  balance_after   REAL NOT NULL,              -- 감사용 스냅샷
  session_id      TEXT,                       -- TL3 v3 AAD 와 동일
  segment_index   INTEGER,
  file_id         INTEGER,
  ref_table       TEXT,                       -- 원본 레코드 참조
  ref_id          TEXT,
  meta            TEXT,                       -- JSON 부가정보
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_ts ON tl_ledger(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_session ON tl_ledger(session_id);
CREATE INDEX IF NOT EXISTS idx_ledger_type    ON tl_ledger(event_type);
CREATE INDEX IF NOT EXISTS idx_ledger_ref     ON tl_ledger(ref_table, ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_idem    ON tl_ledger(idempotency);
