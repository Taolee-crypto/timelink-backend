from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0004_v3_music_core.sql"

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
db.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
INSERT INTO users VALUES (1, 'creator');
""")
sql = MIGRATION.read_text(encoding="utf-8")
db.executescript(sql)

expected = {
    "v3_tracks", "v3_track_metadata_versions", "v3_track_assets",
    "v3_track_rights", "v3_track_releases", "v3_shareplace_entries",
    "v3_legacy_track_links",
}
actual = {r[0] for r in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
)}
assert expected <= actual, f"Missing music tables: {expected - actual}"

# Reapplying the additive migration must not change or damage the schema.
db.executescript(sql)
assert expected <= {r[0] for r in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
)}

def fails(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f"Expected integrity failure: {statement}")

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
VALUES ('asset-mp3','track-1','mp3_audio','local_agent','obj-1','sha256:abc',1000,'audio/mpeg','available',1)
""")

# MP3 is an original Track asset, not a free release product.
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('release-mp3','track-1','MP3',1,'draft','asset-mp3','asset-mp3',0)
""")
fails("""
INSERT INTO v3_track_assets
(id,track_id,asset_type,availability_status,created_by)
VALUES ('bad-asset','track-1','mp3_audio','available',1)
""")

db.execute("""
INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,availability_status,created_by)
VALUES ('asset-tl3','track-1','tl3_release_file','google_drive','tl3-object','available',1)
""")
db.execute("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl,duration_seconds,format_version)
VALUES ('release-tl3','track-1','TL3',1,'draft','asset-tl3','asset-mp3',120,180,'TLNK-v2')
""")

# A TL3 release must have a positive price and a genuine MP3 source asset.
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('bad-zero-price','track-1','TL3',2,'draft','asset-tl3','asset-mp3',0)
""")
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('bad-source','track-1','TL3',3,'published','asset-tl3','asset-tl3',120)
""")
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('bad-release-asset','track-1','TL3',4,'published','asset-mp3','asset-mp3',120)
""")

# Publication requires both the available TL3 file and verified rights.
db.execute("UPDATE v3_track_releases SET status='published' WHERE id='release-tl3'")
fails("""
INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('second-live-tl3','track-1','TL3',2,'published','asset-tl3','asset-mp3',120)
""")
assert db.execute("SELECT COUNT(*) FROM v3_track_releases").fetchone()[0] == 1

# Legacy records are not touched or backfilled by this migration.
db.execute("CREATE TABLE tl_shares (id TEXT PRIMARY KEY, title TEXT)")
db.execute("INSERT INTO tl_shares VALUES ('legacy-1','Legacy song')")
before = db.execute("SELECT * FROM tl_shares").fetchall()
db.executescript(sql)
assert db.execute("SELECT * FROM tl_shares").fetchall() == before

# Local Agent can register an MP3 source asset without claiming it is streamable.
local_asset_sql = """
INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES(?,?,?,'local_agent',?,?,?,?,?,?)
"""
db.execute(local_asset_sql, (
    "asset-local", "track-1", "mp3_audio",
    "https://agent.timelink.digital/local/" + "a" * 36,
    "sha256:" + "b" * 64, 2048, "audio/mpeg", "available", 1
))
local_row = db.execute("""
SELECT asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status,created_by
FROM v3_track_assets WHERE id='asset-local'
""").fetchone()
assert local_row == (
    "mp3_audio", "local_agent",
    "https://agent.timelink.digital/local/" + "a" * 36,
    "sha256:" + "b" * 64, 2048, "audio/mpeg", "available", 1
), f"Local Agent asset columns were mis-bound: {local_row}"

route_source = (ROOT / "src" / "routes" / "music-v3.ts").read_text(encoding="utf-8")
assert ".bind(assetId,trackId,type,streamUri,hash||null,size," in route_source, (
    "Local Agent asset INSERT must bind asset_type before storage_uri_ref"
)
assert "music-tl3-conversion:" in route_source
assert "'pending','poc-music-tl3-v1'" in route_source

print("V3 music validation passed: MP3 source assets, TL3-only releases, source-to-release linkage, "
      "positive TL pricing, verified-rights publication gates, single published TL3 release, "
      "pending POC conversion event, and untouched legacy data.")
