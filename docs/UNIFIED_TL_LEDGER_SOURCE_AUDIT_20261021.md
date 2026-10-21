# TL ledger source audit

Date: 2026-10-21
Branch: economy/unified-ledger-reset-20261021

Static source audit only. No production database writes, browser tests, or deployment.

## Confirmed architecture
- V3 append-only ledger tables and read APIs exist, but legacy payment, advertising, charging, and playback writes still update users and legacy tables directly.
- Wallet fields coexist: users.tl, tl_balance, tl_p, tl_a, tl_b. Track balances live in tl_user_files.
- TLC and POC remain separate assets/contribution records.
- V5 playback meter currently charges tl_user_files by cumulative played-time delta and does not debit the common wallet again. Preserve this behavior and the V5 encrypted container format.
- Creator distribution policies conflict in current code: economics.ts defines plan A/B rates by TL_P/TL_A and a TL_B-to-TL_A rule, while the V5 meter currently credits a flat 70% into creator TL_P. This must be reconciled before changing creator settlement.

## Confirmed risks
- Legacy POST /api/shares/:id/consume contains both wallet-to-track auto-funding and a subsequent wallet debit alongside track-pool debit. This conflicts with the agreed rule that playback consumes only the track pool.
- POST /api/eco/consume directly debits P/A/B and credits creator balances outside V3.
- Payment providers directly update users.tl/tl_p; their duplicate handling differs.
- Ads code directly updates users.tl/tl_a. Its token parser originally derived IDs without JWT verification; this branch now uses shared signed-token verification and checks that the account is active. Reward writes still need migration to V3.
- /api/payment/virtual/charge was documented as development/test-only but mounted as a normal authenticated route; this branch now blocks it when ENVIRONMENT=production.
- Frontend wallet, dashboard, sidebar/topbar, track, SharePlace, creator, payment result, radio/in-car and admin surfaces read or mutate different legacy fields and localStorage snapshots.

## Screens found in current frontend tree
wallet.html, wallet-v2.html, dashboard.html, sidebar.js, _shared/topbar.js, _shared/topbar-v2.js, index.html, track.html, shareplace.html, renewal/shareplace.html, creator.html, radio.html, incar.html, cafe-radio.html, cafe-channel.html, incar-channel.html, ads.html, advertiser.html, chart.html, admin.html, payment-success.html.

## Important ledger design blocker
The current V3 balances table originally constrained every account to nonnegative values. A balanced opening-balance transaction requires a negative counter-entry in a designated system issuance/equity account. Migration 0011 therefore rebuilds the balances table and permits negative available balance only for the dedicated system/genesis_equity account; user, escrow, partner, and ordinary platform accounts remain nonnegative. This schema change still requires CI validation before any database application.

## Implementation order
1. Finish route-to-screen caller matrix and define immutable bucket taxonomy for TL_P/A/B, track pools, creator provenance, ad escrow and system equity.
2. Add versioned ledger schema support for audited genesis/opening balances.
3. Add admin preview, manual input, approval and idempotent balanced posting.
4. Add domain command APIs and move payment, ad, charge, playback and reward writes to V3.
5. Move every screen to one wallet read API; remove localStorage as authoritative balance.
6. Run isolated D1 tests for retries, concurrent playback, partial stops, insufficient funds, provider retries, ad reward retries and repeated migration batches.
7. Do not alter V5 encryption format, delete legacy records, write production D1 or deploy without separate approval.
