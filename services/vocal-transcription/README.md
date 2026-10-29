# V5 private vocal inference

The production Actions workflow authenticates with GitHub OIDC (RS256, fixed issuer/audience, repository ID and owner ID, production environment, main ref and exact workflow path). No TL3 master secret, keyring, content key or long-lived worker token is sent to Actions. Existing Worker secrets are preserved and checked by name before and after deployment.

The creator-authorized queue binds each running job to the verified Actions run ID and attempt. Only that identity can fetch the verified source audio or complete/fail the job. Cloudflare selects the release's stored key ID (including legacy), verifies container and source SHA-256 and AES-GCM authentication, then returns job-scoped audio over HTTPS with private/no-store headers. No replacement keys are generated.

Demucs htdemucs separates vocals; Basic Pitch generates a monophonic melody draft. Stable-ts/Whisper small force-aligns creator-supplied lyrics to the separated vocal. Section labels and LRC timestamps are removed. Word timings and lyrics on overlapping notes are stored only as an owner-visible draft. The API rejects a changed lyric source, invalid timestamps or mismatched source audio. No TL debit or TLD publication occurs. Human musical review is still required.

The runner refreshes its short-lived OIDC token for every API call. Temporary audio and lyric files are removed on exit. Never upload source audio, lyrics, credentials or model stdout as workflow artifacts. Production runs are triggered by successful deployment, manual dispatch or the existing 15-minute schedule.

Validation: `node scripts/test-v5-score-identity.cjs`, `node scripts/test-v5-score-audio.cjs`, and the Python unittest suites. Unit fixtures do not establish real track quality. Record actual job, deployment and draft evidence separately.
