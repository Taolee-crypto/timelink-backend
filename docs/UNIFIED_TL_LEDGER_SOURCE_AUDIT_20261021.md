# TL ledger source audit

Date: 2026-10-21
Branch: economy/unified-ledger-reset-20261021

Static source audit only. No production database writes, browser tests, or deployment.

## Confirmed architecture
- V3 append-only ledger tables and read APIs exist, but legacy payment, advertising, charging, and playback writes still update users and legacy tables directly.
- Wallet fields coexist: users.tl, tl_balance, tl_p, tl_a, tl_b. Track balances live in tl_user_files.
- TLC and POC remain separate assets/contribution records.
- V5 playback meter currently charges tl_user_files by cumulative played-time delta and does not debit the common wallet again. Preserve this behavior and the V5 encrypted container format.

## Confirmed risks
- Legacy POST /api/shares/:id/consume contains both wallet-to-track auto-funding and a subsequent wallet debit alongside track-pool debit. This conflicts with the agreed rule that playback consumes only the track pool.
- POST /api/eco/consume directly debits P/A/B and credits creator balances outside V3.
- Payment providers directly update users.tl/tl_p; their duplicate handling differs.
- Ads code directly updates users.tl/tl_a. Its token parser derives IDs without verifying JWT signatures; replace with shared auth before connecting reward writes.
- /api/payment/virtual/charge is documented as development/test-only but is mounted as a normal authenticated route; production exposure must be checked and blocked or isolated.
- Frontend wallet, dashboard, sidebar/topbar, track, SharePlace, creator, payment result, radio/in-car and admin surfaces read or mutate different legacy fields and localStorage snapshots.

## Screens found in current frontend tree
wallet.html, wallet-v2.html, dashboard.html, sidebar.js, _shared/topbar.js, _shared/topbar-v2.js, index.html, track.html, shareplace.html, renewal/shareplace.html, creator.html, radio.html, incar.html, cafe-radio.html, cafe-channel.html, incar-channel.html, ads.html, advertiser.html, chart.html, admin.html, payment-success.html.

## Important ledger design blocker
The current V3 balances table has nonnegative CHECK constraints for every account, including system accounts. A balanced opening-balance transaction requires a negative counter-entry in a designated system issuance/equity account. Therefore the existing table cannot safely represent explicit admin-entered genesis balances from zero without a schema change or a separately audited genesis mechanism. Do not work around this by silently seeding balances or writing unbalanced entries. Design a versioned schema migration that permits negative balances only for explicitly designated control/equity accounts, while user, escrow, and track-pool accounts remain nonnegative.

## Implementation order
1. Finish route-to-screen caller matrix and define immutable bucket taxonomy for TL_P/A/B, track pools, creator provenance, ad escrow and system equity.
2. Add versioned ledger schema support for audited genesis/opening balances.
3. Add admin preview, manual input, approval and idempotent balanced posting.
4. Add domain command APIs and move payment, ad, charge, playback and reward writes to V3.
5. Move every screen to one wallet read API; remove localStorage as authoritative balance.
6. Run isolated D1 tests for retries, concurrent playback, partial stops, insufficient funds, provider retries, ad reward retries and repeated migration batches.
7. Do not alter V5 encryption format, delete legacy records, write production D1 or deploy without separate approval.
