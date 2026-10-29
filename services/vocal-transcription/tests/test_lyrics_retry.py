"""Synthetic non-audio regression for repeat forced alignment, no fabricated timestamps."""
import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lyrics_alignment import align_lyrics


class _FakeResult:
    def __init__(self, words):
        self.words = words

    def to_dict(self):
        return {'segments': [{'words': self.words}]}


class _FakeAligner:
    def __init__(self, results):
        self.results = results
        self.calls = []

    def align(self, audio, text, **kwargs):
        self.calls.append(kwargs)
        return self.results[len(self.calls) - 1]


class LyricsRetryTests(TestCase):
    def test_unanchored_first_attempt_realigns_and_preserves_source(self):
        aligner = _FakeAligner([
            _FakeResult([{'word': 'Hello', 'start': 5.0, 'end': 5.0}]),
            _FakeResult([{'word': 'Hello', 'start': 1.1, 'end': 1.4}]),
        ])
        notes = [{'s': 1.0, 'd': 1.0, 'm': 64}]
        with patch.dict(sys.modules, {'stable_whisper': SimpleNamespace(load_model=lambda *a, **k: aligner)}):
            out = align_lyrics('synthetic.wav', 'Hello', notes, 6.0)
        self.assertEqual(out['lyrics_words'][0]['text'], 'Hello')
        self.assertEqual(notes[0]['lyric'], 'Hello')
        self.assertEqual(len(aligner.calls), 2)
        self.assertTrue(aligner.calls[1]['fast_mode'])
        self.assertEqual(out['lyrics_alignment']['review_required'], True)

    def test_every_failed_attempt_does_not_mutate_note_or_store_fake_lyrics(self):
        aligner = _FakeAligner([
            _FakeResult([{'word': 'Hello', 'start': 5.0, 'end': 5.0}])
            for _ in range(3)
        ])
        notes = [{'s': 1.0, 'd': 1.0, 'm': 64}]
        with patch.dict(sys.modules, {'stable_whisper': SimpleNamespace(load_model=lambda *a, **k: aligner)}):
            with self.assertRaises(ValueError):
                align_lyrics('synthetic.wav', 'Hello', notes, 6.0)
        self.assertNotIn('lyric', notes[0])
        self.assertEqual(len(aligner.calls), 3)

    def test_mismatch_cannot_pass_even_if_word_timing_overlaps_a_note(self):
        aligner = _FakeAligner([
            _FakeResult([{'word': 'Goodbye', 'start': 1.1, 'end': 1.4}])
            for _ in range(3)
        ])
        notes = [{'s': 1.0, 'd': 1.0, 'm': 64}]
        with patch.dict(sys.modules, {'stable_whisper': SimpleNamespace(load_model=lambda *a, **k: aligner)}):
            with self.assertRaises(ValueError):
                align_lyrics('synthetic.wav', 'Hello', notes, 6.0)
        self.assertNotIn('lyric', notes[0])
