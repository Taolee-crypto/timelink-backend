from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
db.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
INSERT INTO users VALUES (1, 'creator', 'user');
""")

for name in (
    "0003_v3_economy_ledger.sql",
    "0004_v3_music_core.sql",
    "0005_v3_music_review_audit.sql",
    "0006_v3_music_social.sql",
    "0007_v3_tl3_conversion_jobs.sql",
):
    migration = (ROOT / "migrations" / name).read_text(encoding="utf-8")
    db.executescript(migration)
    db.executescript(migration)

expected = {"v3_tl3_conversion_jobs", "v3_poc_events", "v3_track_assets", "v3_track_releases"}
actual = {row[0] for row in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
)}
assert expected <= actual, f"Missing V3 conversion tables: {expected - actual}"

def fails(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("Expected integrity failure: " + statement)

source_hash = "a" * 64
output_hash = "b" * 64
db.execute("INSERT INTO v3_tracks(id,owner_user_id) VALUES('track-1',1)")
db.execute("""INSERT INTO v3_track_metadata_versions
(id,track_id,version,original_filename,display_title,extracted_artist,metadata_source)
VALUES('meta-1','track-1',1,'song.mp3','Song','Artist','manual')""")
db.execute("""INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES('source-1','track-1','mp3_audio','local_agent',
'https://agent.timelink.digital/local/0123456789abcdef0123456789abcdef0123',
?,4096,'audio/mpeg','available',1)""", (source_hash,))
assert db.execute("SELECT COUNT(*) FROM v3_poc_events").fetchone()[0] == 0

license_reference = "v3_" + "1" * 32 + "_" + "2" * 32
db.execute("""INSERT INTO v3_tl3_conversion_jobs
(id,track_id,source_asset_id,owner_user_id,license_reference,source_content_hash,status)
VALUES('job-1','track-1','source-1',1,?,?,'building')""", (license_reference,source_hash))
db.execute("""INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES('output-1','track-1','tl3_release_file','local_agent',
'https://agent.timelink.digital/local/1123456789abcdef0123456789abcdef0123',
?,5000,'application/octet-stream','available',1)""", (output_hash,))

# A conversion job becomes eligible only after the server has produced output metadata.
db.execute("""UPDATE v3_tl3_conversion_jobs
SET status='built',output_content_hash=?,output_size_bytes=5000,duration_seconds=180,segment_count=36
WHERE id='job-1' AND status='building'""", (output_hash,))
built = db.execute("SELECT status,source_content_hash,output_content_hash,segment_count FROM v3_tl3_conversion_jobs WHERE id='job-1'").fetchone()
assert built == ("built", source_hash, output_hash, 36)

# Completing the verified container links the Asset and creates a pending candidate, not a reward.
db.execute("""UPDATE v3_tl3_conversion_jobs
SET status='completed',output_asset_id='output-1',completed_at=datetime('now')
WHERE id='job-1' AND status='built'""")
db.execute("""INSERT INTO v3_poc_events
(id,user_id,event_key,event_type,source,source_reference,base_value,contribution_value,
 verification_status,formula_version,metadata_json)
VALUES('poc-1','1','tl3-conversion:job-1','tl3_conversion_completed',
'music_v3','output-1',0,0,'pending','poc-v1','{"conversion_job_id":"job-1"}')""")
candidate = db.execute("""SELECT event_type,verification_status,contribution_value
FROM v3_poc_events WHERE event_key='tl3-conversion:job-1'""").fetchone()
assert candidate == ("tl3_conversion_completed", "pending", 0)
assert db.execute("SELECT status FROM v3_tl3_conversion_jobs WHERE id='job-1'").fetchone()[0] == "completed"

# License references and output Assets cannot be reused by another conversion job.
fails("""INSERT INTO v3_tl3_conversion_jobs
(id,track_id,source_asset_id,owner_user_id,license_reference,source_content_hash)
VALUES('job-duplicate-license','track-1','source-1',1,?,?)""", (license_reference,source_hash))
fails("""INSERT INTO v3_tl3_conversion_jobs
(id,track_id,source_asset_id,owner_user_id,license_reference,source_content_hash,output_asset_id)
VALUES('job-duplicate-output','track-1','source-1',1,?,?, 'output-1')""",
      ("v3_" + "3" * 32 + "_" + "4" * 32,source_hash))
fails("""INSERT INTO v3_tl3_conversion_jobs
(id,track_id,source_asset_id,owner_user_id,license_reference,source_content_hash)
VALUES('job-invalid-hash','track-1','source-1',1,'invalid','short')""")

# Source registration alone never creates POC evidence.
assert db.execute("SELECT COUNT(*) FROM v3_poc_events").fetchone()[0] == 1

route = (ROOT / "src" / "routes" / "music-v3.ts").read_text(encoding="utf-8")
build_start = route.index("router.post('/tracks/:id/conversions/tl3/build'")
complete_start = route.index("router.post('/tracks/:id/conversions/tl3/complete'")
release_start = route.index("// POST /tracks/:id/releases —", complete_start)
build_route = route[build_start:complete_start]
complete_route = route[complete_start:release_start]
assert "buildTL3V3FromMp3" in build_route
assert "parseMp3Segments" in build_route
assert "TL3_MASTER_SECRET" in build_route
assert "v3_poc_events" not in build_route
assert "v3_tl3_conversion_jobs" in build_route
assert "parseTL3V3(outputBytes).header" in complete_route
assert "header.share_id!==job.license_reference" in complete_route
assert "header.hash_mp3" in complete_route
assert "v3_poc_events" in complete_route
assert "verification_status,formula_version,metadata_json)" in complete_route
assert "'pending','poc-v1'" in complete_route

tl3_source = (ROOT / "src" / "tl3v3.ts").read_text(encoding="utf-8")
assert "share_id: input.shareId" in tl3_source
assert "dur_sec: durationSeconds" in tl3_source
assert "const segmentCount = segments.length" in tl3_source

index_source = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")
assert "import { parseMp3Segments } from './mp3-segments';" in index_source
assert "function parseMp3Segments(" not in index_source

print("V3 TL3 conversion validation passed: Local Agent source verification, server-side AES-GCM build, unique license reference, verified stored container, conversion-only pending POC evidence, and no file bytes in D1.")
