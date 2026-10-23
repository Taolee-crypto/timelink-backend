-- Local-only idempotent D1 fixture. Not the production Worker ledger schema.
CREATE TABLE IF NOT EXISTS v5_test_accounts (id TEXT PRIMARY KEY,balance_atoms INTEGER NOT NULL CHECK(balance_atoms>=0));
CREATE TABLE IF NOT EXISTS v5_test_transactions (idempotency_key TEXT PRIMARY KEY,spent_atoms INTEGER NOT NULL,creator_atoms INTEGER NOT NULL,platform_atoms INTEGER NOT NULL,CHECK(creator_atoms+platform_atoms=spent_atoms));
CREATE TEMP TABLE IF NOT EXISTS v5_test_once (applied INTEGER NOT NULL);
DELETE FROM v5_test_once;
INSERT OR IGNORE INTO v5_test_accounts VALUES ('track',1800000),('creator',0),('platform',0);
INSERT OR IGNORE INTO v5_test_transactions VALUES ('session-30s',300000,210000,90000);
INSERT INTO v5_test_once(applied) SELECT changes();
UPDATE v5_test_accounts SET balance_atoms=balance_atoms-300000 WHERE id='track' AND (SELECT applied FROM v5_test_once)=1;
UPDATE v5_test_accounts SET balance_atoms=balance_atoms+210000 WHERE id='creator' AND (SELECT applied FROM v5_test_once)=1;
UPDATE v5_test_accounts SET balance_atoms=balance_atoms+90000 WHERE id='platform' AND (SELECT applied FROM v5_test_once)=1;
SELECT CASE WHEN (SELECT SUM(balance_atoms) FROM v5_test_accounts)=1800000 AND (SELECT balance_atoms FROM v5_test_accounts WHERE id='track')=1500000 AND (SELECT balance_atoms FROM v5_test_accounts WHERE id='creator')=210000 AND (SELECT balance_atoms FROM v5_test_accounts WHERE id='platform')=90000 THEN 'PASS' ELSE 'FAIL' END AS conservation_check;
