# TimeLink development factory reset (D1)

**Status: preparation only. No live database has been modified by this PR.**

## Scope

The requested reset removes test members (including the old administrator), audio metadata,
wallet and transaction records, and other test data while retaining table definitions,
migrations, APIs, and economic logic. This is a **destructive** reset.

## Before executing

1. Stop writes to the application and capture a Cloudflare D1 remote SQL export:
   `npx wrangler d1 export timelink-db --remote --output=backup-before-reset.sql`
2. Keep the export outside the Git repository. Never commit backups containing user data.
3. Generate an inventory and draft reset SQL:
   `python scripts/prepare_dev_factory_reset.py backup-before-reset.sql`
4. Inspect **both** `reset-preview.txt` and `reset-dev-data.sql`. The script preserves
   schema/config/migration tables; some of those may contain test data. Review their rows.
   In particular, validate every TL/TLC/POC ledger, account, balance, charge, and playback
   table appears in the reset inventory. Confirm economic assets/precision and rule
   definitions are preserved. Check foreign-key warnings.
5. Check triggers, data dependencies, and migrations against the live schema. Do not run
   blindly. Remote D1 may differ from the export.
6. Separately inventory Cloudflare R2 buckets and delete only confirmed development
   objects **after** backing them up. SQL cannot delete R2 audio objects.
7. Only after approval and backup verification, apply the reviewed SQL to remote D1
   using the authorized Cloudflare deployment procedure. The generator itself NEVER runs SQL.

## Recreate administration

After the reset, register a new user through the existing public registration endpoint.
Use an authenticated, audited operator operation to assign `role='admin'` to that
specific new account. **Do not** add an unauthenticated public admin bootstrap endpoint
or a hard-coded password. Log in to the admin page and verify
`GET /api/admin/session` returns `role='admin'`.

The existing `POST /api/admin/tl/initial-issuance` endpoint (body
`{"confirmation":"ISSUE_INITIAL_1000000_TL"}`) is protected by admin JWT and
requires an empty V3 ledger. First inspect
`GET /api/admin/tl/initial-issuance/status` with the new administrator session.
Only then perform the issuance, confirm the V3 wallet displays 1,000,000 TL,
and test track charging and actual playback settlement at 1 TL per second,
including pause and 70:30 allocation.

**Caution:** existing issuance puts the grant into `wallet_bonus` and labels it
non-redeemable; verify that the charge path can spend that bucket before declaring
playback fixed. This PR does not claim to solve that integration.

## What this PR does not do

- It does not execute remote D1 commands or R2 deletions.
- It does not automatically elevate a newly registered user to administrator.
- It does not erase an external TON wallet or on-chain history.
- It does not verify the economy end-to-end against the live environment.
