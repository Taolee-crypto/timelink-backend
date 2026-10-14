from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0003_v3_economy_ledger.sql"

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
db.executescript(MIGRATION.read_text(encoding="utf-8"))

tables = {
    row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
    )
}
assert len(tables) == 9, f"Expected 9 V3 tables, got {sorted(tables)}"

triggers = db.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'"
).fetchone()[0]
assert triggers == 12, f"Expected 12 safety triggers, got {triggers}"

db.execute("""
    INSERT INTO v3_economy_accounts (id,owner_type,owner_id,asset_code,bucket)
    VALUES ('user-tl','user','1','TL','purchased'),
           ('platform-tl','platform','timelink','TL','revenue')
""")
db.execute("INSERT INTO v3_economy_balances (account_id,available_atoms) VALUES ('user-tl',100)")
db.execute("INSERT INTO v3_economy_balances (account_id,available_atoms) VALUES ('platform-tl',0)")
db.execute("""
    INSERT INTO v3_economy_transactions
      (id,idempotency_key,transaction_type,source)
    VALUES ('tx-1','test-1','test-transfer','test')
""")
db.execute("""
    INSERT INTO v3_economy_entries (transaction_id,account_id,asset_code,amount_atoms)
    VALUES ('tx-1','user-tl','TL',-10), ('tx-1','platform-tl','TL',10)
""")
db.execute("UPDATE v3_economy_balances SET available_atoms=available_atoms-10 WHERE account_id='user-tl'")
db.execute("UPDATE v3_economy_balances SET available_atoms=available_atoms+10 WHERE account_id='platform-tl'")
assert db.execute("SELECT SUM(amount_atoms) FROM v3_economy_entries WHERE transaction_id='tx-1' AND asset_code='TL'").fetchone()[0] == 0
assert db.execute("SELECT available_atoms FROM v3_economy_balances WHERE account_id='user-tl'").fetchone()[0] == 90

def must_fail(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f"Expected integrity failure: {statement}")

must_fail("UPDATE v3_economy_balances SET available_atoms=-1 WHERE account_id='user-tl'")
must_fail("UPDATE v3_economy_entries SET amount_atoms=99 WHERE transaction_id='tx-1'")
must_fail("INSERT INTO v3_economy_entries (transaction_id,account_id,asset_code,amount_atoms) VALUES ('tx-1','user-tl','TLC',1)")

db.execute("""
    INSERT INTO v3_poc_events
      (id,user_id,event_key,event_type,source,formula_version)
    VALUES ('poc-1','1','event-1','verified_play','playback','v3.1')
""")
must_fail("UPDATE v3_poc_events SET contribution_value=99 WHERE id='poc-1'")

db.execute("""
    INSERT INTO v3_poc_snapshots
      (id,user_id,period_start,period_end,poc_index,components_json,formula_version)
    VALUES ('snap-1','1','2026-10-01','2026-10-31',1.25,'{}','v3.1')
""")
must_fail("UPDATE v3_poc_snapshots SET poc_index=2 WHERE id='snap-1'")

db.execute("""
    INSERT INTO v3_tlc_mining_records
      (id,user_id,idempotency_key,period_date,poc_index,plan_code,minted_atoms,status)
    VALUES ('mine-1','1','mine-key-1','2026-10-14',1.25,'A',100,'posted')
""")
must_fail("UPDATE v3_tlc_mining_records SET minted_atoms=200 WHERE id='mine-1'")

print(f"V3 ledger schema test passed: {len(tables)} tables, {triggers} triggers, balanced transfer, integrity guards.")
