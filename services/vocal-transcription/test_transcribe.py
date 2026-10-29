"""Dependency-free contract tests: mock heavyweight inference libraries."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sf = types.ModuleType("soundfile")
sf.read = lambda _: ([0.0] * 1000, 1000)
bp = types.ModuleType("basic_pitch")
inference = types.ModuleType("basic_pitch.inference")
inference.predict = lambda _: (None, None, [
    (0.1, 0.5, 60, 0.9),
    (0.4, 0.8, 62, 0.9),
    (0.8, 0.9, 64, 0.1),
])
sys.modules["soundfile"] = sf
sys.modules["basic_pitch"] = bp
sys.modules["basic_pitch.inference"] = inference
spec = importlib.util.spec_from_file_location("transcribe", Path(__file__).with_name("transcribe.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VocalContract(unittest.TestCase):
    def test_monophonic_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "song.mp3"
            source.write_bytes(b"fake mp3 for mocked unit test")
            def fake_run(command, **kwargs):
                stem = Path(command[command.index("--out") + 1]) / "htdemucs" / "song" / "vocals.wav"
                stem.parent.mkdir(parents=True)
                stem.touch()
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.subprocess, "run", side_effect=fake_run), \
                 patch.object(module, "estimate_vocal_midi_contour", return_value=([60.0]*100, 0.01)):
                result = module.transcribe_vocals(source)
            self.assertEqual(result["part"], "lead_vocal")
            self.assertEqual(result["chords"], [])
            self.assertEqual(len(result["melody"]), 2)
            self.assertGreaterEqual(result["melody"][1]["s"], result["melody"][0]["s"] + result["melody"][0]["d"] - 0.001)
            json.dumps(result)

    def test_unverified_lyrics_preserves_real_melody_without_fake_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "song.mp3"
            source.write_bytes(b"test source")
            def fake_run(command, **kwargs):
                stem = Path(command[command.index("--out") + 1]) / "htdemucs" / "song" / "vocals.wav"
                stem.parent.mkdir(parents=True)
                stem.touch()
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.subprocess, "run", side_effect=fake_run), \
                 patch.object(module, "estimate_vocal_midi_contour", return_value=([60.0]*100, .01)), \
                 patch.object(module, "align_lyrics", side_effect=module.LyricsAlignmentUncertain("timing")):
                result = module.transcribe_vocals(source, "creator lyric")
            self.assertEqual(result["lyrics_status"], "alignment_pending")
            self.assertEqual(result["lyrics_words"], [])
            self.assertEqual(len(result["melody"]), 2)
            self.assertTrue(all("lyric" not in n for n in result["melody"]))
            self.assertTrue(result["lyrics_alignment"]["review_required"])

    def test_missing_source(self):
        with self.assertRaises(FileNotFoundError):
            module.transcribe_vocals(Path("/no/such/file.mp3"))

    def test_no_melody(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "song.wav"
            source.touch()
            def fake_run(command, **kwargs):
                stem = Path(command[command.index("--out") + 1]) / "htdemucs" / "song" / "vocals.wav"
                stem.parent.mkdir(parents=True)
                stem.touch()
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.subprocess, "run", side_effect=fake_run), patch.object(module, "predict", return_value=(None, None, [])):
                with self.assertRaisesRegex(ValueError, "No reliable"):
                    module.transcribe_vocals(source)


if __name__ == "__main__":
    unittest.main()
