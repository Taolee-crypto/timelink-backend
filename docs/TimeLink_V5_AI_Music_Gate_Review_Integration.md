# TimeLink V5 AI Music Gate — review integration contract

## Current state
- MP3 intake writes a pending_analysis record in v5_music_gate_reviews when the schema is installed.
- Two legacy TL3 release routes require a matching approved source_key for the authenticated user.
- Real AI inference, review UI, and all V5 TL3 routes remain unverified.

## Admin review API requirements
- Authenticate an active administrator on the server; never trust a client role field.
- List review records with pagination and bounded response size.
- Only permit pending_analysis -> analyzing -> review_required -> approved/rejected.
- Record model/version, immutable evidence digest, timestamps, reviewer ID and reason.
- Approve only after audio decoding, music classification, content review and rights-path checks are complete.
- Confirm source SHA-256 at review time and bind the approval to the exact uploaded source.
- Use a conditional update to prevent concurrent or repeated decisions.
- Write an append-only audit event for every decision and reversal.
- Keep rights-holder verification, TL3 publication, and TL payout as separate decisions.
- Reports alone never create negative PoC or strikes.
- Add appeal and revocation workflow before activating automated decisions.

## Deployment safety
Do not deploy the fail-closed upload and release changes until the D1 migration,
analysis worker, review API, and admin UI are operational. Verify existing release
routes, V5 router paths and regression tests first.
