# TL3 Spine v4 Converter

## Status
The v4 converter core is additive. It does not replace or rewrite existing TLNK v3 releases.

## Security profile
- Container magic: TLNK; version byte: 4.
- Profile: TL3-SPINE-1.
- AES-256-GCM with per-segment key derivation through HKDF-SHA-256.
- Each segment's authenticated additional data binds the file id, share id, segment index, time interval, prior spine token, and rights digest.
- The spine link binds the previous token, file identity, segment index, time interval, rights digest, and ciphertext hash.
- The public header contains the spine root and final commitment, but not the license key or intermediate token chain.
- The full token chain is returned separately for server-side persistence and must never be sent in the public header.

## Segment contract
Input segments must:
1. Start at byte offset zero.
2. Be contiguous with no gaps or overlaps.
3. Cover the complete source byte array.
4. Have positive duration no greater than 1000.5 ms (frame-boundary rounding allowance).

MP3 frame boundaries do not generally coincide with exact one-second boundaries. The frame parser must group complete frames into intervals no longer than one second, include leading ID3 metadata in the first segment, and include trailing tag bytes in the final segment. If the input cannot satisfy the contract, conversion must fail closed rather than silently dropping bytes.

## Creator integration sequence
1. Creator submits the original source and rights confirmation through the existing local-agent / files-sync path.
2. Backend derives a stable release identity and calls buildTL3SpineV4.
3. Backend persists the v4 binary, header metadata, and full spine chain in server-only storage.
4. Server validates every requested segment and playback entitlement before issuing ciphertext.
5. Creator reports conversion and integrity status only after the backend confirms successful persistence.
6. Playback support for v4 must be deployed before Creator switches public releases from v3 to v4.

## Compatibility
- Existing v3 assets and player behavior remain unchanged.
- Do not overwrite a v3 release in place.
- Do not advertise a v4 asset as playable until the v4 header, segment, license, and billing endpoints and player decryption path are deployed.
- The creator's source MP3 remains unchanged; the converter produces a separate TLNK container.

## Threat-model boundary
This design makes direct container-to-MP3 conversion fail without authorized decryption keys and a valid sequential spine. It cannot prevent analog capture or recording of audio after an authorized player has decrypted it.
