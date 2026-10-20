# TL3 V5 Master Key Ring

## Purpose

V5 content keys are wrapped by a versioned master-key ring. The encrypted TL3 container body is not rewritten during master-key rotation; only the small wrapped-content-key envelope and its key ID are updated in D1.

## Worker secrets

Configure these as Cloudflare Worker secrets/variables (never commit secret values):

- `TL3_MASTER_KEYRING`: JSON object mapping immutable key IDs to secrets. Every secret must be at least 24 characters.
- `TL3_MASTER_KEY_ACTIVE_ID`: key ID used for newly manufactured V5 containers.
- `TL3_MASTER_SECRET`: legacy compatibility secret. Existing releases without a key ID are treated as `legacy`.

Example shape (use newly generated, high-entropy values; these are placeholders):

```json
{
  "legacy": "<existing TL3_MASTER_SECRET>",
  "mk-2026-10": "<new-random-secret-at-least-24-characters>"
}
```

Set `TL3_MASTER_KEY_ACTIVE_ID=mk-2026-10` only after the key ring contains both the legacy key and the new key. Do not replace the legacy secret with the new secret.

## Safe rotation procedure

1. Back up the D1 database and confirm the current legacy secret is safely escrowed.
2. Add a new high-entropy key under a new immutable ID in `TL3_MASTER_KEYRING`; keep every key ID still referenced by a release.
3. Set `TL3_MASTER_KEY_ACTIVE_ID` to the new ID. New V5 containers will now record that ID.
4. For each existing sealed asset, an authenticated owner may call:
   `POST /api/v1/tl3/v5/key-rotate/{file_id}`
   The endpoint checks ownership, unwraps the existing content key with its recorded key ID, re-wraps it with the active key, and performs a conditional D1 update.
5. Verify the asset still resolves, obtains a session license, downloads, decrypts, and plays; compare its container hash before and after rotation. The container bytes and `container_sha256` must remain unchanged.
6. Only after every release using an old key has been rotated and verified may that old key be removed from the key ring. Keep an encrypted offline escrow copy according to the operator's recovery policy.

## Compatibility and safety

- Existing releases are migrated lazily with `key_id='legacy'`; no container is re-manufactured.
- The legacy `TL3_MASTER_SECRET` remains a fallback for old releases.
- If a release references a key ID missing from the key ring, license issuance fails closed with `V5_MASTER_KEY_MISSING`; it must not fall back to another key.
- The rotation endpoint never returns key material and never modifies the encrypted container object.
- Do not remove or overwrite an old key until all dependent releases have been verified after rotation.
- Keep secrets out of source control, logs, issue comments, and client-side code.
