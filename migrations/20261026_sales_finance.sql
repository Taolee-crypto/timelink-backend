-- Partner settlements share the KR accounting and V5 economic ledgers.
INSERT OR IGNORE INTO v5_kr_accounts VALUES
('manager_payable','영업 매니저 미지급금','liability'),('dj_payable','파트너 DJ 미지급금','liability'),
('manager_cost','영업 매니저 보수','expense'),('dj_cost','파트너 DJ 보수','expense');
CREATE TABLE IF NOT EXISTS v5_sales_settlements(
 id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN('manager','dj')),
 state TEXT NOT NULL CHECK(state IN('reserved','approved','paid','cancelled')),tl_atoms INTEGER NOT NULL CHECK(tl_atoms>0),
 gross_krw INTEGER NOT NULL CHECK(gross_krw>0),tax_base_krw INTEGER NOT NULL,vat_krw INTEGER NOT NULL,national_krw INTEGER NOT NULL,local_krw INTEGER NOT NULL,net_krw INTEGER NOT NULL,
 business_date TEXT NOT NULL,profile_version INTEGER NOT NULL,profile_json TEXT NOT NULL,terms_evidence TEXT NOT NULL,bank_reference TEXT NOT NULL,
 reserve_transaction_id TEXT,accrual_journal_id TEXT NOT NULL,payout_journal_id TEXT,payment_evidence TEXT,
 created_by INTEGER NOT NULL,approved_by INTEGER,created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')),version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v5_sales_settlement_items(
 settlement_id TEXT NOT NULL REFERENCES v5_sales_settlements(id),payment_id TEXT NOT NULL REFERENCES v5_sales_payments(id),role TEXT NOT NULL CHECK(role IN('manager','dj')),
 amount_atoms INTEGER NOT NULL CHECK(amount_atoms>0),PRIMARY KEY(settlement_id,payment_id,role)
);
CREATE TABLE IF NOT EXISTS v5_sales_settlement_events(id TEXT PRIMARY KEY,settlement_id TEXT NOT NULL REFERENCES v5_sales_settlements(id),action TEXT NOT NULL,actor_id INTEGER NOT NULL,data_json TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now')));
CREATE INDEX IF NOT EXISTS v5_sales_settlements_user ON v5_sales_settlements(user_id,role,state);
CREATE INDEX IF NOT EXISTS v5_sales_settlement_items_payment ON v5_sales_settlement_items(payment_id,role);
CREATE TRIGGER IF NOT EXISTS v5_sales_settlement_money_immutable BEFORE UPDATE OF user_id,role,tl_atoms,gross_krw,tax_base_krw,vat_krw,national_krw,local_krw,net_krw,business_date,profile_version,profile_json,terms_evidence,bank_reference,accrual_journal_id ON v5_sales_settlements BEGIN SELECT RAISE(ABORT,'SALES_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_sales_settlement_items_update BEFORE UPDATE ON v5_sales_settlement_items BEGIN SELECT RAISE(ABORT,'SALES_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_sales_settlement_items_delete BEFORE DELETE ON v5_sales_settlement_items BEGIN SELECT RAISE(ABORT,'SALES_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v5_sales_settlement_delete BEFORE DELETE ON v5_sales_settlements BEGIN SELECT RAISE(ABORT,'SALES_SETTLEMENT_IMMUTABLE'); END;

CREATE UNIQUE INDEX IF NOT EXISTS v5_sales_payment_evidence_unique ON v5_sales_settlements(payment_evidence) WHERE payment_evidence IS NOT NULL;
