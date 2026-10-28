"""Exercise exact TL3-V5 AES-GCM envelope and tamper rejection."""
import hashlib
import json
import os
import struct
import unittest

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from tl3_extract import recover_mp3


class TL3RecoveryTest(unittest.TestCase):
    def test_roundtrip_and_integrity(self):
        file_id, share_id, secret = 178, "track178", "test-secret-012345678901234567890"
        mp3 = b"ID3" + os.urandom(512)
        source_sha = hashlib.sha256(mp3).hexdigest()
        manifest = json.dumps({"source_sha256": source_sha}).encode()
        plain = struct.pack(">I", len(manifest)) + manifest + mp3
        content_key, nonce, wrap_nonce = os.urandom(32), os.urandom(12), os.urandom(12)
        aad = f"timelink:tl3:v5:asset-key:{file_id}:{share_id}".encode()
        envelope = wrap_nonce + AESGCM(hashlib.sha256(secret.encode()).digest()).encrypt(wrap_nonce, content_key, aad)
        import base64
        wrapped = base64.urlsafe_b64encode(envelope).decode().rstrip("=")
        bootstrap = json.dumps({"profile": "TL3-V5", "algorithm": "AES-256-GCM",
            "nonce": base64.urlsafe_b64encode(nonce).decode().rstrip("="),
            "ciphertext_bytes": len(plain) + 16}).encode()
        prefix = b"TLNK\\x05" + struct.pack(">I", len(bootstrap)) + bootstrap
        container = prefix + AESGCM(content_key).encrypt(nonce, plain, prefix)
        kwargs = dict(file_id=file_id, share_id=share_id, wrapped_content_key=wrapped,
            master_secret=secret, expected_source_sha256=source_sha,
            expected_container_sha256=hashlib.sha256(container).hexdigest())
        self.assertEqual(recover_mp3(container, **kwargs), mp3)
        with self.assertRaises(ValueError):
            recover_mp3(container[:-1] + b"0", **kwargs)
        with self.assertRaises(Exception):
            recover_mp3(container, **{**kwargs, "share_id": "wrong"})

if __name__ == "__main__":
    unittest.main()
