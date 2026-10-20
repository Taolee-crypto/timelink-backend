# V5 MP3 Compatibility Layer

Status: design baseline for a separate B2B integration track. This does not replace or modify TL3 V5 sealed-container playback.

## Product boundary

V5 MP3 Compatibility lets an existing music service keep its original MP3 bytes and existing decoder while adding TimeLink rights authentication, playback authorization, usage metering, and settlement/reporting.

- The registered MP3 is immutable: TimeLink stores its SHA-256 fingerprint and metadata; it does not transcode, rewrite tags, or re-encode the source.
- A partner integrates a V5 SDK/API into a player it controls, or uses the official V5 Player where it cannot patch its existing player.
- Existing TL3 V5 remains the protected encrypted-container product. Do not route ordinary MP3 assets through TL3 manufacture or change the current TL3 player.
- An unencrypted MP3 that remains directly accessible can still be copied and played outside the integrated player. This product provides auditable rights and usage accounting, not unbreakable DRM.

## Integration flow

1. Partner registers an MP3 asset and supplies its source SHA-256, duration, metadata, rightsholder references, territories, permitted uses, and effective dates.
2. TimeLink issues an immutable asset identifier and a signed rights-manifest version.
3. The integrated player authenticates its service/member and player instance.
4. Before playback, the player resolves the asset and obtains a short-lived playback authorization scoped to asset, service, member, player, territory, and permitted use.
5. The existing MP3 decoder plays the unchanged source. The SDK measures audible playback time; pause, buffering, seek, backgrounding, and end-of-track behavior must be explicitly represented.
6. Usage events are submitted online or queued as signed offline events for later reconciliation. Server-side deduplication uses event IDs and session IDs.
7. TimeLink produces partner and rightsholder usage reports and settlement exports.

## Initial API contract (proposed; not yet mounted)

- `POST /api/v1/v5-mp3/assets`: register an immutable MP3 fingerprint and rights manifest.
- `GET /api/v1/v5-mp3/assets/:asset_id`: resolve the current manifest and status.
- `POST /api/v1/v5-mp3/authorize`: issue a short-lived playback authorization.
- `POST /api/v1/v5-mp3/sessions`: open an auditable playback session.
- `POST /api/v1/v5-mp3/events`: ingest idempotent audible-time events.
- `POST /api/v1/v5-mp3/sessions/:session_id/close`: close and reconcile a session.
- `GET /api/v1/v5-mp3/reports/usage`: partner-scoped usage report/export.

All routes must be partner-scoped. A client-supplied rightsholder, duration, territory, or usage total is untrusted until validated against the registered manifest and server-side policy.

## Rights manifest v1

Required fields:
- `asset_id`: server-issued stable identifier.
- `source_sha256`: SHA-256 of the exact original MP3 bytes.
- `duration_ms`: server-verified duration; client duration is advisory only.
- `partner_id`: authenticated integration owner.
- `rightsholders[]`: stable rightsholder identifiers and share basis points; total allocation must be validated.
- `rights_scope`: allowed use types, territories, start/end timestamps, and any explicit restrictions.
- `metadata`: title, artist, album, ISRC when available.
- `manifest_version`, `issued_at`, `status`.

Manifest updates create a new version; they must not silently rewrite historical playback attribution.

## Usage and settlement invariants

- Meter only audible playback, not download time, buffering, or paused time.
- Events are append-only and idempotent. Replayed event IDs must not be paid twice.
- A seek must not create duplicate billable time. The event model needs monotonic played intervals or equivalent server-verifiable accounting.
- Offline events are provisional until signature, entitlement window, sequence, and duplicate checks pass.
- Reports distinguish measured usage, accepted usage, disputed usage, and settled usage.
- Partner reporting and rightsholder allocation must be reproducible from immutable events and the manifest version active for each session.
- Do not connect this module to the existing TL3 track charging or creator-reward code until the partner settlement rules are explicitly mapped. In particular, do not double-charge the existing 1 TL/second TL3 meter.

## Security and trust boundaries

- Partner credentials are server-side secrets; never embed them in public player JavaScript.
- Player identity uses a registered public key and proof of possession. Reuse the existing V5 P-256/ECDH identity pattern where appropriate, but define a separate audience and authorization scope for MP3 compatibility.
- Playback authorization is short-lived and bound to partner, asset, session, player key, and permitted use.
- Signed events include event ID, session ID, sequence number, played interval, client monotonic counter, and manifest version.
- Server timestamps and server-side policy decide acceptance; client clocks and client-reported totals are not authoritative.
- Revocation must stop new authorizations. Already accepted usage remains in the audit ledger.

## Rollout sequence

1. Freeze this contract and define partner authentication/tenant isolation.
2. Add additive D1 tables for partners, MP3 assets, manifest versions, player keys, playback sessions, and usage events.
3. Implement asset registration and server-side MP3 fingerprint/duration verification.
4. Implement authorize/session endpoints without touching TL3 routes.
5. Implement the browser SDK against an existing HTML audio element, then a reference player adapter.
6. Add idempotent event ingestion, reconciliation, and CSV/JSON usage reports.
7. Pilot with one partner using a controlled MP3 catalogue; validate reporting before financial settlement.

## Explicit non-goals for v1

- Re-encoding, retagging, or changing original MP3 bytes.
- Replacing the partner's MP3 decoder.
- Claiming that an unencrypted MP3 cannot be copied or played outside the integrated player.
- Modifying TL3 V5 container encryption, TL3 playback, or existing TL economics.
- Treating client-generated play counts as verified usage.
