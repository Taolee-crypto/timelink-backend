# TimeLink V3 Master Architecture
**Status:** Architecture baseline — implementation source of truth  
**Version:** 1.0.0  
**Date:** 2026-10-14  
**Repositories:** `Taolee-crypto/timelink-frontend`, `Taolee-crypto/timelink-backend`

## 1. Mission and product boundary

TimeLink is a creator-rights and time-authorized digital-content platform. Music is the first complete product vertical. The platform is not an AI music-generation service. The architecture must support later TL4 video and TLD document products without making the first music release unnecessarily complex.

The platform has four user-facing workspaces:
- **SharePlace:** discovery and distribution surface for music and creators.
- **Track:** the canonical page for one musical work; includes identity, presentation, rights, social activity, and creator promotion.
- **Creator Studio:** creator-owned catalog, metadata review, rights, releases, performance, and revenue management.
- **TL Broadcasting Station:** scheduled/programmed broadcasting experience; this replaces the old “cafe broadcast” concept.

The initial authenticated experience is preceded by a branded login/sign-up screen. A user may be both a listener and a creator; these are capabilities of one identity, not separate account types.

## 2. Non-negotiable product and economic decisions

1. **MP3 is a creator source-file format, not a free TimeLink product or public release.** The creator must deliberately choose the file and storage path; TimeLink must not silently transfer files. R2 is optional, not mandatory. Approved destinations may include the creator's Local Agent, Google Drive, OneDrive, or another reviewed storage adapter. D1 stores metadata and object references, never audio bytes.
2. Track creation may extract descriptive metadata from a creator-selected MP3 source Asset. It is not a separate free MP3 registration product. Existing browser-side ID3 extraction in `public/creator.html` is the known baseline. It reads title, artist, album, and embedded cover. It is not evidence of external music-database matching or acoustic fingerprint identification.
3. Preserve the distinction between `original_filename`, extracted metadata, and creator-confirmed canonical metadata. A filename fallback must never be misrepresented as an ID3 extraction result.
4. **MP3 and TL3 have different technical roles, not two product tiers.** MP3 is a creator source Asset and is not independently published or sold as a free product. TL3 is the encrypted, time-authorized commercial Release. A Track may exist with an MP3 source Asset but no Release. MP3 metadata intake and source upload create no POC contribution. POC eligibility begins only after successful conversion into a TL3 container; the resulting event remains subject to validation and deduplication.
5. **TL3 is the separately prepared, encrypted, time-authorized paid release format.** A creator must explicitly start the release workflow. Source selection, TL3 creation, storage destination, release price, and publication are separate steps.
6. The original Track identity persists when a TL3 release is added. Track, Asset, and Release are distinct domain concepts.
7. The creator sets the TL3 price. Listening is charged against actual verified listening time, not button presses, elapsed wall-clock time, or a fixed five-second timer.
8. **TL is the internal accounting unit. Current policy: 1 second = 1 TL = ₩1.** TL balance, charge, consumption, refunds, creator proceeds, and platform fees are ledgered. Do not revive the obsolete ₩5-per-TL draft.
9. TL accounting, POC contribution measurement, and TLC issuance/mining are separate accounting domains. A completed MP3-to-TL3 conversion is the earliest eligible POC source event. It is recorded as pending evidence and contributes only after the active validation policy accepts it. MP3 metadata intake or source-file upload alone never creates POC, TL, bonus TL, or TLC.
10. POC rewards only validated contribution events under a versioned scoring policy. TLC is a separate TON Jetton-related reward/issuance system; do not couple token issuance to unverified UI events.
11. Existing user data and functionality must be preserved. V3 migrations are additive and reversible where practical. No destructive table reset or blanket rewrite.
12. No production deployment, PR merge, destructive migration, or secret rotation is implied by architecture approval. These remain separately controlled operations.

## 3. System context and deployment topology

### 3.1 Logical layers

| Layer | Responsibility | Primary components |
|---|---|---|
| Experience | User-facing pages and workflows | Login, SharePlace, Track, Creator Studio, TL Broadcasting Station |
| Identity | Account, authentication, session, profile, role/capability checks | Hono auth/users routes, token/session services |
| Music domain | Track identity, metadata, rights, assets, releases | Track and release services |
| Social | Likes, comments, follows, playlists, sharing, reports | Social services and D1 records |
| Playback | TL3 licensing, playback sessions, segment authorization, event validation | TL3 player/API, Local Agent or approved storage provider |
| Economy | TL ledger, creator revenue, POC, TLC | Separate services and append-only records |
| Infrastructure | API, relational persistence, object storage adapters, external providers | Cloudflare Workers, D1, creator-side Local Agent, approved external storage, TON |

### 3.2 Physical topology

- **Frontend:** existing GitHub Pages/Gabia delivery, using the existing frontend repository and domain configuration.
- **Backend:** Cloudflare Workers API at `api.timelink.digital`, using Hono and D1.
- **Database:** Cloudflare D1. Migrations are numbered, additive, checked into the backend repository, and applied only after backup and validation.
- **File access:** storage-provider abstraction. Do not make Cloudflare R2 a mandatory dependency. Existing creator-controlled storage and Local Agent integrations must be assessed and reused where safe. Store provider/object references and capabilities, not assumptions that every file is in one bucket.
- **Creator source:** the creator selects whether to keep an MP3 local or upload it to an approved storage destination for free streaming. The browser may read it locally for metadata extraction and an explicitly initiated TL3 preparation workflow.
- **External token system:** TON/TLC integration is isolated from core TL balances and playback authorization.

### 3.3 Trust boundaries

1. Browser/client is untrusted. All ownership, price, balance, release status, rights, and playback entitlement decisions are revalidated by the API.
2. Local Agent is a creator-controlled storage/processing bridge, not a trusted authority for account identity or payment settlement.
3. Storage providers are external trust boundaries. Credentials are scoped, encrypted, revocable, and never exposed to browser JavaScript or committed to Git.
4. TON is an external settlement/token network. Chain events require confirmation and idempotent reconciliation before internal state changes.

## 4. Domain model

### 4.1 Core identity

- `users`: canonical account identity.
- `creator_profiles`: optional creator-facing profile linked one-to-one or one-to-many as product rules require; never duplicate login credentials.
- User capabilities: listener, creator, broadcaster, moderator, administrator. Authorization is policy-based and checked server-side.

### 4.2 Track, Asset, Release

**Track** is the permanent identity of a musical work inside TimeLink. It survives metadata corrections, file replacement, artwork changes, and later release formats.

**TrackMetadata** is versioned descriptive data:
- `original_filename`: exact name of the selected local source file.
- `extracted_title`, `extracted_artist`, `extracted_album`: values read from embedded metadata, nullable.
- `fallback_title`: filename-derived suggestion, nullable and explicitly marked as fallback.
- `verified_title`, `verified_artist`, `verified_album`: creator-confirmed values.
- `display_title`: derived/presented title; not a replacement for provenance fields.
- `metadata_source`: e.g. `id3`, `filename_fallback`, `manual`.
- `metadata_status`: `pending_review`, `confirmed`, `needs_attention`.
- `metadata_payload`: allowlisted extracted tags only; do not persist arbitrary unbounded client payloads.
- `confirmed_by`, `confirmed_at`, `version`.

**TrackAsset** describes a file or resource associated with a Track, without assuming that the source is hosted by TimeLink:
- `asset_type`: `creator_source_reference`, `cover_art`, `tl3_release_file`, `lyrics`, `sheet_music`, `other`.
- `storage_provider`, `storage_object_id`, `storage_uri_ref`: nullable provider references. Never store provider secrets or public credentials here.
- `source_location`: local-only transient browser information; do not persist an unusable local filesystem path as a server download URL.
- `content_hash`, `size_bytes`, `mime_type`, `created_at`, `availability_status`.
- MP3 audio is stored only through an explicitly selected storage adapter. The asset row stores a provider/object reference, content hash, MIME type, size, and availability state; it never stores audio bytes or provider credentials. A local-only registration without an uploaded/available asset is not publicly streamable.

**TrackRelease** represents a distributable product with explicit rights and commercial conditions:
- `release_type`: initially `TL3`; future values may include `TL4` and `TLD`.
- `status`: `draft`, `preparing`, `ready_for_review`, `published`, `suspended`, `withdrawn`.
- `price_tl`, `duration_seconds`, `published_at`, `rights_snapshot_id`, `asset_id`, `format_version`.
- A Track can exist without any release. A Track can have multiple release versions; only one active release per applicable distribution scope unless product policy explicitly allows more.

### 4.3 Rights and provenance

- `track_rights` records claimant/owner, role, territory, term, evidence reference, and verification state.
- Creator attestation is recorded with timestamp, account, terms version, and request metadata.
- Registration is not proof of legal ownership. Disputes and takedown states must be representable.
- Published releases carry a rights snapshot so later metadata/rights edits do not silently rewrite the terms under which an earlier release was sold.
- Existing released-song detection may use external catalog/API integrations in a later verification service. Do not claim such matching exists until implemented and tested.

### 4.4 Social and discovery

- `shareplace_entries`: placement/discovery record, visibility, category, ranking eligibility, and link to Track/creator.
- `track_likes`: unique (user, track).
- `track_comments`: comments attached to Track; support edit/delete policy, moderation, and soft deletion.
- `user_follows`: unique (follower, following), prevent self-follow.
- `playlists` and `playlist_tracks`: ordered Track membership; do not store a denormalized JSON array as the canonical relation.
- `track_shares` or share events: attribution and share link lifecycle.
- `content_reports`: user reports with status, reason, evidence reference, and moderation audit.
- Social actions must be authenticated, rate-limited, ownership-safe, and idempotent where possible.

### 4.5 Playback and accounting

- `playback_sessions`: server-issued session ID, user, release, license, device/session binding, start/expiry, state, and policy version.
- `playback_events`: sequence-numbered event log with event type, server receipt time, client playback position, segment reference, and validation outcome.
- `tl_ledger`: append-only balance movements with unique idempotency key, account, direction, amount, reason, related session/order, and timestamp. Balance is derived or maintained transactionally from ledger entries.
- `creator_revenue_ledger`: creator payable entries, reversals, fees, and payout state; never infer creator income directly from a client play counter.
- `poc_events`: validated contribution event, evidence reference, score-policy version, validation status, and deduplication key.
- `tlc_mining_records`: token issuance proposal/record, source POC batch, chain transaction, confirmation state, and reconciliation status.

## 5. MP3 registration and free-publication workflow

1. Creator selects an MP3 in the browser.
2. Browser reads ID3 tags locally using the existing `jsmediatags` integration where available.
3. Browser computes a content hash for duplicate detection and integrity checks.
4. Browser sends an allowlisted metadata payload to the API. Audio bytes are transferred only in a separate, explicit upload action to the creator-selected approved storage adapter; never to D1 and never implicitly to Workers storage.
5. API validates authentication, metadata bounds, MIME/size, ownership, rights attestation, duplicate state, storage object reference, and idempotency. It creates a draft Track and versioned metadata record.
6. The creator reviews title, artist, album, artwork, credits, and rights, then explicitly publishes the free MP3 to SharePlace when its audio asset is available.
7. Public MP3 playback is free and does not invoke TL deduction. Playback and access logs may be used for abuse prevention and validated POC evidence, but must not create TL or TLC awards.
8. If extraction or upload fails, keep the Track draft and expose a retry/manual metadata path; never claim the MP3 is playable until storage availability is verified.

Duplicate detection is advisory, not title-only. Use hash, creator, artist/title/album, and available external identifiers with confidence levels. Do not automatically merge Tracks solely because titles match.

## 6. TL3 release preparation and playback

### 6.1 Release preparation

1. Creator explicitly chooses “Prepare TL3 release” on a registered Track.
2. Browser verifies the selected local source file and computes/validates its fingerprint against the Track's registered source metadata where available.
3. TL3 preparation runs in the approved client/Local Agent processing path. The source MP3 is read only because the creator initiated release preparation; this is not MP3 registration.
4. Encrypted TL3 output is written to a configured creator-controlled or approved storage provider through a storage adapter. The API records object metadata and references, not provider secrets.
5. Creator sets price, reviews rights/credits, confirms duration and preview/cover, then submits for publication.
6. API validates ownership, release asset, storage availability, rights state, price bounds, and format compatibility before publishing.

### 6.2 Playback authorization

1. Client requests a playback session for a published TL3 release.
2. API checks identity, release state, price, available TL balance, account restrictions, and any active entitlement.
3. API issues a short-lived signed playback license bound to user, release, session, and expiry.
4. Segment requests are authorized against the session and sequence. Replays, skipped sequence, expired tokens, and cross-session token reuse are rejected or handled by explicit recovery rules.
5. The player reports playback progress/events. The server validates monotonic sequence and plausible playback position; client claims alone are not sufficient to settle money.
6. Settlement is idempotent and based on validated listening duration. Repeated event delivery cannot double-charge.
7. On pause, stop, disconnect, expiry, or completion, the session is reconciled and closed. Unused reservations are released/refunded according to the ledger policy.
8. Creator revenue is credited through a separate ledger entry with explicit fee/tax/hold rules.

The existing five-second polling/advance timer is legacy behavior, not the V3 billing specification. V3 must test pause/resume, tab close, network loss, duplicate events, clock manipulation, seek, segment replay, and concurrent sessions.

## 7. TL and TLC economic boundaries

### TL ledger
- Unit policy: 1 TL per verified second, with 1 TL valued at ₩1 under the current internal policy.
- All mutations are server-side, transactional, append-only, and idempotent.
- Charge/recharge, consumption, refund, creator revenue, platform fee, and adjustment are distinct ledger reasons.
- Client balance displays are read models; never trust a client-supplied balance.
- A session must not spend beyond its authorized limit. Reservation/settlement semantics must be explicit and atomic.

### POC and TLC
- POC is a contribution measurement and validation mechanism, not a currency balance.
- A qualifying accepted free-MP3 metadata registration may contribute to POC only under a versioned validation policy; it never grants TL, TL bonuses, or TLC directly. Duplicate, unverified, or rejected registrations do not count.
- POC policy is versioned; source events are deduplicated and auditable.
- TLC issuance is a separate process, gated by validated POC batches and token policy.
- TON transaction submission, confirmation, failure, and reconciliation are separate states.
- No automatic token minting in a request path that handles ordinary Track registration or playback.

## 8. API boundaries (V3 namespace)

All V3 routes are under `/api/v3`. Existing endpoints remain operational during migration. The route list below is the target contract; implementation must be staged and tested rather than mounted as empty placeholder endpoints.

### Identity
- `POST /api/v3/auth/register`
- `POST /api/v3/auth/login`
- `POST /api/v3/auth/logout`
- `GET /api/v3/me`
- `PATCH /api/v3/me/profile`

### Track registration and metadata
- `POST /api/v3/tracks/registrations` — metadata-only registration; must reject/avoid audio-byte upload.
- `GET /api/v3/tracks/registrations/:registrationId`
- `PATCH /api/v3/tracks/registrations/:registrationId`
- `POST /api/v3/tracks/registrations/:registrationId/confirm`
- `GET /api/v3/tracks`
- `POST /api/v3/tracks`
- `GET /api/v3/tracks/:trackId`
- `PATCH /api/v3/tracks/:trackId`
- `GET /api/v3/tracks/:trackId/rights`
- `PUT /api/v3/tracks/:trackId/rights`

### Releases and storage
- `POST /api/v3/tracks/:trackId/releases`
- `GET /api/v3/tracks/:trackId/releases`
- `GET /api/v3/releases/:releaseId`
- `POST /api/v3/releases/:releaseId/prepare`
- `POST /api/v3/releases/:releaseId/publish`
- `POST /api/v3/storage/connections`
- `POST /api/v3/storage/connections/:connectionId/verify`

### Social and discovery
- `GET /api/v3/shareplace`
- `POST /api/v3/tracks/:trackId/likes`, `DELETE /api/v3/tracks/:trackId/likes`
- `GET /api/v3/tracks/:trackId/comments`, `POST /api/v3/tracks/:trackId/comments`
- `POST /api/v3/users/:userId/follow`, `DELETE /api/v3/users/:userId/follow`
- `GET /api/v3/playlists`, `POST /api/v3/playlists`, `PATCH /api/v3/playlists/:playlistId`
- `POST /api/v3/reports`

### Playback and economy
- `POST /api/v3/playback/sessions`
- `POST /api/v3/playback/sessions/:sessionId/events`
- `POST /api/v3/playback/sessions/:sessionId/settle`
- `GET /api/v3/wallet/tl`
- `GET /api/v3/wallet/tl/ledger`
- `GET /api/v3/creator/revenue`
- `GET /api/v3/creator/analytics`
- `GET /api/v3/poc/summary`

Every route must define request/response schemas, auth requirement, ownership policy, rate limit, idempotency behavior, and error contract before implementation. Never accept userId/ownerId from the request body as proof of identity.

## 9. Security baseline

- Passwords are salted and hashed using a maintained password-hashing implementation; never log passwords or tokens.
- Access tokens are short-lived; refresh/session revocation and device/session inventory are supported.
- Secrets live only in platform secret storage or local environment files excluded from Git. Rotate any credential that was ever committed or exposed; do not repeat it in logs or documentation.
- Validate every input with strict schemas and size limits. Sanitize rendered user content and protect against XSS, CSRF where cookie auth applies, SQL injection, IDOR, replay, brute force, and abuse.
- Enforce ownership and role authorization on every read/write route.
- Apply CORS allowlists, secure headers, rate limits, audit logging, and structured error responses.
- Use TLS for all external traffic. Do not permit production clients to stream from localhost or mixed-content HTTP endpoints.
- Cryptographic container/segment design must be versioned, use authenticated encryption and key separation, and undergo independent review. XOR alone is not an acceptable security boundary.
- Do not claim quantum resistance unless the deployed algorithms and key lifecycle have been formally specified and reviewed.

## 10. Data migration and compatibility

1. Keep existing tables and routes in place while V3 tables/services are introduced.
2. Map legacy `tl_shares` records to candidate Tracks and metadata; do not assume every share is a Track or merge automatically.
3. Map `tl3_releases` to V3 Releases only after validating asset, rights, duration, and storage references.
4. Preserve `social_comments`, `user_likes`, `user_follows`, and playlists through explicit mapping and uniqueness checks.
5. Existing `play_events` with NULL `track_id` are not valid Track-level historical analytics. Do not fabricate Track associations.
6. Existing `play_logs` and legacy pulse counters are not assumed to be verified listening or settlement evidence.
7. Use shadow reads/reconciliation reports before switching any user-facing route to V3 data.
8. Migrations must include backup instructions, preflight checks, row counts, rollback notes, and post-migration integrity queries.
9. No migration drops or truncates legacy tables in the initial V3 rollout.

## 11. Observability and quality gates

- Structured logs include request ID, route, outcome, and safe entity identifiers; exclude credentials, tokens, raw personal data, and source audio.
- Metrics cover API latency/error rate, metadata registration success, release preparation failures, storage availability, playback session integrity, TL settlement reconciliation, and POC/TLC processing.
- Automated tests: unit, API integration, D1 migration, authorization/IDOR, idempotency, browser workflow, and end-to-end playback.
- Mandatory release gates: TypeScript/build passes; migrations tested against a disposable D1 database; no secrets in diff; regression checks for legacy routes; security checks pass; PR diff reviewed.
- Production deployment requires explicit approval after PR review and a documented rollback plan.

## 12. Delivery plan and acceptance criteria

### Stage 0 — Architecture and contracts
- This document is the architecture baseline.
- Produce an ERD, migration plan, route schemas, and decision log.
- Acceptance: all domain invariants in sections 2–7 are represented and contradictory legacy assumptions are explicitly excluded.

### Stage 1 — Foundation
- Establish V3 route/module conventions, shared validation/error/auth middleware, migration runner conventions, and frontend application shell.
- Acceptance: authenticated identity/profile workflow works end-to-end; legacy login paths remain intact until cutover approval.

### Stage 2 — Music catalog
- Implement metadata-only MP3 registration, creator confirmation, stable Track identity, rights, artwork, Creator Studio catalog, and SharePlace discovery.
- Acceptance: network inspection proves no MP3 bytes leave the creator's browser during registration; metadata provenance survives edits; Track/social interactions work.

### Stage 3 — TL3 release
- Implement explicit source selection, TL3 preparation, storage adapter, release review/publication, and encrypted asset retrieval.
- Acceptance: original MP3 is not uploaded during registration; TL3 release can be prepared only through explicit creator action; stored release can be retrieved and verified.

### Stage 4 — Playback and TL settlement
- Implement session/license, ordered segment delivery, actual-listening validation, pause/resume/recovery, idempotent settlement, and creator revenue.
- Acceptance: adversarial replay/duplicate/concurrency tests pass and ledger balances reconcile.

### Stage 5 — Social, analytics, and economy
- Complete playlists, follows, moderation/reporting, analytics, POC validation, and separately gated TLC workflow.
- Acceptance: analytics only uses validated events; no registration-only POC rewards; TL/TLC accounting remains separated.

### Stage 6 — Integration and release
- Run regression, security, migration, load, and browser compatibility tests.
- Acceptance: user-reviewed PRs, release notes, backup, rollback plan, and separate production deployment approval.

## 13. Engineering workflow and change control

- Backend and frontend changes are developed on isolated feature branches and delivered through focused PRs.
- Existing open PRs are preserved; they are not merged or closed as part of this work.
- Existing local uncommitted changes and untracked files must never be overwritten, reset, cleaned, or silently committed.
- The architecture document is a living baseline. Any change to a non-negotiable decision requires a documented decision record with rationale, impact, migration, and explicit product approval where it changes user economics, rights, or source-file handling.
- Implementation order is dependency-driven: contracts and migrations first, then backend services, then connected UI, then end-to-end tests.
- Do not report a feature as complete until code exists, tests have run, and results are recorded.

## 14. Initial decision log

| ID | Decision | Rationale |
|---|---|---|
| ADR-001 | MP3 source remains on creator's computer during registration | Creator source privacy and no unnecessary platform storage |
| ADR-002 | MP3 registration is metadata-only and not playable | Distinguishes catalog registration from a paid TL3 product |
| ADR-003 | Track, Asset, and Release are separate entities | Stable work identity across source and release formats |
| ADR-004 | TL3 is the separately prepared encrypted paid release | Explicit release and rights lifecycle |
| ADR-005 | TL is 1 TL per second at ₩1 per TL | Current product accounting policy |
| ADR-006 | TL, POC, and TLC are separate accounting domains | Prevents unverified contribution/token issuance and ledger mixing |
| ADR-007 | V3 migration is additive and preserves legacy data | Protects existing service and user records |
| ADR-008 | Storage is provider-abstracted; R2 is not mandatory | Avoids single-provider dependency and supports creator-controlled infrastructure |

---
This document is the V3 architecture baseline, not evidence that any feature has already been implemented. All implementation claims must be supported by code and tests.
