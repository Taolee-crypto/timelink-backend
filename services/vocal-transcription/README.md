# V5 vocal transcription (prototype, not deployed)

This private **Python GPU/CPU service** separates the vocal stem with Demucs and estimates monophonic vocal notes with Basic Pitch. It does **not** transcribe or align lyrics, derive guitar chords, fetch audio from public URLs, or publish scores. The Cloudflare Worker cannot run these heavy models directly.

## Run locally

Use Python 3.10 in an isolated virtual environment. Install system ffmpeg, then `pip install -r requirements.txt`. Execute `python transcribe.py /private/staged/track.mp3 > draft.json`.

The result contains `part: lead_vocal`, `melody: [{s,d,m}]`, empty `chords`, and a provenance object. Accuracy requires human review. Demucs vocal stems may retain instruments; pitch extraction can still make mistakes.

## Required production integration

1. Authenticate the owner, confirm rights and resolve the sealed V5 file on the Cloudflare backend.
2. Pass only a short-lived, authenticated job reference to an isolated inference worker; do not expose private MP3 URLs.
3. The worker retrieves the authorized source securely, checks SHA-256, applies file-size/duration and rate limits, and runs this script.
4. Review/edit melody, obtain and align authorized lyrics, and derive guitar chords separately.
5. Submit `POST /scores/v5/:reference/draft` using `rights_confirmed: true`, the **verified** V5 source SHA-256, `provenance: {method: "vocal_separation", engine: "demucs-htdemucs+basic-pitch"}`, and `score_data` (excluding the top-level provenance).
6. Confirm that no TLD was minted and no TL charged.

**Not implemented:** authenticated job queue, secure audio staging, deployment, lyrics alignment, chord inference, or production tests. Do not enable the automatic transcription button until those are complete.
