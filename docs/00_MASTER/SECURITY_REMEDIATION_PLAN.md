# TimeLink Backend Security Remediation Plan

Date: 2026-10-14
Scope: read-only audit of `feature/renewal-private-library-api` source. No production request, deployment, D1 mutation, or live credential test was performed.

## Executive decision

**Do not merge or deploy the renewal backend PR until the P0 access-control findings below are resolved and regression-tested.** The renewal API additions are not the only concern: several legacy endpoints in the same Worker expose raw objects or accept unauthenticated writes.

## Findings

### P0 — Raw D1 object reads are public

- `GET /api/storage/:key{.+}` returns a completed D1 object by key without authentication or an authorization decision.
- The response sets `Cache-Control: public`.
- The key is therefore acting as a bearer secret, but keys are predictable in several upload paths (for example `tracks/<trackId>.<ext>`) and are returned by upload APIs.
- This is inconsistent with the product rule that source MP3/MP4/PDF/JPEG/PNG originals remain private and must not be exposed through raw URLs.

**Required fix:** split private source-object storage from protected TL container delivery. Require owner authorization for source objects. For listener playback, use a separate entitlement-checked route that validates the share/release state and applicable TL/time authorization before streaming. Do not solve this by blindly making every object public or by blindly blocking all existing playback.

### P0 — Chunked upload endpoints are unauthenticated and not owner-bound

- `POST /api/upload/init`, `PUT /api/upload/part`, and `POST /api/upload/complete` do not authenticate the caller.
- `src/d1-storage.ts` stores object metadata and chunks by caller-supplied object key; it does not bind an upload session to a user.
- A caller can potentially initialize/overwrite or complete another object's key when it is known or guessed.

**Required fix:** authenticate every operation; create server-generated upload-session IDs; persist owner ID, expiry, expected size, allowed content type and status; bind every chunk/finalize operation to both session ID and authenticated owner; reject path/key reuse across owners; validate contiguous parts and size/hash before completion.

### P0 — Generic multipart upload endpoint is unauthenticated

- `POST /api/upload` accepts a file and caller-supplied `trackId` without checking a session or owner.
- It writes to the shared D1 object namespace.

**Required fix:** same owner-bound upload session model as above. Validate content signatures server-side and ensure the resulting object is attached only to a share owned by the authenticated user.

### P0 — Legacy file sync trusts caller-supplied identity

- `POST /api/files/sync` is unauthenticated.
- It accepts `user_email` and `username`, creates/updates file rows under that identity, and defaults to user ID 1 when no valid email is supplied.

**Required fix:** authenticate and derive user ID exclusively from the verified token. Remove the user-creation fallback and never accept ownership identity from the request body.

### P0 — External storage stream can bypass share visibility

- `GET /api/storage/object/:id/stream` checks whether an object is linked to any `tl_shares` row; if so, it does not require the requester to own the object or satisfy a listener entitlement.
- It then streams the linked original from Google Drive or OneDrive.

**Required fix:** owner access for private library previews; listener access only through a separate release-entitlement check. A database link to a share is not itself an authorization grant.

### P1 — Admin approval route checks authentication but not administrator role

- `src/routes/files.ts` applies `authMiddleware` to all routes, but `POST /:id/approve` does not check `users.role = 'admin'`.
- The handler changes `auth_status` and grants POC to the file owner.

**Required fix:** explicit server-side role check before any approval mutation; log reviewer identity, decision, reason and timestamp. POC changes must be ledgered and idempotent.

### P1 — Authenticated file detail route is not owner-scoped

- `GET /api/v1/files/:id` returns `SELECT *` for any authenticated user, including fields such as file URLs and internal state.

**Required fix:** owner-only private detail endpoint; public metadata endpoint with an explicit allowlist; never serialize the full row.

### P1 — SharePlace list returns raw stream URLs and assumes modern shares are public

- `GET /api/shares` maps all `tl_shares` rows into the public listing and returns their full row data, including `stream_url`.
- The mapping also assigns `shared: 1` and `auth_status: 'verified'` in the response regardless of an independently verified release/visibility decision.

**Required fix:** add explicit publication/visibility state and query only eligible releases. Return an allowlisted public DTO with no source URL, provider object ID, private metadata or storage credentials.

### P1 — Free MP3 upload creates POC credit contrary to current product policy

- The SharePlace POST handler inserts a POC log for both release modes: `upload_mp3` grants 1 and `upload_tl3` grants 3.
- Current product direction is that free MP3 upload/listening does not create POC contribution or spend TL.

**Required fix:** remove POC credit for free MP3 upload. Keep TL3 issuance contribution only if the finalized POC rules explicitly authorize it; write any contribution event through the canonical, idempotent TL Economics ledger rather than an uncoordinated log.

### P1 — Committed Worker configuration contains a plaintext provider/API key

- The inspected `wrangler.toml` contains a credential-like `TON_API_KEY` value under `[vars]`.
- Treat the committed value as exposed: revoke/rotate it at its provider, move the replacement to Worker secrets, and remove the plaintext value from tracked configuration and repository history as appropriate.

**Required fix:** secrets belong in `wrangler secret put` / protected deployment secrets, never `[vars]`. Review other repository history and logs for the same credential.

### P2 — Track Page counters and moderation require stronger operational controls

- The renewal branch now persists likes, follows, comments, reports and playlists.
- Views intentionally remain untracked (reported as zero with `views_tracked:false`), which is preferable to fabricating counts.
- Add rate limits, spam controls, comment deletion/moderation, report review, pagination and audit events before opening these interactions broadly.

## Required acceptance tests

1. Anonymous requests to all upload init/part/complete and source-read endpoints fail closed.
2. User A cannot initialize, overwrite, append, complete, read, or stream User B's object.
3. A private source object cannot be read by a listener even if it is linked to a SharePlace row.
4. A listener can stream only an eligible published TL container after entitlement/time checks; existing authorized playback regression tests pass.
5. `/api/files/sync` cannot create or mutate another user's records and never defaults to user ID 1.
6. Non-admin approval attempts return 403 and make no database changes.
7. Authenticated non-owners cannot read private file details.
8. Public SharePlace DTOs contain no original file URL, provider download URL, OAuth token, or private metadata.
9. Free MP3 upload produces no POC event and no TL charge.
10. TL3 contribution events are idempotent under retries.
11. Credential rotation is confirmed before next production deployment.
12. Track Page likes/comments/follows/playlists pass user-isolation, duplicate and rate-limit tests.

## Implementation sequence

1. Rotate the exposed provider/API credential and inventory other tracked secrets.
2. Add owner-bound upload sessions and source-object authorization.
3. Add a separate entitlement-checked TL3 playback route; migrate clients without breaking existing playback.
4. Close identity spoofing in file sync and enforce admin role on approval.
5. Introduce public DTO allowlists and explicit release visibility.
6. Align MP3/TL3 POC events with TL Economics policy.
7. Add automated CI and staging D1 integration tests.
8. Only then mark the backend PR ready for review.

## Validation state

- GitHub Actions Worker bundle validation: **passed** using `npx wrangler deploy --dry-run`; this is a compile/bundle check only, not a deployment.
- Existing strict TypeScript workflow: **failed**. The output contains numerous errors across existing modules, including missing Env bindings/types (`R2`, `UNSPLASH_ACCESS_KEY`, `TL3_MASTER_SECRET`, `KAKAO_REST_API_KEY`), Hono request/body typing, auth typings, and nullability. These must be triaged against the base branch to separate pre-existing errors from renewal-branch regressions.
- `npm ci` reported 10 dependency vulnerabilities (1 low, 3 moderate, 6 high) at the time of this run. Do not run `npm audit fix --force` blindly; review advisories and dependency compatibility first.
- No D1 integration tests, browser tests, cross-user penetration tests or production deployment were performed.

This document is based on source inspection and CI output. It is not a penetration test and does not prove exploitability against a deployed environment. No merge or deployment is represented as complete.
