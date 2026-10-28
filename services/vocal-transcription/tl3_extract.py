"""Private TL3-V5 audio extraction for authorized background transcription only.

Inputs must come from the internal release ledger, never from a public request.
Never log master secrets, decrypted audio, or derived keys.
"""
import base64
import hashlib
import json
import struct
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def recover_mp3(container: bytes, *, file_id: int, share_id: str,
                wrapped_content_key: str, master_secret: str,
                expected_source_sha256: str, expected_container_sha256: str) -> bytes:
    if not isinstance(file_id, int) or file_id <= 0 or not share_id:
        raise ValueError("Invalid release identity")
    if not master_secret or len(master_secret) < 24:
        raise ValueError("Missing V5 master secret")
    if hashlib.sha256(container).hexdigest() != expected_container_sha256.lower():
        raise ValueError("TL3 container integrity mismatch")
    if len(container) < 9 or container[:5] != b"TLNK\\x05":
        raise ValueError("Not a TL3-V5 container")
    header_len = struct.unpack(">I", container[5:9])[0]
    if header_len < 1 or header_len > 4096 or len(container) < 9 + header_len + 16:
        raise ValueError("Invalid TL3 bootstrap length")
    header_end = 9 + header_len
    bootstrap = json.loads(container[9:header_end])
    if bootstrap.get("profile") != "TL3-V5" or bootstrap.get("algorithm") != "AES-256-GCM":
        raise ValueError("Unsupported TL3 profile")
    envelope = _b64url(wrapped_content_key)
    if len(envelope) != 60:
        raise ValueError("Invalid wrapped key")
    aad = ("timelink:tl3:v5:asset-key:" + str(file_id) + ":" + share_id).encode()
    master_key = hashlib.sha256(master_secret.encode()).digest()
    content_key = AESGCM(master_key).decrypt(envelope[:12], envelope[12:], aad)
    if len(content_key) != 32:
        raise ValueError("Invalid content key")
    nonce = _b64url(bootstrap["nonce"])
    if len(nonce) != 12 or bootstrap.get("ciphertext_bytes") != len(container) - header_end:
        raise ValueError("Invalid encrypted payload")
    plain = AESGCM(content_key).decrypt(nonce, container[header_end:], container[:header_end])
    if len(plain) < 4:
        raise ValueError("Invalid V5 plaintext")
    manifest_len = struct.unpack(">I", plain[:4])[0]
    if manifest_len > 65536 or 4 + manifest_len >= len(plain):
        raise ValueError("Invalid V5 manifest")
    manifest = json.loads(plain[4:4 + manifest_len])
    if manifest.get("source_sha256") != expected_source_sha256.lower():
        raise ValueError("V5 manifest source mismatch")
    mp3 = plain[4 + manifest_len:]
    if hashlib.sha256(mp3).hexdigest() != expected_source_sha256.lower():
        raise ValueError("V5 MP3 source integrity mismatch")
    return mp3
