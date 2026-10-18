from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
ECONOMY_MIGRATION = ROOT / "migrations" / "0003_v3_economy_ledger.sql"
MUSIC_MIGRATION = ROOT / "migrations" / "0004_v3_music_core.sql"

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
db.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
INSERT INTO users VALUES (1, 'creator');
""")
economy_sql = ECONOMY_MIGRATION.read_text(encoding="utf-8")
music_sql = MUSIC_MIGRATION.read_text(encoding="utf-8")
db.executescript(economy_sql)
db.executescript(music_sql)

expected = {
    "v3_tracks", "v3_track_metadata_versions", "v3_track_assets",
    "v3_track_rights", "v3_track_releases", "v3_shareplace_entries",
    "v3_legacy_track_links", "v3_poc_events",
}
actual = {row[0] for row in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
)}
assert expected <= actual, f"Missing V3 tables: {expected - actual}"

# Both migrations must be safe to re-apply.
db.executescript(economy_sql)
db.executescript(music_sql)
actual = {row[0] for row in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
)}
assert expected <= actual

def fails(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("Expected integrity failure: " + statement)

db.execute("INSERT INTO v3_tracks(id,owner_user_id) VALUES ('track-1',1)")
db.execute("""
INSERT INTO v3_track_metadata_versions
(id,track_id,version,original_filename,display_title,metadata_source)
VALUES ('meta-1','track-1',1,'demo.mp3','Demo','id3')
""")
db.execute("""
INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,ownership_share_bps,terms_version,verification_status)
VALUES ('rights-1','track-1',1,'composer',10000,'rights-v1','verified')
""")
db.execute("""
INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES ('asset-source','track-1','mp3_audio','local_agent','source-object','sha256:abc',1000,'audio/mpeg','available',1)
""")

# Track metadata and MP3 source Asset intake must not create POC contribution.
assert db.execute("SELECT COUNT(*) FROM v3_poc_events").fetchone()[0] == 0

# MP3 is not a Release type; only TL3 is a commercial Release in this schema.
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('invalid-mp3-release','track-1','MP3',1,'draft','asset-source','asset-source',0)
""")
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('invalid-zero-price','track-1','TL3',1,'draft',NULL,'asset-source',0)
""")
fails("""
INSERT INTO v3_track_assets
(id,track_id,asset_type,availability_status,created_by)
VALUES ('invalid-asset','track-1','mp3_audio','available',1)
""")

db.execute("""
INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,availability_status,created_by,mime_type)
VALUES ('asset-tl3','track-1','tl3_release_file','google_drive','tl3-object','available',1,'application/octet-stream')
""")

# A successful TL3 conversion creates a pending, auditable POC candidate.
db.execute("""
INSERT INTO v3_poc_events
(id,user_id,event_key,event_type,source,source_reference,base_value,contribution_value,
 verification_status,formula_version,metadata_json)
VALUES ('poc-candidate-1','1','tl3-conversion:asset-tl3','tl3_conversion_completed',
 'music_v3','asset-tl3',0,0,'pending','poc-v1','{"track_id":"track-1","source_asset_id":"asset-source"}')
""")
candidate = db.execute("""
SELECT event_type,verification_status,contribution_value
FROM v3_poc_events WHERE id='poc-candidate-1'
""").fetchone()
assert candidate == ("tl3_conversion_completed", "pending", 0)

db.execute("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl,duration_seconds,format_version)
VALUES ('release-tl3','track-1','TL3',1,'draft','asset-tl3','asset-source',120,180,'TLNK-v2')
""")
db.execute("UPDATE v3_track_releases SET status='published',published_at=datetime('now') WHERE id='release-tl3'")
assert db.execute("SELECT status FROM v3_track_releases WHERE id='release-tl3'").fetchone()[0] == "published"

# A source MP3 Asset cannot satisfy the published TL3 asset requirement.
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('invalid-source-release','track-1','TL3',2,'published','asset-source','asset-source',120)
""")
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('invalid-source-link','track-1','TL3',3,'published','asset-tl3','asset-tl3',120)
""")
# Only one published TL3 release is allowed per Track.
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('second-published-tl3','track-1','TL3',2,'published','asset-tl3','asset-source',120)
""")

# Legacy records are not touched or backfilled by the V3 migrations.
db.execute("CREATE TABLE tl_shares (id TEXT PRIMARY KEY, title TEXT)")
db.execute("INSERT INTO tl_shares VALUES ('legacy-1','Legacy song')")
before = db.execute("SELECT * FROM tl_shares").fetchall()
db.executescript(economy_sql)
db.executescript(music_sql)
assert db.execute("SELECT * FROM tl_shares").fetchall() == before

# The API must record conversion evidence only through the explicit completion action.
route_source = (ROOT / "src" / "routes" / "music-v3.ts").read_text(encoding="utf-8")
assert "router.post('/tracks/:id/conversions/tl3/complete'" in route_source
assert "conversionPocCandidate" not in route_source
assert "if(type==='tl3_release_file') statements.push" not in route_source
assert "poc_candidate:type==='tl3_release_file'" not in route_source
assert "The completed TL3 output must be an available TL3 Asset" in route_source
assert "verification_status,formula_version,metadata_json)" in route_source
assert "'pending','poc-v1'" in route_source
assert "type!=='TL3'" in route_source
assert "source_asset_id" in route_source
assert "source_asset_id:sourceAssetId" in route_source
assert "release_type IN ('MP3','TL3')" not in music_sql

print(
    "V3 music validation passed: additive/idempotent schema, private MP3 source Assets, "
    "TL3-only Releases, verified-rights publication gates, conversion-only pending POC candidates, "
    "single published TL3 Release, and untouched legacy data."
)
