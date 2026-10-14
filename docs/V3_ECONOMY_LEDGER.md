# TimeLink V3 Economy Ledger

## Purpose

This is the additive foundation for the V3 economy. It introduces a canonical, append-only double-entry ledger without altering or migrating any legacy balance. The schema is intentionally isolated under `v3_` names so existing production routes continue to operate during the transition.

## Monetary units

- **TL**: internal TimeLink time unit. One second corresponds to one TL; the reference value is KRW 1 per TL. This is an internal platform unit, not a statement that TL is legal tender.
- **TLC**: separate token asset. TLC is stored in 10^-9 atoms in the V3 ledger; on-chain minting and confirmation remain a separate integration.
- **POC**: contribution index, not a currency, wallet balance, or transferable asset.

The asset registry stores precision. Ledger amounts are integer atoms to avoid floating-point balance arithmetic.

## Tables

| Table | Responsibility |
|---|---|
| `v3_economy_assets` | TL/TLC asset codes and precision |
| `v3_economy_accounts` | User, platform, escrow, system, and partner accounts; separate buckets |
| `v3_economy_balances` | Mutable balance projection/cache; never the source of truth |
| `v3_economy_transactions` | Idempotent transaction header |
| `v3_economy_entries` | Immutable signed postings for each account and asset |
| `v3_poc_events` | Verified contribution facts with unique event keys |
| `v3_poc_snapshots` | Versioned, reproducible POC calculation snapshots |
| `v3_tlc_mining_records` | Idempotent daily TLC calculation and mint records |
| `v3_economy_legacy_imports` | Per-field provenance and reconciliation of legacy balances |

## Mandatory posting invariants

1. A transaction is posted once. Every request that can be retried must carry a stable idempotency key.
2. Entries are append-only. Corrections use a new compensating transaction; never edit or delete a posted entry.
3. For each transaction and asset, the sum of signed entries must equal zero. The service validates this before writing.
4. Entry insertion, balance projection updates, and transaction header creation must execute in one atomic D1 batch. A partially posted transaction is not acceptable.
5. Balance projections are derived from entries and can be rebuilt. They must never be used as the only audit record.
6. TL buckets remain distinct. Purchased, ad-reward, bonus, creator-earned, escrow, and platform-revenue balances must not be silently merged.
7. TLC posting is separate from TL. On-chain mint requests use an outbox/idempotency flow; a wallet balance update is not proof of an on-chain mint.
8. POC events are generated from server-verifiable facts, not client-asserted seconds, spending, uploads, or listener counts. Formula changes require a new formula version and snapshot.
9. POC is not added to the monetary ledger and does not itself represent a promise of TLC issuance.
10. AI-predicted revenue and finance estimates must be labelled estimates and must never be posted as earned TL.

## Legacy cutover policy

- Do not copy `users.tl`, `tl_p`, `tl_a`, `tl_b`, `tl_balance`, `tlc_balance`, or creator/file balances until each write path and semantic meaning has been reconciled.
- Unknown or contradictory legacy balances are quarantined for review, not guessed into a new bucket.
- `v3_economy_legacy_imports` records the source table, row, field, original amount, target account, checksum, and reconciliation state.
- Existing `transactions`, `poc_events`, `poc_logs`, and `tlc_mining_v2` remain untouched and available as legacy evidence.
- No legacy table is dropped, renamed, or rewritten by migration 0003.
- V3 reads and writes must be enabled per workflow only after its reconciliation and tests pass. The old route remains the compatibility path until then.

## Initial migration validation

Migration 0003 was executed against an in-memory SQLite database during authoring. All 9 V3 tables and 12 safety triggers were created successfully (10 immutable-record guards and 2 ledger integrity guards). This is a syntax/schema smoke test only; it is not a live Cloudflare D1 migration and does not prove compatibility with the production database.

## Next implementation sequence

1. Add a server-only ledger service that creates accounts, validates balanced postings, enforces idempotency, and updates balance projections atomically.
2. Add read-only wallet/history endpoints backed by V3 projections and entries.
3. Add a reconciliation report comparing legacy user and file balances to proposed V3 accounts without moving funds.
4. Migrate one low-risk workflow behind a feature flag, then reconcile.
5. Migrate payment, playback, advertising, broadcast, creator settlement, and TLC minting individually with idempotency and failure recovery.
6. Retire legacy writes only after all workflows have passed reconciliation and production verification.

## Explicit exclusions

This migration does not create or activate lending, investment solicitation, automatic collateral seizure, or a TimeLink-operated P2P lending product. Finance partners remain independently responsible for underwriting, contracts, disbursement, repayment, and legal compliance. TimeLink may provide consent-based asset, rights, usage, sales, and settlement data.
