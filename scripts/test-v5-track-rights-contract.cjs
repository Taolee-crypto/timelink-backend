'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const manufacture=fs.readFileSync('src/routes/tl3-v5.ts','utf8');
const discovery=fs.readFileSync('src/routes/music-discovery.ts','utf8');
const identity=fs.readFileSync('src/v5-recording-identity.ts','utf8');
for(const text of ['findRegisteredRecordingDuplicate','sourceSha256:sourceHash','canonicalIsrc','TRACK_ALREADY_REGISTERED','recordRecordingIdentity'])
 assert.ok(manufacture.includes(text),'manufacture duplicate gate missing '+text);
assert.ok(manufacture.indexOf('findRegisteredRecordingDuplicate')<manufacture.indexOf('putD1Object(c.env.DB, objectKey'),
 'duplicate gate must execute before sealed container storage');
for(const text of ['TRACK_ALREADY_REGISTERED','COMPETING_RIGHTS_CLAIM','settlement_enabled:false','playable:false','public:false'])
 assert.ok(discovery.includes(text),'rights review fail-closed contract missing '+text);
assert.match(identity,/source_sha256/);assert.match(identity,/isrc_norm/);
assert.match(identity,/tl_creator_spotify_metadata/);
console.log('PASS V5 creator rights contract: exact source fingerprint + ISRC duplicate gate precedes manufacture; private approval never auto-publishes');
