#!/usr/bin/env python3
"""Inspect remote D1 tables directly, without exporting or backing up data.

Read-only. Does not delete or modify Cloudflare data.
"""
import json
import os
import shutil
import re
import subprocess
import sys
import sqlite3

DB = "timelink-db"
KEEP_EXACT = {
    "d1_migrations", "_cf_KV", "v3_economy_assets",
    "v3_economy_rules", "v3_economy_rule_versions",
    "v3_economy_policy", "v3_economy_settings",
}
KEEP_PREFIXES = ("sqlite_", "_cf_", "d1_")
REVIEW = re.compile(r"(settings|config|policy|rule|migration|schema|feature_flag)", re.I)
QUERY = "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"


def main():
    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx") or shutil.which("npx")
    if not npx:
        sys.exit("ERROR: npx launcher not found on PATH; check where.exe npx in PowerShell")
    command = [npx, "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", QUERY]
    print("Reading remote D1 schema (read-only; no backup)...", flush=True)
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
    except FileNotFoundError:
        sys.exit("ERROR: npx launcher could not start; run where.exe npx to check its location")
    except subprocess.CalledProcessError as exc:
        sys.exit("ERROR: Wrangler schema query failed:\n" + (exc.stderr or exc.stdout))
    try:
        payload = json.loads(result.stdout)
        batches = payload if isinstance(payload, list) else [payload]
        rows = [row for batch in batches for row in batch.get("results", [])]
        if not rows:
            sys.exit("STOP: no schema rows returned; nothing will be changed")
        names = {row["name"] for row in rows}
        definitions = {row["name"]: row.get("sql") for row in rows}
    except (ValueError, KeyError, TypeError) as exc:
        sys.exit(f"ERROR: unexpected Wrangler JSON output: {exc}; no changes made")
    preserved = sorted(n for n in names if n in KEEP_EXACT or n.startswith(KEEP_PREFIXES) or REVIEW.search(n))
    targets = sorted(names - set(preserved))
    if not targets:
        sys.exit("STOP: no candidate data tables; no changes made")
    # Rebuild only the schema in memory; no remote data, exports, or backups.
    model = sqlite3.connect(":memory:")
    errors = []
    for name in sorted(names):
        if name.startswith(("sqlite_", "_cf_")):
            continue
        definition = definitions.get(name)
        if not definition:
            errors.append("Missing schema: " + name)
            continue
        try:
            model.execute(definition)
        except sqlite3.DatabaseError as exc:
            errors.append(name + ": " + str(exc))
    def fks(table):
        escaped = table.replace('"', '""')
        return {fk[2] for fk in model.execute('PRAGMA foreign_key_list("' + escaped + '")')}
    preserved_links = []
    for name in preserved:
        if name.startswith(("sqlite_", "_cf_")):
            continue
        for parent in fks(name):
            if parent in targets:
                preserved_links.append(name + " -> " + parent)
    dependencies = {name: fks(name) & set(targets) for name in targets}
    remaining = set(targets)
    deletion_order = []
    while remaining:
        ready = sorted(name for name in remaining if not any(name in dependencies[other] for other in remaining if other != name))
        if not ready:
            break
        deletion_order.extend(ready)
        remaining.difference_update(ready)
    # tl3_assertion_guard is a sentinel, not disposable user data.
    if "tl3_assertion_guard" in deletion_order:
        deletion_order.remove("tl3_assertion_guard")
        preserved.append("tl3_assertion_guard")
        targets.remove("tl3_assertion_guard")
    blockers = errors + preserved_links + sorted(remaining)
    if remaining:
        blockers.append("Foreign-key cycle detected: " + ", ".join(sorted(remaining)))
    from pathlib import Path
    output_sql = Path("reset-dev-data.sql")
    output_sql.unlink(missing_ok=True)
    if not blockers:
        with output_sql.open("w", encoding="utf-8") as handle:
            handle.write("-- REVIEW ONLY; no remote deletion performed.\n")
            for name in deletion_order:
                handle.write('DELETE FROM "' + name.replace('"', '""') + '";\n')
    report = [
        "TIMELINK REMOTE D1 SCHEMA INSPECTION (READ ONLY)",
        "No backup created. No data deleted.",
        "",
        "CANDIDATE DATA TABLES (not yet approved for deletion):",
        *["  " + n for n in targets],
        "",
        "PRESERVED / MANUAL REVIEW:",
        *["  " + n for n in preserved],
        "",
        "FK/schema blockers: " + ("; ".join(blockers) if blockers else "none"),
        "Local deletion SQL prepared: " + ("YES" if not blockers else "NO"),
        "Delete order: child tables before referenced parent tables.",
        "WARNING: Review tl_settings and preserved asset rows before running any deletion.",
    ]
    output = "\n".join(report) + "\n"
    with open("reset-preview.txt", "w", encoding="utf-8") as file:
        file.write(output)
    print(output)


if __name__ == "__main__":
    main()
