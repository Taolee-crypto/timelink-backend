"""Offline contract tests for the private V5 inference runner.

Run with: python -m unittest discover -s services/vocal-transcription/tests
No audio, credentials, network or ML dependencies required.
"""
import importlib.util
import json
import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("run_job", ROOT / "run_job.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerContractTests(TestCase):
    def test_stage_failure_classification_never_returns_private_data(self):
        from subprocess import CalledProcessError
        err = CalledProcessError(1, ['python', 'transcribe.py'],
            stderr='private audio\nV5_SCORE_STAGE:separation\nV5_SCORE_STAGE:melody\nprivate lyrics')
        self.assertEqual(runner.classify_analysis_failure(err), ('VOCAL_MELODY_FAILED', 'melody'))
        self.assertEqual(runner.classify_analysis_failure(ValueError('private')),
                         ('VOCAL_ANALYSIS_FAILED', 'unknown'))
        for stage, code in [('lyrics_model', 'VOCAL_LYRICS_MODEL_FAILED'),
                            ('lyrics_align', 'VOCAL_LYRICS_ALIGN_FAILED'),
                            ('lyrics_attach', 'VOCAL_LYRICS_TIMING_FAILED'),
                            ('lyrics_verify', 'VOCAL_LYRICS_MISMATCH')]:
            err = CalledProcessError(1, ['inference'], stderr='V5_SCORE_STAGE:' + stage)
            self.assertEqual(runner.classify_analysis_failure(err), (code, stage))


    @patch.dict(os.environ, {
        "V5_SCORE_API_BASE": "https://api.timelink.digital",
        "V5_SCORE_WORKER_TOKEN": "t" * 32,
        "TL3_MASTER_SECRET": "m" * 32,
    })
    @patch.object(runner.requests, "Session")
    def test_empty_queue_does_not_download_audio(self, session_cls):
        session = session_cls.return_value
        reply = MagicMock()
        reply.json.return_value = {"ok": True, "job": None}
        session.post.return_value = reply
        self.assertEqual(runner.main(), 0)
        session.get.assert_not_called()
        self.assertEqual(session.post.call_args.args[0],
                         "https://api.timelink.digital/api/v1/scores/v5/internal/claim")

    @patch.dict(os.environ, {
        "V5_SCORE_API_BASE": "http://insecure.example",
        "V5_SCORE_WORKER_TOKEN": "t" * 32,
        "TL3_MASTER_SECRET": "m" * 32,
    })
    def test_rejects_non_https_api(self):
        with self.assertRaises(ValueError):
            runner.main()

    @patch.dict(os.environ, {
        "V5_SCORE_API_BASE": "https://api.timelink.digital",
        "V5_SCORE_WORKER_TOKEN": "t" * 32,
        "TL3_MASTER_SECRET": "m" * 32,
    })
    @patch.object(runner.requests, "Session")
    def test_container_failure_reports_failed_job(self, session_cls):
        session = session_cls.return_value
        claim = MagicMock()
        claim.json.return_value = {"job": {"file_id": 178, "source_sha256": "a" * 64}}
        session.post.return_value = claim
        download = MagicMock()
        download.content = b"bad"
        session.get.return_value = download
        self.assertEqual(runner.main(), 1)
        self.assertEqual(session.post.call_args.args[0],
                         "https://api.timelink.digital/api/v1/scores/v5/internal/fail/178")
        self.assertEqual(session.post.call_args.kwargs["json"]["code"],
                         "VOCAL_ANALYSIS_FAILED")
