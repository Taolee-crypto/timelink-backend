-- KRW accounting sidecar; no mutation of TL wallets, existing receipts or economic transactions.
CREATE TABLE IF NOT EXISTS v5_kr_accounts(code TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('asset','liability','revenue','expense','equity')));
INSERT OR IGNORE INTO v5_kr_accounts VALUES
('bank','보통예금','asset'),('restricted_cash','제한성 예금·보호자금','asset'),('pg_receivable','PG 미수금','asset'),('vat_input','공제 확인 매입 부가세','asset'),('national_prepaid','법인세 기납부액','asset'),('local_prepaid','법인지방소득세 기납부액','asset'),
('prepaid','이용자 미사용 충전금 의무','liability'),('creator_payable','창작자 미지급 정산금','liability'),('rights_held','권리자 미확인 보류금','liability'),
('vat_output','매출 부가세 예수금','liability'),('withholding_national','원천 소득세 예수금','liability'),('withholding_local','원천 지방소득세 예수금','liability'),
('corporate_national','미지급 법인세','liability'),('corporate_local','미지급 법인지방소득세','liability'),('other_payable','기타 미지급금','liability'),
('service_revenue','음악·서비스 매출','revenue'),('certificate_revenue','증명서 매출','revenue'),('promotion_revenue','홍보 매출','revenue'),('other_revenue','기타 매출','revenue'),
('rights_cost','권리사용료 비용','expense'),('pg_cost','PG 수수료','expense'),('operating_cost','운영비','expense'),('promotion_cost','판촉비','expense'),('tax_expense','법인세 등 비용','expense'),
('opening_equity','기초 순자산·자본','equity');
CREATE TABLE IF NOT EXISTS v5_kr_policy(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 0,data_json TEXT NOT NULL DEFAULT '{}',actor_id INTEGER,updated_at TEXT);
INSERT OR IGNORE INTO v5_kr_policy(id)VALUES(1);
CREATE TABLE IF NOT EXISTS v5_kr_policy_history(version INTEGER PRIMARY KEY,data_json TEXT NOT NULL,actor_id INTEGER,reason TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS v5_kr_tax_profiles(user_id INTEGER PRIMARY KEY,income_type TEXT NOT NULL,vat_type TEXT NOT NULL,national_bps INTEGER,local_bps INTEGER,verified INTEGER NOT NULL CHECK(verified IN(0,1)),version INTEGER NOT NULL,actor_id INTEGER NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,updated_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS v5_kr_profile_history(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,data_json TEXT NOT NULL,actor_id INTEGER NOT NULL,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS v5_kr_periods(month TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status='closed'),actor_id INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS v5_kr_journals(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,template TEXT NOT NULL,business_date TEXT NOT NULL,user_id INTEGER,description TEXT NOT NULL,evidence TEXT NOT NULL,input_json TEXT NOT NULL,fingerprint TEXT NOT NULL,policy_version INTEGER NOT NULL,actor_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','posted')),created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS v5_kr_lines(id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT NOT NULL REFERENCES v5_kr_journals(id),account TEXT NOT NULL REFERENCES v5_kr_accounts(code),amount_krw INTEGER NOT NULL CHECK(typeof(amount_krw)='integer' AND amount_krw<>0));
CREATE INDEX IF NOT EXISTS v5_kr_lines_journal ON v5_kr_lines(journal_id);
CREATE INDEX IF NOT EXISTS v5_kr_lines_account ON v5_kr_lines(account);
CREATE INDEX IF NOT EXISTS v5_kr_journals_date ON v5_kr_journals(business_date,status,user_id);
CREATE TRIGGER IF NOT EXISTS v5_kr_seal_guard BEFORE UPDATE OF status ON v5_kr_journals WHEN NEW.status='posted'
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_kr_periods WHERE month=substr(NEW.business_date,1,7))
 OR (SELECT COUNT(*) FROM v5_kr_lines WHERE journal_id=NEW.id)<2
 OR (SELECT COALESCE(SUM(amount_krw),0) FROM v5_kr_lines WHERE journal_id=NEW.id)<>0 THEN RAISE(ABORT,'KR_UNBALANCED_OR_CLOSED') END;
END;
CREATE TRIGGER IF NOT EXISTS v5_kr_journal_immutable_update BEFORE UPDATE ON v5_kr_journals WHEN OLD.status='posted' BEGIN SELECT RAISE(ABORT,'KR_POSTED_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_kr_journal_immutable_delete BEFORE DELETE ON v5_kr_journals WHEN OLD.status='posted' BEGIN SELECT RAISE(ABORT,'KR_POSTED_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_kr_line_immutable_insert BEFORE INSERT ON v5_kr_lines WHEN EXISTS(SELECT 1 FROM v5_kr_journals WHERE id=NEW.journal_id AND status='posted') BEGIN SELECT RAISE(ABORT,'KR_POSTED_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_kr_line_immutable_update BEFORE UPDATE ON v5_kr_lines WHEN EXISTS(SELECT 1 FROM v5_kr_journals WHERE id IN(OLD.journal_id,NEW.journal_id) AND status='posted') BEGIN SELECT RAISE(ABORT,'KR_POSTED_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_kr_line_immutable_delete BEFORE DELETE ON v5_kr_lines WHEN EXISTS(SELECT 1 FROM v5_kr_journals WHERE id=OLD.journal_id AND status='posted') BEGIN SELECT RAISE(ABORT,'KR_POSTED_IMMUTABLE'); END;
