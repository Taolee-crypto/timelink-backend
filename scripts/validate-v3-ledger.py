from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0003_v3_economy_ledger.sql"

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")

# Representative legacy schema and balances. Migration 0003 must be additive:
# these rows and definitions are evidence and must remain unchanged.
legacy_fixture = """
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  tl_balance REAL DEFAULT 0,
  tl_locked REAL DEFAULT 0,
  tlc_balance REAL DEFAULT 0,
  total_tl_spent REAL DEFAULT 0,
  total_tl_earned REAL DEFAULT 0,
  total_tl_exchanged REAL DEFAULT 0,
  poc_index REAL DEFAULT 1
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tx_type TEXT NOT NULL,
  amount REAL NOT NULL
);
CREATE TABLE tl_files (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  revenue REAL DEFAULT 0,
  hold_revenue REAL DEFAULT 0
);
CREATE TABLE tl_shares (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  revenue REAL DEFAULT 0,
  hold_revenue REAL DEFAULT 0
);
CREATE TABLE poc_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  delta REAL NOT NULL
);
CREATE TABLE poc_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  contribution REAL NOT NULL
);
CREATE TABLE tlc_mining_v2 (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tlc_mined REAL NOT NULL
);
"""
db.executescript(legacy_fixture)
db.execute("INSERT INTO users VALUES (1,1200,50,3.125,400,90,10,1.35)")
db.execute("INSERT INTO transactions VALUES (11,1,'purchase',500)")
db.execute("INSERT INTO tl_files VALUES (21,1,75,15)")
db.execute("INSERT INTO tl_shares VALUES (31,1,60,20)")
db.execute("INSERT INTO poc_events VALUES (41,1,0.25)")
db.execute("INSERT INTO poc_logs VALUES (51,1,0.5)")
db.execute("INSERT INTO tlc_mining_v2 VALUES (61,1,2.75)")

legacy_tables = (
    "users", "transactions", "tl_files", "tl_shares",
    "poc_events", "poc_logs", "tlc_mining_v2",
)

def legacy_snapshot():
    schema = {
        name: db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()[0]
        for name in legacy_tables
    }
    rows = {
        name: db.execute(f'SELECT * FROM "{name}" ORDER BY 1').fetchall()
        for name in legacy_tables
    }
    return schema, rows

before = legacy_snapshot()
migration_sql = MIGRATION.read_text(encoding="utf-8")
db.executescript(migration_sql)

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

# Re-applying the migration must be safe and must not duplicate schema objects.
db.executescript(migration_sql)
assert db.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
).fetchone()[0] == 9
assert db.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'"
).fetchone()[0] == 12
assert legacy_snapshot() == before, "Migration changed legacy schema or data"

db.execute("""
    INSERT INTO v3_economy_accounts (id,owner_type,owner_id,asset_code,bucket)
    VALUES ('user-tl','user','1','TL','purchased'),
           ('platform-tl','platform','timelink','TL','revenue'),
           ('user-ad','user','1','TL','ad_reward'),
           ('user-bonus','user','1','TL','bonus'),
           ('user-tlc','user','1','TLC','token')
""")
for account_id, balance in (
    ("user-tl",100), ("platform-tl",0), ("user-ad",20),
    ("user-bonus",30), ("user-tlc",0),
):
    db.execute(
        "INSERT INTO v3_economy_balances (account_id,available_atoms) VALUES (?,?)",
        (account_id,balance),
    )

db.execute("""
    INSERT INTO v3_economy_transactions
      (id,idempotency_key,transaction_type,source)
    VALUES ('tx-1','test-1','test-transfer','test')
""")
db.execute("""
    INSERT INTO v3_economy_entries (transaction_id,account_id,asset_code,amount_atoms)
    VALUES ('tx-1','user-tl','TL',-10), ('tx-1','platform-tl','TL',10)
""")
db.execute(
    "UPDATE v3_economy_balances SET available_atoms=available_atoms-10 WHERE account_id='user-tl'"
)
db.execute(
    "UPDATE v3_economy_balances SET available_atoms=available_atoms+10 WHERE account_id='platform-tl'"
)
assert db.execute(
    "SELECT SUM(amount_atoms) FROM v3_economy_entries WHERE transaction_id='tx-1' AND asset_code='TL'"
).fetchone()[0] == 0
assert db.execute(
    "SELECT available_atoms FROM v3_economy_balances WHERE account_id='user-tl'"
).fetchone()[0] == 90

def must_fail(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f"Expected integrity failure: {statement}")

must_fail("UPDATE v3_economy_balances SET available_atoms=-1 WHERE account_id='user-tl'")
must_fail(
    "INSERT INTO v3_economy_entries (transaction_id,account_id,asset_code,amount_atoms) "
    "VALUES ('tx-1','user-tl','TLC',1)"
)
must_fail("UPDATE v3_economy_entries SET amount_atoms=99 WHERE transaction_id='tx-1'")
must_fail("DELETE FROM v3_economy_transactions WHERE id='tx-1'")

db.execute("""
    INSERT INTO v3_poc_events
      (id,user_id,event_key,event_type,source,formula_version)
    VALUES ('poc-1','1','event-1','verified_play','playback','v3.1')
""")
must_fail("UPDATE v3_poc_events SET contribution_value=99 WHERE id='poc-1'")
must_fail("DELETE FROM v3_poc_events WHERE id='poc-1'")

db.execute("""
    INSERT INTO v3_poc_snapshots
      (id,user_id,period_start,period_end,poc_index,components_json,formula_version)
    VALUES ('snap-1','1','2026-10-01','2026-10-31',1.25,'{}','v3.1')
""")
must_fail("UPDATE v3_poc_snapshots SET poc_index=2 WHERE id='snap-1'")
must_fail(
    "INSERT INTO v3_poc_snapshots "
    "(id,user_id,period_start,period_end,poc_index,components_json,formula_version) "
    "VALUES ('snap-invalid','1','2026-10-01','2026-10-31',5.1,'{}','v3.1')"
)

db.execute("""
    INSERT INTO v3_tlc_mining_records
      (id,user_id,idempotency_key,period_date,poc_index,plan_code,minted_atoms,status)
    VALUES ('mine-1','1','mine-key-1','2026-10-14',1.25,'A',100,'posted')
""")
must_fail("UPDATE v3_tlc_mining_records SET minted_atoms=200 WHERE id='mine-1'")
must_fail("DELETE FROM v3_tlc_mining_records WHERE id='mine-1'")

assert legacy_snapshot() == before, "V3 test operations unexpectedly changed legacy data"

print(
    f"V3 ledger validation passed: {len(tables)} tables, {triggers} triggers, "
    "idempotent migration, unchanged legacy fixtures, balanced entries, "
    "separate TL buckets, and immutable-record/integrity guards."
)
