#!/usr/bin/env python3
"""Prepare (never execute) a D1 development factory reset from a Wrangler D1 SQL export.

Workflow:
  npx wrangler d1 export timelink-db --remote --output=backup-before-reset.sql
  python scripts/prepare_dev_factory_reset.py backup-before-reset.sql
Review reset-preview.txt and reset-dev-data.sql before any remote execution.

The SQL export is the REQUIRED backup. This script never connects to Cloudflare.
It intentionally does not delete R2 objects; those need a separately reviewed manifest.
"""
import argparse
import pathlib
import re
import sqlite3
import sys

KEEP_EXACT = {
    "d1_migrations", "_cf_KV", "v3_economy_assets",
    "v3_economy_rules", "v3_economy_rule_versions",
    "v3_economy_policy", "v3_economy_settings",
}
KEEP_PREFIXES = ("sqlite_", "_cf_", "d1_",)
# Tables containing durable system configuration must be reviewed, not guessed.
REVIEW_PATTERN = re.compile(r"(settings|config|policy|rule|migration|schema|feature_flag)", re.I)


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def main():
    p = argparse.ArgumentParser()
    p.add_argument("export", type=pathlib.Path)
    p.add_argument("--out", type=pathlib.Path, default=pathlib.Path("reset-dev-data.sql"))
    p.add_argument("--preview", type=pathlib.Path, default=pathlib.Path("reset-preview.txt"))
    args = p.parse_args()
    if not args.export.is_file() or args.export.stat().st_size == 0:
        sys.exit("ERROR: nonempty D1 SQL backup/export is required")
    if args.out.resolve() == args.export.resolve():
        sys.exit("ERROR: output must not overwrite backup")
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(args.export.read_text(encoding="utf-8"))
    except sqlite3.DatabaseError as exc:
        sys.exit(f"ERROR: cannot load SQL export into SQLite: {exc}")
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    names = [r[0] for r in rows]
    preserved = [n for n in names if n in KEEP_EXACT or n.startswith(KEEP_PREFIXES) or REVIEW_PATTERN.search(n)]
    targets = [n for n in names if n not in preserved]
    # Avoid accidentally preserving user-created settings tables with test data:
    # require explicit human review of the preserved table list.
    count = {n: connection.execute(f"SELECT COUNT(*) FROM {quote(n)}").fetchone()[0] for n in names}
    fk_warnings = []
    for table in preserved:
        for fk in connection.execute(f"PRAGMA foreign_key_list({quote(table)})"):
            if fk[2] in targets:
                fk_warnings.append(f"{table} references reset table {fk[2]}")
    preview = [
        "TIMELINK DEV FACTORY RESET — REVIEW REQUIRED",
        f"BACKUP: {args.export.resolve()}",
        "NO COMMANDS HAVE BEEN EXECUTED AGAINST REMOTE D1.",
        "Tables to DELETE (data only; schema preserved):",
        *[f"  {n}: {count[n]} rows" for n in targets],
        "Tables PRESERVED (review for test data that also needs clearing):",
        *[f"  {n}: {count[n]} rows" for n in preserved],
        "Foreign key warnings:",
        *(fk_warnings or ["  none detected"]),
        "R2 objects are NOT covered by this reset.",
        "TON external wallet and on-chain history are NOT covered by this reset.",
        "After reset, re-register first account and grant admin role through an authenticated operator process.",
        "Do not run this SQL until the schema and dependencies have been reviewed.",
    ]
    args.preview.write_text("\n".join(preview) + "\n", encoding="utf-8")
    if fk_warnings:
        sys.exit("STOP: preserved tables reference deleted tables. Preview written; no executable SQL generated.")
    if not targets:
        sys.exit("ERROR: no reset targets detected; refusing to create empty reset")
    # Delete children before parents where possible. Cycles require separate review.
    dependencies = {n: {fk[2] for fk in connection.execute(f"PRAGMA foreign_key_list({quote(n)})") if fk[2] in targets} for n in targets}
    ordered = []
    remaining = set(targets)
    while remaining:
        leaves = sorted(n for n in remaining if not any(n in dependencies[other] for other in remaining if other != n))
        if not leaves:
            sys.exit("STOP: foreign-key cycle detected. Preview written; no executable SQL generated.")
        ordered.extend(leaves)
        remaining.difference_update(leaves)
    statements = [
        "-- GENERATED FROM A BACKUP. REVIEW BEFORE EXECUTION.",
        "-- This file removes DATA ONLY. Does not drop schema, migrations or application code.",
        "PRAGMA defer_foreign_keys = ON;",
        *[f"DELETE FROM {quote(n)};" for n in ordered],
    ]
    args.out.write_text("\n".join(statements) + "\n", encoding="utf-8")
    print(f"Prepared {args.out} and {args.preview}; {len(targets)} data tables, {len(preserved)} preserved.")
    if fk_warnings:
        print("WARNING: preserved tables reference reset tables; inspect preview before execution.")


if __name__ == "__main__":
    main()
