#!/usr/bin/env python3
"""Generate a narrow, reviewed admin promotion SQL statement after factory reset.

This does NOT execute SQL or create a password. Register the new user first.
Usage: python scripts/prepare_new_admin.py new-admin@example.com
"""
import argparse
import pathlib
import sys

p = argparse.ArgumentParser()
p.add_argument("email")
p.add_argument("--out", type=pathlib.Path, default=pathlib.Path("promote-new-admin.sql"))
a = p.parse_args()
email = a.email.strip().lower()
if not email or "@" not in email or len(email) > 254:
    sys.exit("Valid newly registered email required")
escaped = email.replace("'", "''")
sql = f"""-- REVIEW BEFORE RUNNING AGAINST REMOTE D1.
-- Run only after registering the intended new administrator.
-- The following assertion aborts if this email does not uniquely identify one user.
CREATE TEMP TABLE _admin_reset_guard (n INTEGER NOT NULL CHECK(n=1));
INSERT INTO _admin_reset_guard SELECT COUNT(*) FROM users WHERE lower(email)='{escaped}';
UPDATE users SET role='admin' WHERE lower(email)='{escaped}';
DROP TABLE _admin_reset_guard;
"""
a.out.write_text(sql, encoding="utf-8")
print(f"Created {a.out}. Inspect before running; no database changes made.")
