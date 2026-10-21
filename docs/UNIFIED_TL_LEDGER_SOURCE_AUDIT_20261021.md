# TL ledger source audit

Date: 2026-10-21
Branch: economy/unified-ledger-reset-20261021

Static source audit only. No production database writes, browser tests, or deployment.

## Confirmed architecture
- V3 append-only ledger tables and read APIs exist, but legacy payment, advertising, charging, and playback writes still update users and legacy tables directly.
- Wallet fields coexist: users.tl, tl_balance, tl_p, tl_a, tl_b. Track balances live in tl_user_files.
- TLC and POC remain separate assets/contribution records.
- V5 playback meter currently charges tl_user_files by cumulative played-time delta and does not debit the common wallet again. Preserve this behavior and the V5 encrypted container format.
- Canonical creator distribution policy confirmed by the product owner: creator 70%, platform 30%. `src/economy-policy.ts` now defines the shared 70:30 constants. The legacy POST /api/eco/consume, V5 online meter, offline settlement endpoints, and legacy playback routes now reference the shared creator-rate constant. Source treatment remains distinct in `/api/eco/consume` (TL_P→creator TL_P, TL_A→creator TL_A, TL_B→creator TL_A). The old playback route's car-mode multiplier no longer increases creator payout above 70%; it remains a pulse/contribution multiplier only. This is source-level alignment; runtime and accounting tests have not yet been run.

## Confirmed risks
- Legacy POST /api/shares/:id/consume contains both wallet-to-track auto-funding and a subsequent wallet debit alongside track-pool debit. This conflicts with the agreed rule that playback consumes only the track pool.
- POST /api/eco/consume directly debits P/A/B and credits creator balances outside V3. Its distribution percentage is now 70% on this branch, but it still bypasses the V3 append-only ledger.
- `src/routes/playback.ts` and legacy `/api/shares/:id/consume` still contain direct legacy balance mutations; centralizing the percentage does not resolve their separate wallet/track-pool double-debit or migration risks.
- Payment providers directly update users.tl/tl_p; their duplicate handling differs.
- Ads code directly updates users.tl/tl_a. Its token parser originally derived IDs without JWT verification; this branch now uses shared signed-token verification and checks that the account is active. Reward writes still need migration to V3.
- /api/payment/virtual/charge was documented as development/test-only but mounted as a normal authenticated route; this branch now blocks it when ENVIRONMENT=production.
- Frontend wallet, dashboard, sidebar/topbar, track, SharePlace, creator, payment result, radio/in-car and admin surfaces read or mutate different legacy fields and localStorage snapshots.
- The V5 meter still settles against aggregate `tl_user_files.tl_balance` and credits creator TL_P. The new V3 track-charge path creates source-specific V3 track-pool buckets; end-to-end interoperability between that V3 pool and the existing V5 meter is not yet demonstrated. This is a cutover blocker: do not enable the new charge path for live playback until both paths debit the same authoritative pool exactly once and preserve source provenance.

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
