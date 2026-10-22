#!/usr/bin/env python3
"""Inspect remote D1 tables directly, without exporting or backing up data.

Read-only. Does not delete or modify Cloudflare data.
"""
import json
import re
import subprocess
import sys

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
    command = ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", QUERY]
    print("Reading remote D1 schema (read-only; no backup)...", flush=True)
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
    except FileNotFoundError:
        sys.exit("ERROR: npx not found; run in a terminal with Node.js installed")
    except subprocess.CalledProcessError as exc:
        sys.exit("ERROR: Wrangler schema query failed:\n" + (exc.stderr or exc.stdout))
    try:
        payload = json.loads(result.stdout)
        batches = payload if isinstance(payload, list) else [payload]
        rows = [row for batch in batches for row in batch.get("results", [])]
        if not rows:
            sys.exit("STOP: no schema rows returned; nothing will be changed")
        names = {row["name"] for row in rows}
    except (ValueError, KeyError, TypeError) as exc:
        sys.exit(f"ERROR: unexpected Wrangler JSON output: {exc}; no changes made")
    preserved = sorted(n for n in names if n in KEEP_EXACT or n.startswith(KEEP_PREFIXES) or REVIEW.search(n))
    targets = sorted(names - set(preserved))
    if not targets:
        sys.exit("STOP: no candidate data tables; no changes made")
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
        "WARNING: candidate list is not deletion SQL. Foreign keys and economic dependencies must be reviewed before reset.",
    ]
    output = "\n".join(report) + "\n"
    with open("reset-preview.txt", "w", encoding="utf-8") as file:
        file.write(output)
    print(output)


if __name__ == "__main__":
    main()
