"""Isolated CPU/GPU vocal transcription worker. Not exposed through public Worker routes.

Accepts a locally staged, rights-checked MP3 path. No remote URL fetching.
Requires Demucs and Basic Pitch to be installed in this private service environment.
"""
from __future__ import annotations

import json
import math
import subprocess
import tempfile
from pathlib import Path

import soundfile as sf
from basic_pitch.inference import predict


def transcribe_vocals(source: Path) -> dict:
    """Return V5 structured *vocal-only* note draft; lyrics require later alignment."""
    source = source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() not in {".mp3", ".wav", ".flac"}:
        raise ValueError("Expected a local MP3, WAV or FLAC file")
    with tempfile.TemporaryDirectory(prefix="timelink-vocal-") as temp:
        output = Path(temp)
        command = [
            "python", "-m", "demucs", "--two-stems", "vocals",
            "--name", "htdemucs", "--out", str(output), str(source),
        ]
        subprocess.run(command, check=True, timeout=1200, capture_output=True)
        vocals = output / "htdemucs" / source.stem / "vocals.wav"
        if not vocals.is_file():
            raise RuntimeError("Demucs did not produce a vocals stem")
        # SoundFile can read the separated WAV; reject invalid or empty stems.
        audio, sample_rate = sf.read(str(vocals))
        if sample_rate <= 0 or len(audio) == 0:
            raise ValueError("Empty or invalid vocal stem")

        duration = len(audio) / sample_rate
        _, _, events = predict(str(vocals))
        notes = []
        for start, end, pitch, confidence, *_ in sorted(events, key=lambda n: n[0]):
            if not all(math.isfinite(float(v)) for v in (start, end, pitch, confidence)):
                continue
            start, end, pitch = float(start), float(end), int(pitch)
            if not all(math.isfinite(v) for v in (start, end, confidence)):
                continue
            if not (21 <= pitch <= 108 and 0 <= start < end <= duration + 0.1):
                continue
            if end - start < 0.08 or confidence < 0.4:
                continue
            if notes and start < notes[-1]["s"] + notes[-1]["d"]:
                # The score API requires a monophonic vocal melody.
                start = notes[-1]["s"] + notes[-1]["d"]
            if end - start < 0.08:
                continue
            notes.append({"s": round(start, 3), "d": round(end - start, 3), "m": pitch})
        if not notes:
            raise ValueError("No reliable vocal melody notes detected")
        return {
            "part": "lead_vocal", "melody": notes, "chords": [],
            "provenance": {"method": "vocal_separation", "engine": "demucs-htdemucs+basic-pitch"},
            "lyrics_status": "not_aligned",
        }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Locally staged audio; never a URL")
    parser.add_argument('--source-sha256', help='Expected 64-character V5 source SHA-256')
    parser.add_argument('--rights-confirmed', action='store_true', help='Authorized operator confirmation')
    args = parser.parse_args()
    if args.source_sha256:
        import hashlib
        if not args.rights_confirmed:
            parser.error('--rights-confirmed is required with --source-sha256')
        if len(args.source_sha256) != 64 or any(c not in '0123456789abcdefABCDEF' for c in args.source_sha256):
            parser.error('--source-sha256 must be a 64-character hexadecimal digest')
        source_path = args.source.resolve(strict=True)
        if not source_path.is_file() or source_path.suffix.lower() not in {'.mp3', '.wav', '.flac'}:
            parser.error('Expected a local MP3, WAV or FLAC file')
        hasher = hashlib.sha256()
        with source_path.open('rb') as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b''):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        if digest.lower() != args.source_sha256.lower():
            raise ValueError('V5 source SHA-256 mismatch')
    draft = transcribe_vocals(args.source)
    if args.source_sha256:
        provenance = draft.pop('provenance')
        draft.pop('lyrics_status', None)
        print(json.dumps({'rights_confirmed': True, 'source_sha256': digest, 'provenance': provenance, 'score_data': draft}, ensure_ascii=False))
    else:
        print(json.dumps(draft, ensure_ascii=False))
