#!/usr/bin/env python3
"""Offline-only TimeLink development reset. Never connects to production D1.

Import a fresh D1 export into a disposable SQLite database before using this.
Default is preview. --apply requires an explicit backup acknowledgement.
"""
import argparse
import sqlite3
from pathlib import Path

KEEP_EMAIL = "mununglee@gmail.com"
KEEP_ID = 2
PROTECTED = {
    "users", "tl_files", "tl_shares", "tracks", "tl3_v5_releases",
    "tl3_v5_track_metadata", "tl3_releases", "tl3_spine_v4_releases",
    "tl_assets", "tl_creator_metadata", "tl_d1_upload_sessions",
    "storage_objects", "storage_connections", "sqlite_sequence",
    "d1_migrations",
}
USER_COLUMNS = {
    "user_id", "owner_id", "owner_user_id", "creator_id",
    "listener_id", "payer_id", "player_user_id", "disputer_user_id",
    "actor_user_id", "invited_by", "approved_by", "reviewed_by",
}
BALANCE_FIELDS = {
    "users": {"tl", "tl_balance", "tl_locked", "tlc_balance", "tlc",
              "tl_p", "tl_a", "tl_b", "tl_p_lifetime", "tl_p_exchanged"},
    "tl_user_files": {"tl_balance", "total_charged", "total_consumed"},
    "tl_files": {"file_tl", "max_file_tl", "revenue", "hold_revenue"},
    "tl_shares": {"file_tl", "creator_earned"},
    "tracks": {"file_tl", "creator_tl"},
}

def quote(name):
    return '"' + name.replace('"', '""') + '"'

def columns(db, table):
    return {r[1] for r in db.execute("PRAGMA table_info(" + quote(table) + ")")}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("database", type=Path, help="DISPOSABLE local SQLite DB, not production")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--backup-confirmed", action="store_true")
    args = p.parse_args()
    if args.apply and not args.backup_confirmed:
        p.error("--apply requires --backup-confirmed")
    if not args.database.is_file() or args.database.suffix.lower() not in {".db", ".sqlite", ".sqlite3"}:
        p.error("Provide an existing disposable .db/.sqlite/.sqlite3 file")
    db = sqlite3.connect(str(args.database))
    db.execute("PRAGMA foreign_keys=ON")
    tables = {r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if "users" not in tables:
        p.error("users table missing")
    keep = db.execute("SELECT id,role FROM users WHERE lower(email)=?", (KEEP_EMAIL,)).fetchall()
    if keep != [(KEEP_ID, "admin")]:
        p.error("Admin identity mismatch: refusing to modify anything")
    other_ids = [r[0] for r in db.execute("SELECT id FROM users WHERE id<>?", (KEEP_ID,))]
    print(f"Admin preserved: {KEEP_EMAIL} (id={KEEP_ID}); other users={len(other_ids)}")
    # Fail closed if ANY asset owner is not the retained administrator.
    for table in sorted(PROTECTED & tables):
        cols = columns(db, table)
        for owner in (USER_COLUMNS & cols):
            if table in {"storage_objects", "storage_connections"}:
                continue  # Separate deletion requires explicit review.
            count = db.execute(
                f"SELECT count(*) FROM {quote(table)} WHERE {quote(owner)} IS NOT NULL AND {quote(owner)}<>?",
                (KEEP_ID,)).fetchone()[0]
            if count:
                p.error(f"Protected table {table}.{owner} has {count} non-admin references; abort")
    # This reset is intentionally fail-closed: no generic deletion of unknown tables.
    # List affected tables for a targeted cleanup migration.
    for table in sorted(tables - PROTECTED):
        cols = columns(db, table)
        linked = sorted(cols & USER_COLUMNS)
        if linked:
            predicates = " OR ".join(f"({quote(c)} IS NOT NULL AND {quote(c)}<>?)" for c in linked)
            n = db.execute(f"SELECT count(*) FROM {quote(table)} WHERE {predicates}",
                           [KEEP_ID] * len(linked)).fetchone()[0]
            if n:
                print(f"REVIEW {table}: {n} rows, columns={','.join(linked)}")
    for table, fields in BALANCE_FIELDS.items():
        if table in tables:
            present = sorted(fields & columns(db, table))
            if present:
                print(f"RESET CANDIDATE {table}: {','.join(present)}")
    print("No changes made. Asset, foreign-key and dependent-record review required.")
    if args.apply:
        p.error("Apply deliberately disabled until all dependent tables are classified")

if __name__ == "__main__":
    main()
