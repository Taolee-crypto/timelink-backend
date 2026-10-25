# TimeLink V5 — Global P2P and Travel Credit specification
Status: DESIGN ONLY — not deployed or enabled.
Date: 2026-10-25

## Existing economy integration
Keep the V5 economic ledger authoritative. Pool A converts eligible TL to TLC under the established contribution, eligibility, supply and administrator-controlled policies. Conversion may create TLC only under the existing issuance policy. Pool B transfers existing TLC between verified TILO members and must NEVER mint TLC. Exchange sale on an external exchange is the designated official cash-out path. Member-to-member foreign-currency P2P remains a separate transaction channel and may itself legally constitute exchange/cash-out.

## Member-only cross-border P2P
Verified TILO members only. Seller may request local fiat only while verifiably outside their registered country of residence and subject to country enablement and per-transaction, daily and monthly caps. A verified local TILO member may buy. Travel status must not rely solely on IP/GPS; apply country-specific permitted verification and anti-spoofing controls. Listings include TLC quantity, fiat currency, unit price, payment method and expiry. Buyers explicitly accept seller's price; exchange price is reference only.

## Escrow state machine
DRAFT -> OPEN (reserve TLC atomically) -> MATCHED -> PAYMENT_MARKED -> RELEASED after seller confirms verified receipt; or DISPUTED -> RESOLVED_RELEASE/RESOLVED_REFUND. Expiry before payment returns reserved TLC. Never automatically refund after buyer marks payment without dispute review. Require idempotency keys, atomic wallet reservation, double-spend prevention, immutable audit events, reconciliation and administrative dispute resolution. Platform does not assert that a user screenshot proves settlement. Keep P2P fiat movement outside the TL ledger; record fiat transaction references and TLC transfer separately.

## Travel Credit — two distinct candidate products
Secured: only eligible legally pledgeable and recoverable assets may be reserved as collateral; current TL_P balance is a *candidate input*, not automatically legally enforceable collateral. Credit limit = conservative verified recoverable collateral value times administrator-set LTV, subject to lender approval.
Unsecured: historical recurring eligible TL_P inflows may inform an affordability/risk model, but projected platform rewards are neither guaranteed nor sufficient alone. Use verified income, liabilities, repayment history and lender underwriting; prohibit automatic lending based only on projected rewards.
Credit is not funded, originated, disbursed or collected by the platform unless appropriate legal authority exists. Initially implement a disabled feature flag, simulation-only quote, application referral to licensed partner and human review.

## Minimal interfaces (design contracts)
GET /api/v5/pools/overview -> eligible TL, TLC available/reserved, country features, indicative prices.
POST /api/v5/p2p/listings -> member auth, country eligibility, amount, price, currency, idempotency_key.
POST /api/v5/p2p/listings/:id/match -> escrow order; prevent duplicate match.
POST /api/v5/p2p/orders/:id/payment-marked -> evidence metadata, not bank settlement proof.
POST /api/v5/p2p/orders/:id/release -> verified seller confirmation; atomic TLC transfer.
POST /api/v5/p2p/orders/:id/dispute -> freeze and review.
GET /api/v5/travel-credit/estimate -> simulated secured/unsecured indicative range, no promise.
POST /api/v5/travel-credit/applications -> only after enabled jurisdiction and licensed partner.
All routes are proposals and MUST NOT be advertised as implemented.

## Controls and release gates
Feature flags by residence country, destination country, product, currency and verification level. Default deny. Admin-editable limits and fee settings with versioning, approval and audit trail. Require legal assessment for VASP/exchange, escrow/custody, payments, FX, consumer credit, AML/KYC, sanctions, privacy and travel verification in each market. No claim that low values, foreign travel, pre-listing status or members-only access exempts the service. Start with mocked P2P orders and credit estimates, integration tests and reconciliation; production fiat and credit functions stay disabled until approved.

## Acceptance tests
1. No TLC issuance on P2P transfer.
2. Concurrent matching cannot spend the same TLC twice.
3. Same idempotency key cannot create duplicate escrow.
4. Seller cannot withdraw reserved TLC.
5. Payment-marked cannot trigger automatic irreversible release.
6. Dispute freezes order until authorized resolution.
7. Domestic seller blocked; verified foreign seller permitted only in enabled jurisdictions.
8. Daily/monthly caps enforced across concurrent orders.
9. Credit estimates cannot disburse money.
10. Audit and ledger reconciliation hold under retries, reversals and failures.
