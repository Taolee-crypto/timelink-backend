# MVP Flow Findings — Backend
Date: 2026-10-14

This document records source-level findings only. No live API or database mutation was performed.

## Active route map
- Login: `POST /api/auth/login` in `src/index.ts`
- SharePlace metadata create/list: `/api/shares` mounted to `shareplaceRouter` in `src/index.ts`
- Legacy SharePlace per-track wallet: `GET /api/shares/:id/my-tl`
- Per-track charge: `POST /api/shares/:id/charge`
- Per-track consume: `POST /api/shares/:id/consume`
- Creator file sync: `POST /api/files/sync` in `src/index.ts`
- TL3 release: `POST /api/v1/tl3/releases` in `src/index.ts`
- Wallet read: `GET /api/eco/wallet` in `src/economics.ts`
- TLC mining: `POST /api/eco/mine-tlc` in `src/economics.ts`

## Findings requiring MVP repair

### BE-MVP-001 — charge/consume debit overlap
The charge handler transfers TL from the user's shared wallet buckets into `tl_user_files.tl_balance`. The consume handler then decreases that per-file balance and also updates the user's wallet columns. The code path therefore appears to debit the same playback value twice when the per-file balance was funded by the wallet. Confirm with a disposable test account and correct the active legacy route before any paid playback trial.

### BE-MVP-002 — inconsistent wallet bucket handling
The charge handler accepts combined `tl_p + tl_a + tl_b` and transfers bonus buckets before purchased TL. The consume handler's later wallet update debits `tl_p` only, while the earlier auto-top-up path can debit `tl_a/tl_b`. This is not a consistent single accounting rule. The product owner must choose one authoritative debit model and apply it once.

### BE-MVP-003 — unauthenticated file sync owner selection
The creator page calls `POST /api/files/sync` without an Authorization header. The current handler trusts `body.user_email` to select the owner and defaults to user ID 1 when it cannot find a match. It may also create a placeholder account. The TL3 release endpoint later checks that the authenticated user owns the resulting `tl_files` row. This mismatch can cause a release failure or incorrect ownership. The sync operation should derive the owner from the authenticated token, not a client-supplied email.

### BE-MVP-004 — separate upload stages
SharePlace metadata creation, file sync, and TL3 release are separate requests. There is no transaction spanning the three operations. The UI should retain clear stage results and support retry/reconciliation without creating duplicate shares or file records.

### BE-MVP-005 — test mining and wallet UI are separate
The economics module contains the TLC mining endpoint. The inspected `public/wallet.html` button handler only changes its own text/style and does not call that endpoint. Preserve the existing user-confirmed mining test path; wire the wallet UI to the existing API only after confirming its expected request/response contract.

## Acceptance test for the repaired MVP
Using a disposable test account and a single test track:
1. Authenticate and fetch wallet balances.
2. Upload through Local Agent and capture the returned local file reference.
3. Create exactly one SharePlace record.
4. Sync exactly one `tl_files` record with the authenticated creator as owner.
5. Release exactly one TL3 asset.
6. Confirm the track appears in SharePlace and resolves to the correct TL3 release.
7. Add a known test amount to the per-track balance.
8. Play for a measured five-second interval.
9. Confirm the buyer's total wallet debit is exactly the agreed price once, the per-track balance decreases once, and creator credit is exactly the configured share.
10. Confirm the TLC mining endpoint reports its actual result and the wallet UI displays the server's resulting balance.

Do not run these tests against a real paid account or production balance until the accounting path is corrected.
