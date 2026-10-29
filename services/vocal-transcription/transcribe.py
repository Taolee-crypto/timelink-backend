"""Isolated CPU/GPU vocal transcription worker. Not exposed through public Worker routes.

Accepts a locally staged, rights-checked MP3 path. No remote URL fetching.
Requires Demucs and Basic Pitch to be installed in this private service environment.
"""
from __future__ import annotations

import json
import contextlib
import sys
from lyrics_alignment import align_lyrics, LyricsAlignmentUncertain
from pitch_postprocess import refine_pitch_events
import math
import subprocess
import tempfile
from pathlib import Path

with contextlib.redirect_stdout(sys.stderr):
    import soundfile as sf
    from basic_pitch.inference import predict



def estimate_vocal_midi_contour(audio, sample_rate):
    """Run a *single* YIN pass on the separated stem; returns MIDI frames and hop."""
    # Heavy signal-processing libraries are deliberately loaded only for real
    # inference, not for cheap contract validation in GitHub Actions.
    with contextlib.redirect_stdout(sys.stderr):
        import librosa
        import numpy as np
        mono = audio.mean(axis=1) if audio.ndim > 1 else audio
        mono = librosa.resample(mono.astype(np.float32),
                               orig_sr=sample_rate, target_sr=16000)
        hop = 256
        f0 = librosa.yin(mono, fmin=82.0, fmax=1000.0, sr=16000,
                        frame_length=2048, hop_length=hop)
        rms = librosa.feature.rms(y=mono, frame_length=2048, hop_length=hop)[0]
        floor = max(0.0007, float(np.percentile(rms, 70))*0.08)
        frames = [
            float(librosa.hz_to_midi(float(hz)))
            if math.isfinite(float(hz)) and hz > 0 and i < len(rms) and rms[i] > floor
            else None
            for i, hz in enumerate(f0)
        ]
    return frames, hop/16000

def transcribe_vocals(source: Path, lyrics: str = '') -> dict:
    """Return V5 structured *vocal-only* note draft; with forced alignment of supplied lyrics."""
    source = source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() not in {".mp3", ".wav", ".flac"}:
        raise ValueError("Expected a local MP3, WAV or FLAC file")
    with tempfile.TemporaryDirectory(prefix="timelink-vocal-") as temp:
        output = Path(temp)
        command = [
            "python", "-m", "demucs", "--two-stems", "vocals",
            "--name", "htdemucs", "--out", str(output), str(source),
        ]
        print('V5_SCORE_STAGE:separation', file=sys.stderr, flush=True)
        subprocess.run(command, check=True, timeout=1200, capture_output=True)
        vocals = output / "htdemucs" / source.stem / "vocals.wav"
        if not vocals.is_file():
            raise RuntimeError("Demucs did not produce a vocals stem")
        # SoundFile can read the separated WAV; reject invalid or empty stems.
        audio, sample_rate = sf.read(str(vocals))
        if sample_rate <= 0 or len(audio) == 0:
            raise ValueError("Empty or invalid vocal stem")

        duration = len(audio) / sample_rate
        print('V5_SCORE_STAGE:melody', file=sys.stderr, flush=True)
        with contextlib.redirect_stdout(sys.stderr):
            _, _, events = predict(str(vocals))
        # Independent F0 of the authentic separated vocal stem.
        if not events:
            raise ValueError("No reliable vocal melody notes detected")
        print('V5_SCORE_STAGE:pitch_verify', file=sys.stderr, flush=True)
        midi_frames, frame_seconds = estimate_vocal_midi_contour(audio, sample_rate)
        notes, pitch_report = refine_pitch_events(events, midi_frames, frame_seconds, duration)
        if not notes:
            raise ValueError("No reliable vocal melody notes after independent F0 verification")
        print('V5_SCORE_STAGE:lyrics', file=sys.stderr, flush=True)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                aligned = align_lyrics(vocals, lyrics, notes, duration)
        except LyricsAlignmentUncertain:
            # Preserve the independently observed melody instead of failing
            # the whole track because one sung word has no reliable timestamp.
            # No fabricated word positions, source changes or fake note lyrics.
            print('V5_SCORE_STAGE:lyrics_pending_review', file=sys.stderr, flush=True)
            aligned = {
                'lyrics_status': 'alignment_pending', 'lyrics_words': [],
                'lyrics_alignment': {
                    'engine': 'stable-ts-whisper-small',
                    'source': 'creator_supplied',
                    'review_required': True,
                    'pending_reason': 'VOICE_WORD_ALIGNMENT_UNCERTAIN'
                }
            }
        print('V5_SCORE_STAGE:complete', file=sys.stderr, flush=True)
        return {
            **aligned, "part": "lead_vocal", "melody": notes, "chords": [],
            "pitch_quality": {**pitch_report, "f0_engine": "librosa-yin-16k-v1",
                              "review_required": True},
            "provenance": {"method": "vocal_separation", "engine": "demucs-htdemucs+basic-pitch"},
        }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Locally staged audio; never a URL")
    parser.add_argument('--source-sha256', help='Expected 64-character V5 source SHA-256')
    parser.add_argument('--rights-confirmed', action='store_true', help='Authorized operator confirmation')
    parser.add_argument('--lyrics', type=Path)
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
    draft = transcribe_vocals(args.source, args.lyrics.read_text(encoding='utf-8') if args.lyrics else '')
    if args.source_sha256:
        provenance = draft.pop('provenance')
        print(json.dumps({'rights_confirmed': True, 'source_sha256': digest, 'provenance': provenance, 'score_data': draft}, ensure_ascii=False))
    else:
        print(json.dumps(draft, ensure_ascii=False))
