from pathlib import Path
import json
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
db.execute('PRAGMA foreign_keys = ON')
db.executescript('''
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
INSERT INTO users VALUES (1,'creator','user');
INSERT INTO users VALUES (2,'reviewer','admin');
''')

migration = (ROOT / 'migrations/0004_v3_music_core.sql').read_text(encoding='utf-8')
assert "release_type IN ('TL3')" in migration
assert "release_type IN ('MP3','TL3')" not in migration
db.executescript(migration)
db.executescript((ROOT / 'migrations/0005_v3_music_review_audit.sql').read_text(encoding='utf-8'))

def fails(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError('Expected integrity failure')

# A rights declaration alone is not enough to publish a TL3 Release.
db.execute("INSERT INTO v3_tracks(id,owner_user_id) VALUES ('track-a',1)")
db.execute('''INSERT INTO v3_track_metadata_versions
(id,track_id,version,original_filename,display_title,metadata_source)
VALUES ('meta-a','track-a',1,'song.mp3','Song','manual')''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES ('source-a','track-a','mp3_audio','local_agent','source-object','sha256:' || printf('%064d',2),1024,'audio/mpeg','available',1)''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES ('asset-a','track-a','tl3_release_file','local_agent','tl3-object','sha256:' || printf('%064d',1),1024,'application/octet-stream','available',1)''')
db.execute('''INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,terms_version,attested_at,verification_status)
VALUES ('rights-a','track-a',1,'composer','creator-attestation-v1',datetime('now'),'declared')''')
db.execute('''INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('release-a','track-a','TL3',1,'ready_for_review','asset-a','source-a',120)''')

fails("UPDATE v3_track_releases SET status='published' WHERE id='release-a'")
assert db.execute("SELECT status FROM v3_track_releases WHERE id='release-a'").fetchone()[0] == 'ready_for_review'

# Human reviewer decision is recorded, then publication passes the rights gate.
db.execute("UPDATE v3_track_rights SET verification_status='verified',updated_at=datetime('now') WHERE id='rights-a'")
db.execute('''INSERT INTO v3_rights_review_events
(id,rights_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('rr-a','rights-a','track-a',2,'verified','Evidence reviewed')''')
db.execute('''
UPDATE v3_track_releases
SET status='published',published_at=datetime('now'),
rights_snapshot_json=json_object('captured_at',datetime('now'),'rights',json((
  SELECT json_group_array(json_object('id',x.id,'verification_status',x.verification_status,
  'terms_version',x.terms_version,'attested_at',x.attested_at))
  FROM v3_track_rights x WHERE x.track_id=v3_track_releases.track_id
)))
WHERE id='release-a' AND status='ready_for_review'
''')
db.execute("UPDATE v3_tracks SET status='active',visibility='public' WHERE id='track-a'")
db.execute('''INSERT INTO v3_shareplace_entries
(id,track_id,owner_user_id,category,visibility,published_at)
VALUES ('sp-a','track-a',1,'Music','public',datetime('now'))''')
db.execute('''INSERT INTO v3_release_review_events
(id,release_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('re-a','release-a','track-a',2,'approved','Approved after rights verification')''')
snap = json.loads(db.execute("SELECT rights_snapshot_json FROM v3_track_releases WHERE id='release-a'").fetchone()[0])
assert snap['rights'][0]['verification_status'] == 'verified'
assert db.execute("SELECT status FROM v3_tracks WHERE id='track-a'").fetchone()[0] == 'active'
assert db.execute("SELECT visibility FROM v3_shareplace_entries WHERE track_id='track-a'").fetchone()[0] == 'public'
fails('''INSERT INTO v3_rights_review_events
(id,rights_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('rr-duplicate','rights-a','track-a',2,'verified','Duplicate decision')''')
fails('''INSERT INTO v3_release_review_events
(id,release_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('re-duplicate','release-a','track-a',2,'approved','Duplicate decision')''')

# Verified rights cannot publish a TL3 release backed by a local-only TL3 asset.
db.execute("INSERT INTO v3_tracks(id,owner_user_id) VALUES ('track-b',1)")
db.execute('''INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,terms_version,attested_at,verification_status)
VALUES ('rights-b','track-b',1,'composer','creator-attestation-v1',datetime('now'),'verified')''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,availability_status,created_by,mime_type)
VALUES ('source-b','track-b','mp3_audio','local_agent','local_only',1,'audio/mpeg')''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,availability_status,created_by,mime_type)
VALUES ('asset-b','track-b','tl3_release_file','local_agent','local_only',1,'application/octet-stream')''')
db.execute('''INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('release-b','track-b','TL3',1,'ready_for_review','asset-b','source-b',120)''')
fails("UPDATE v3_track_releases SET status='published' WHERE id='release-b'")

print('V3 review validation passed: rights verification, matching available TL3/source Assets, rights snapshots, SharePlace state, and immutable review audit are enforced.')

db = sqlite3.connect(":memory:")

db.row_factory = sqlite3.Row
db.execute('PRAGMA foreign_keys = ON')
db.executescript('''
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
INSERT INTO users VALUES (1,'creator','user');
INSERT INTO users VALUES (2,'reviewer','admin');
''')

migration = (ROOT / 'migrations/0004_v3_music_core.sql').read_text(encoding='utf-8')
assert "release_type IN ('TL3')" in migration
assert "release_type IN ('MP3','TL3')" not in migration
db.executescript(migration)
db.executescript((ROOT / 'migrations/0005_v3_music_review_audit.sql').read_text(encoding='utf-8'))

def fails(statement, params=()):
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError('Expected integrity failure')

# A rights declaration alone is not enough to publish a TL3 Release.
db.execute("INSERT INTO v3_tracks(id,owner_user_id) VALUES ('track-a',1)")
db.execute('''INSERT INTO v3_track_metadata_versions
(id,track_id,version,original_filename,display_title,metadata_source)
VALUES ('meta-a','track-a',1,'song.mp3','Song','manual')''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES ('source-a','track-a','mp3_audio','local_agent','source-object','sha256:' || printf('%064d',2),1024,'audio/mpeg','available',1)''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
VALUES ('asset-a','track-a','tl3_release_file','local_agent','tl3-object','sha256:' || printf('%064d',1),1024,'application/octet-stream','available',1)''')
db.execute('''INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,terms_version,attested_at,verification_status)
VALUES ('rights-a','track-a',1,'composer','creator-attestation-v1',datetime('now'),'declared')''')
db.execute('''INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('release-a','track-a','TL3',1,'ready_for_review','asset-a','source-a',120)''')

fails("UPDATE v3_track_releases SET status='published' WHERE id='release-a'")
assert db.execute("SELECT status FROM v3_track_releases WHERE id='release-a'").fetchone()[0] == 'ready_for_review'

# Human reviewer decision is recorded, then publication passes the rights gate.
db.execute("UPDATE v3_track_rights SET verification_status='verified',updated_at=datetime('now') WHERE id='rights-a'")
db.execute('''INSERT INTO v3_rights_review_events
(id,rights_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('rr-a','rights-a','track-a',2,'verified','Evidence reviewed')''')
db.execute('''
UPDATE v3_track_releases
SET status='published',published_at=datetime('now'),
rights_snapshot_json=json_object('captured_at',datetime('now'),'rights',json((
  SELECT json_group_array(json_object('id',x.id,'verification_status',x.verification_status,
  'terms_version',x.terms_version,'attested_at',x.attested_at))
  FROM v3_track_rights x WHERE x.track_id=v3_track_releases.track_id
)))
WHERE id='release-a' AND status='ready_for_review'
''')
db.execute("UPDATE v3_tracks SET status='active',visibility='public' WHERE id='track-a'")
db.execute('''INSERT INTO v3_shareplace_entries
(id,track_id,owner_user_id,category,visibility,published_at)
VALUES ('sp-a','track-a',1,'Music','public',datetime('now'))''')
db.execute('''INSERT INTO v3_release_review_events
(id,release_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('re-a','release-a','track-a',2,'approved','Approved after rights verification')''')
snap = json.loads(db.execute("SELECT rights_snapshot_json FROM v3_track_releases WHERE id='release-a'").fetchone()[0])
assert snap['rights'][0]['verification_status'] == 'verified'
assert db.execute("SELECT status FROM v3_tracks WHERE id='track-a'").fetchone()[0] == 'active'
assert db.execute("SELECT visibility FROM v3_shareplace_entries WHERE track_id='track-a'").fetchone()[0] == 'public'
fails('''INSERT INTO v3_rights_review_events
(id,rights_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('rr-duplicate','rights-a','track-a',2,'verified','Duplicate decision')''')
fails('''INSERT INTO v3_release_review_events
(id,release_id,track_id,reviewer_user_id,decision,review_note)
VALUES ('re-duplicate','release-a','track-a',2,'approved','Duplicate decision')''')

# Verified rights cannot publish a TL3 release backed by a local-only TL3 asset.
db.execute("INSERT INTO v3_tracks(id,owner_user_id) VALUES ('track-b',1)")
db.execute('''INSERT INTO v3_track_rights
(id,track_id,claimant_user_id,rights_role,terms_version,attested_at,verification_status)
VALUES ('rights-b','track-b',1,'composer','creator-attestation-v1',datetime('now'),'verified')''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,availability_status,created_by,mime_type)
VALUES ('source-b','track-b','mp3_audio','local_agent','local_only',1,'audio/mpeg')''')
db.execute('''INSERT INTO v3_track_assets
(id,track_id,asset_type,storage_provider,availability_status,created_by,mime_type)
VALUES ('asset-b','track-b','tl3_release_file','local_agent','local_only',1,'application/octet-stream')''')
db.execute('''INSERT INTO v3_track_releases
(id,track_id,release_type,version,status,asset_id,source_asset_id,price_tl)
VALUES ('release-b','track-b','TL3',1,'ready_for_review','asset-b','source-b',120)''')
fails("UPDATE v3_track_releases SET status='published' WHERE id='release-b'")

print("V3 review validation passed: unverified rights cannot publish; verified rights plus a matching available TL3 Asset permit approval; rights snapshots, SharePlace state, and immutable review audit are enforced.")
print('V3 review validation passed: rights verification, matching available TL3/source Assets, rights snapshots, SharePlace state, and immutable review audit are enforced.')

