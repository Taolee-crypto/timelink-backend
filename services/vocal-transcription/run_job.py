"""Private one-shot V5 vocal job runner. Invoke periodically from a secured host.

Environment: V5_SCORE_API_BASE, V5_SCORE_WORKER_TOKEN, TL3_MASTER_SECRET.
Requires requests, cryptography, Demucs, Basic Pitch, ffmpeg.
Never logs source audio, decryption keys, or bearer credentials.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import requests

from tl3_extract import recover_mp3


def main() -> int:
    base = os.environ["V5_SCORE_API_BASE"].rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Private score API must use HTTPS")
    token = os.environ["V5_SCORE_WORKER_TOKEN"]
    secret = os.environ["TL3_MASTER_SECRET"]
    if len(token) < 24 or len(secret) < 24:
        raise ValueError("Missing secure worker credentials")
    session = requests.Session()
    session.headers.update({"X-V5-Score-Worker-Token": token})
    root = base + "/api/v1/scores/v5/internal"
    response = session.post(root + "/claim", timeout=30)
    response.raise_for_status()
    job = response.json().get("job")
    if not job:
        print("No queued V5 score jobs")
        return 0
    file_id = int(job["file_id"])
    if file_id <= 0:
        raise ValueError("Invalid job ID")
    try:
        response = session.get(root + "/container/" + str(file_id), timeout=180)
        response.raise_for_status()
        container = response.content
        if len(container) != int(job["container_bytes"]) or len(container) > 20 * 1024 * 1024:
            raise ValueError("Invalid container size")
        mp3 = recover_mp3(
            container, file_id=file_id, share_id=job["share_id"],
            wrapped_content_key=job["wrapped_content_key"],
            master_secret=secret, expected_source_sha256=job["source_sha256"],
            expected_container_sha256=job["container_sha256"],
        )
        with tempfile.TemporaryDirectory(prefix="tl-vocal-job-") as tmp:
            source = Path(tmp) / "source.mp3"
            source.write_bytes(mp3)
            process = subprocess.run([
                sys.executable, str(Path(__file__).with_name("transcribe.py")),
                str(source), "--source-sha256", job["source_sha256"], "--rights-confirmed"
            ], check=True, capture_output=True, text=True, timeout=1500)
            result = json.loads(process.stdout)
        if result.get('score_data', {}).get('part') != 'lead_vocal':
            raise ValueError('Inference did not return lead vocal notes')
        response = session.post(root + "/complete/" + str(file_id), json=result, timeout=60)
        response.raise_for_status()
        if response.json().get("ok") is not True:
            raise RuntimeError("Score completion rejected")
        print("Completed V5 vocal score job", file_id)
        return 0
    except Exception as error:
        print('V5 vocal job failed:', type(error).__name__, file=sys.stderr)
        try:
            session.post(root + "/fail/" + str(file_id),
                         json={"code": "VOCAL_ANALYSIS_FAILED"}, timeout=15)
        except requests.RequestException:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
