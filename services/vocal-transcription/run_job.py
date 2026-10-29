"""One-shot OIDC runner. Encryption keys never leave the Cloudflare Worker."""
from __future__ import annotations
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
import requests
import re


def classify_analysis_failure(error):
    # Only fixed stage markers are logged, never raw model stderr or creator content.
    if not isinstance(error, subprocess.CalledProcessError):
        return 'VOCAL_ANALYSIS_FAILED', 'unknown'
    stages = re.findall(r'^V5_SCORE_STAGE:(separation|melody|lyrics|complete)$',
                        error.stderr or '', flags=re.MULTILINE)
    stage = stages[-1] if stages else 'unknown'
    code = {'separation': 'VOCAL_SEPARATION_FAILED',
            'melody': 'VOCAL_MELODY_FAILED',
            'lyrics': 'VOCAL_LYRICS_FAILED'}.get(stage, 'VOCAL_ANALYSIS_FAILED')
    return code, stage

API_BASE = 'https://api.timelink.digital'
AUDIENCE = API_BASE + '/v5-vocal-score'

class GitHubIdentity(requests.auth.AuthBase):
    def __call__(self, request):
        # Get a fresh short-lived identity for each operation, including completion.
        url = urlparse(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'])
        if url.scheme != 'https' or not url.hostname or not url.hostname.endswith('.actions.githubusercontent.com'):
            raise ValueError('Invalid GitHub identity issuer endpoint')
        query = dict(parse_qsl(url.query)); query['audience'] = AUDIENCE
        response = requests.get(urlunparse(url._replace(query=urlencode(query))),
            headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']},
            timeout=30, allow_redirects=False)
        response.raise_for_status()
        token = response.json()['value']
        request.headers['Authorization'] = 'Bearer ' + token
        return request

def main() -> int:
    base = os.environ.get('V5_SCORE_API_BASE', API_BASE).rstrip('/')
    if base != API_BASE:
        raise ValueError('Unexpected score API origin')
    session = requests.Session(); session.auth = GitHubIdentity()
    root = base + '/api/v1/scores/v5/internal'
    response = session.post(root + '/claim', timeout=30, allow_redirects=False)
    response.raise_for_status()
    job = response.json().get('job')
    if not job:
        print('No queued V5 score jobs'); return 0
    file_id = int(job['file_id'])
    if file_id <= 0: raise ValueError('Invalid job ID')
    try:
        response = session.get(root + '/audio/' + str(file_id), timeout=180, allow_redirects=False)
        response.raise_for_status()
        audio = response.content
        if not 0 < len(audio) <= 16 * 1024 * 1024 or hashlib.sha256(audio).hexdigest() != job['source_sha256']:
            raise ValueError('Source integrity mismatch')
        with tempfile.TemporaryDirectory(prefix='tl-vocal-job-') as tmp:
            source = Path(tmp) / 'source.mp3'; source.write_bytes(audio)
            lyrics = Path(tmp) / 'lyrics.txt'; lyrics.write_text(job.get('lyrics', ''), encoding='utf-8')
            process = subprocess.run([
                sys.executable, str(Path(__file__).with_name('transcribe.py')), str(source),
                '--source-sha256', job['source_sha256'], '--rights-confirmed', '--lyrics', str(lyrics)
            ], check=True, capture_output=True, text=True, timeout=2100)
            result = json.loads(process.stdout)
        if result.get('score_data', {}).get('part') != 'lead_vocal':
            raise ValueError('Inference did not return lead vocal notes')
        response = session.post(root + '/complete/' + str(file_id), json=result, timeout=60, allow_redirects=False)
        response.raise_for_status()
        if response.json().get('ok') is not True: raise RuntimeError('Score completion rejected')
        print('Completed V5 vocal score job', file_id)
        return 0
    except Exception as error:
        code, stage = classify_analysis_failure(error)
        print('V5 vocal job failed:', type(error).__name__, 'stage=' + stage, file=sys.stderr)
        try:
            session.post(root + '/fail/' + str(file_id), json={'code':code}, timeout=30, allow_redirects=False)
        except requests.RequestException: pass
        return 1

if __name__ == '__main__':
    sys.exit(main())
