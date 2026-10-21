## 2026-10-21 V3 playback settlement alignment

- Canonical policy: creator 70%, platform 30%, defined in `src/economy-policy.ts`.
- TL precision: `1 TL = 10,000 integer atoms` (4 decimal places). This allows the existing audible-time meter's 0.001-second/0.001-TL increments to be represented while keeping the 70:30 split exact at each 0.001 TL.
- Migration `0012_tl_milli_atoms.sql` scales existing V3 TL entries and cached balances by 10,000 and sets TL decimals to 4. It does not alter legacy `users` balances or `tl_user_files`; it must be reviewed and applied before the V3 playback routes can operate.
- `src/economy-ledger.ts` now owns V3 track charging and playback settlement helpers. Charging transfers from common wallet buckets into per-track pools in the established priority TL_A → TL_B → TL_P. Legacy/unclassified pool balances are visible but are not spendable until their source is reconciled.
- V5 online meter `POST /api/v1/tl3/play/meter/:id` now debits only the V3 per-track pool. Its D1 batch posts the balanced source-preserving entries and advances the meter session with a compare-and-swap guard atomically. No second debit is made against the common wallet.
- Source payout: TL_P → creator `wallet_paid`; TL_A → creator `wallet_ad`; TL_B → creator `wallet_ad` (TL_A). The platform's 30% is posted to platform-owned `playback_revenue_paid/ad/bonus` accounts. Self-play does not credit the listener's wallet; the creator 70% is held in a creator-specific escrow bucket.
- Track charge routes `/api/shares/:id/charge` and `/api/v3/economy/tracks/:shareId/charge`, plus `/api/shares/:id/my-tl`, now use V3 track pools. Frontend Track, Radio, In-car, and SharePlace charge requests retain an idempotency key across retries and synchronize the wallet from the server response.
- Legacy TL3 consumption paths are blocked: `/api/shares/:id/consume`, `/api/eco/consume` for released TL3 shares, and `/api/v1/playback/tl3/consume`. Old full-track/segment metering and offline TL3 debit/refund paths return 410 or 409 instead of mutating legacy balances.
- `/api/eco/wallet` reads V3 wallet buckets only after the TL precision migration is present; before that it keeps the legacy read-only view. V3 economy routes return 503 until migration 0012 has set TL decimals to 4.
- Remaining cutover work: reconcile and import legacy user balances and per-track `tl_user_files` balances into V3 opening batches with evidence; move successful payment credits (`payment.ts` Toss/PortOne/Stripe), ad rewards (`ads_backend.ts` and `/api/eco/ad-reward`), and any mission rewards from legacy `users` fields into balanced V3 transactions before enabling the V3 wallet read globally; update remaining creator/admin/statistics screens that still read legacy `users` payout fields; review offline playback support before re-enabling it. Until those credit paths are migrated, a post-migration V3 wallet can omit new legacy payment/ad credits, so this branch is not production-cutover ready.
- Validation status: the 0012 SQL scaling statements and integer 70:30 split arithmetic were checked against an isolated SQLite fixture. The repository validation script, runtime playback/accounting tests, TypeScript build, and CI have not been run. Migration 0012 has not been applied to any D1 database. No deployment or production data mutation has been performed.

# TL ledger source audit

Date: 2026-10-21
Branch: economy/unified-ledger-reset-20261021

Static source audit only. No production database writes, browser tests, or deployment.

## Confirmed architecture
- V3 append-only ledger tables and read APIs exist, but legacy payment, advertising, charging, and playback writes still update users and legacy tables directly.
- Wallet fields coexist: users.tl, tl_balance, tl_p, tl_a, tl_b. Track balances live in tl_user_files.
- TLC and POC remain separate assets/contribution records.
- V5 playback license issuance (`/api/v1/tl3/v5/session-license/:id`), preflight, and online meter now use the canonical V3 per-track pool. The V5 encrypted container and key-wrapping flow remain unchanged. The meter posts source-preserving 70:30 settlement and the meter-session compare-and-swap in one D1 batch.
- Canonical creator distribution policy confirmed by the product owner: creator 70%, platform 30%. `src/economy-policy.ts` now defines the shared 70:30 constants. The legacy POST /api/eco/consume, V5 online meter, offline settlement endpoints, and legacy playback routes now reference the shared creator-rate constant. Source treatment remains distinct in `/api/eco/consume` (TL_P→creator TL_P, TL_A→creator TL_A, TL_B→creator TL_A). The old playback route's car-mode multiplier no longer increases creator payout above 70%; it remains a pulse/contribution multiplier only. This is source-level alignment; runtime and accounting tests have not yet been run.

## Confirmed risks
- Legacy POST /api/shares/:id/consume contains both wallet-to-track auto-funding and a subsequent wallet debit alongside track-pool debit. This conflicts with the agreed rule that playback consumes only the track pool.
- POST /api/eco/consume directly debits P/A/B and credits creator balances outside V3. Its distribution percentage is now 70% on this branch, but it still bypasses the V3 append-only ledger.
- The legacy routes calculate the 30% platform remainder, but do not consistently post it as a balanced credit to a canonical V3 platform account. The split percentage is aligned; platform-side ledger recognition is not complete.
- `src/routes/playback.ts` and legacy `/api/shares/:id/consume` still contain direct legacy balance mutations; centralizing the percentage does not resolve their separate wallet/track-pool double-debit or migration risks.
- Payment providers directly update users.tl/tl_p; their duplicate handling differs.
- Ads code directly updates users.tl/tl_a. Its token parser originally derived IDs without JWT verification; this branch now uses shared signed-token verification and checks that the account is active. Reward writes still need migration to V3.
- /api/payment/virtual/charge was documented as development/test-only but mounted as a normal authenticated route; this branch now blocks it when ENVIRONMENT=production.
- Frontend wallet, dashboard, sidebar/topbar, track, SharePlace, creator, payment result, radio/in-car and admin surfaces read or mutate different legacy fields and localStorage snapshots.
- V5 license issuance and online meter are now connected to the same V3 track-pool buckets created by the V3 charge route. The meter preserves paid/ad/bonus provenance, credits the creator 70% to the matching eligible bucket (TL_B creator share is TL_A), and posts the platform 30% to platform revenue accounts. This source-level connection is implemented on the branch but remains unverified by runtime playback and concurrency tests.

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
