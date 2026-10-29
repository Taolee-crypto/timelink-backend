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
            with patch.object(module.subprocess, "run", side_effect=fake_run):
                result = module.transcribe_vocals(source)
            self.assertEqual(result["part"], "lead_vocal")
            self.assertEqual(result["chords"], [])
            self.assertEqual(len(result["melody"]), 2)
            self.assertGreaterEqual(result["melody"][1]["s"], result["melody"][0]["s"] + result["melody"][0]["d"] - 0.001)
            json.dumps(result)

    def test_timed_lyrics_alignment(self):
        draft = {"melody": [{"s": 0.2, "d": 0.4, "m": 60}, {"s": 1.2, "d": 0.4, "m": 62}], "chords": []}
        aligned = module.align_timed_lyrics(draft, "[00:00.10]RED\\n[00:01.10]AND YELLOW")
        self.assertEqual([n["lyric"] for n in aligned["melody"]], ["RED", "AND YELLOW"])
        self.assertNotIn("lyric", draft["melody"][0])
        self.assertEqual(aligned["lyrics_status"], "timed_draft_review_required")
        with self.assertRaisesRegex(ValueError, "LRC"):
            module.align_timed_lyrics(draft, "untimed lyrics")
        with self.assertRaisesRegex(ValueError, "matching vocal"):
            module.align_timed_lyrics(draft, "[99:00.00]out of range")

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
