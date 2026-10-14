from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys = ON")
db.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
INSERT INTO users VALUES (1,'creator','user');
INSERT INTO users VALUES (2,'listener','user');
INSERT INTO users VALUES (3,'other','user');
""")
for name in (
    "0004_v3_music_core.sql",
    "0005_v3_music_review_audit.sql",
    "0006_v3_music_social.sql",
):
    migration = (ROOT / "migrations" / name).read_text(encoding="utf-8")
    db.executescript(migration)
    db.executescript(migration)

def fails(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("Expected integrity failure: " + statement)

# A public Track requires an approved TL3 Release and a public SharePlace entry.
db.execute("INSERT INTO v3_tracks(id,owner_user_id,status,visibility) VALUES('track-public',1,'active','public')")
db.execute("""INSERT INTO v3_track_metadata_versions
(id,track_id,version,original_filename,display_title,metadata_source)
VALUES('meta-public','track-public',1,'song.mp3','Public Song','manual')""")
db.execute("""INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,terms_version,attested_at,verification_status)
VALUES('rights-public','track-public',1,'composer','creator-attestation-v1',datetime('now'),'verified')""")
db.execute("""INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES('asset-public-source','track-public','mp3_audio','google_drive','source-mp3-object','sha256:' || printf('%064d',2),2048,'audio/mpeg','available',1)""")
db.execute("""INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES('asset-public','track-public','tl3_release_file','google_drive','tl3-object','sha256:' || printf('%064d',1),2048,'application/octet-stream','available',1)""")
db.execute("""INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES('release-public','track-public','TL3',1,'published','asset-public','asset-public-source',120)""")
db.execute("""INSERT INTO v3_shareplace_entries
(id,track_id,owner_user_id,category,visibility,published_at)
VALUES('share-public','track-public',1,'Music','public',datetime('now'))""")
visible = db.execute("""
SELECT t.id,m.display_title,r.price_tl,a.asset_type
FROM v3_tracks t
JOIN v3_shareplace_entries s ON s.track_id=t.id AND s.visibility='public'
JOIN v3_track_releases r ON r.track_id=t.id AND r.release_type='TL3' AND r.status='published'
JOIN v3_track_assets a ON a.id=r.asset_id AND a.availability_status='available'
 AND a.asset_type='tl3_release_file'
JOIN v3_track_metadata_versions m ON m.track_id=t.id
WHERE t.id=? AND t.status='active' AND t.visibility='public'
""",('track-public',)).fetchone()
assert visible and visible["display_title"] == "Public Song" and visible["price_tl"] == 120

# MP3 is a source Asset, never a Release or a public streaming tier.
fails("""INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,price_tl)
VALUES('invalid-mp3-release','track-public','MP3',1,'published','asset-public','asset-public-source',0)""")

# A TL3 asset stored by object reference is eligible; it need not expose a public stream URL.
db.execute("INSERT INTO v3_tracks(id,owner_user_id,status,visibility) VALUES('track-private',1,'active','private')")
db.execute("""INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,terms_version,attested_at,verification_status)
VALUES('rights-private','track-private',1,'composer','creator-attestation-v1',datetime('now'),'verified')""")
db.execute("""INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,availability_status,created_by,mime_type)
VALUES('asset-private-source','track-private','mp3_audio','onedrive','source-object','available',1,'audio/mpeg')""")
db.execute("""INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,availability_status,created_by,mime_type)
VALUES('asset-private','track-private','tl3_release_file','onedrive','private-object','available',1,'application/octet-stream')""")
db.execute("""INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,price_tl)
VALUES('release-private','track-private','TL3',1,'published','asset-private','asset-private-source',120)""")
not_public = db.execute("""
SELECT t.id FROM v3_tracks t
JOIN v3_shareplace_entries s ON s.track_id=t.id AND s.visibility='public'
JOIN v3_track_releases r ON r.track_id=t.id AND r.release_type='TL3' AND r.status='published'
JOIN v3_track_assets a ON a.id=r.asset_id AND a.asset_type='tl3_release_file' AND a.availability_status='available'
WHERE t.id=? AND t.status='active' AND t.visibility='public'
""",('track-private',)).fetchone()
assert not not_public

# Likes, comments, reports and follows remain deduplicated and foreign-key bound.
db.execute("INSERT INTO v3_track_likes(id,track_id,user_id) VALUES('like-1','track-public',2)")
fails("INSERT INTO v3_track_likes(id,track_id,user_id) VALUES('like-2','track-public',2)")
db.execute("INSERT INTO v3_track_comments(id,track_id,user_id,content) VALUES('comment-1','track-public',2,'A thoughtful comment')")
db.execute("INSERT INTO v3_track_comment_reports(id,comment_id,reporter_user_id,reason) VALUES('report-1','comment-1',3,'Please review')")
fails("INSERT INTO v3_track_comment_reports(id,comment_id,reporter_user_id,reason) VALUES('report-2','comment-1',3,'Duplicate report')")
db.execute("INSERT INTO v3_track_follows(id,follower_user_id,followed_user_id) VALUES('follow-1',2,1)")
fails("INSERT INTO v3_track_follows(id,follower_user_id,followed_user_id) VALUES('follow-2',2,1)")
fails("INSERT INTO v3_track_follows(id,follower_user_id,followed_user_id) VALUES('follow-self',1,1)")
assert db.execute("SELECT COUNT(*) FROM v3_track_likes WHERE track_id='track-public'").fetchone()[0] == 1
assert db.execute("SELECT COUNT(*) FROM v3_track_comments WHERE track_id='track-public' AND moderation_status='visible'").fetchone()[0] == 1
db.execute("UPDATE v3_track_comments SET moderation_status='hidden' WHERE id='comment-1'")
db.execute("""INSERT INTO v3_track_comment_moderation_events
(id,comment_id,moderator_user_id,action,moderation_note)
VALUES('mod-1','comment-1',1,'hidden','Confirmed policy violation')""")
assert db.execute("SELECT moderation_status FROM v3_track_comments WHERE id='comment-1'").fetchone()[0] == "hidden"
assert db.execute("SELECT COUNT(*) FROM v3_track_comment_moderation_events WHERE comment_id='comment-1'").fetchone()[0] == 1

# Public and social APIs must not expose an MP3 stream or treat MP3 as a Release.
public_source = (ROOT / "src" / "routes" / "music-v3-public.ts").read_text(encoding="utf-8")
social_source = (ROOT / "src" / "routes" / "music-v3-social.ts").read_text(encoding="utf-8")
assert "release_type='MP3'" not in public_source + social_source
assert "mp3_release_id" not in public_source
assert "stream_url" not in public_source
assert "storage_uri_ref AS stream_url" not in public_source
assert "release_type='TL3'" in public_source and "release_type='TL3'" in social_source
assert "asset_type='tl3_release_file'" in public_source and "asset_type='tl3_release_file'" in social_source
assert "storage_uri_ref IS NOT NULL" not in social_source
migration_source = (ROOT / "migrations" / "0004_v3_music_core.sql").read_text(encoding="utf-8")
assert "release_type IN ('TL3')" in migration_source
assert "release_type IN ('MP3','TL3')" not in migration_source

print("V3 SharePlace/social validation passed: only public Tracks with approved TL3 Releases are discoverable; no free MP3 stream is exposed; likes, comments, reports, follows and audited moderation are enforced.")
