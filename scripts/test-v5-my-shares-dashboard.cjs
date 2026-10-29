'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');

// Exercise the exact owner-only SQL embedded in the production Worker route.
const src=fs.readFileSync('src/index.ts','utf8');
const routeStart=src.indexOf("app.get('/api/shares/my', async (c) => {");
const routeEnd=src.indexOf("app.get('/api/shares/:id/my-tl'",routeStart);
assert.ok(routeStart>0&&routeEnd>routeStart);
const route=src.slice(routeStart,routeEnd);
assert.match(route,/await shareAuthUser\(c\)/);
assert.match(route,/if\(!userId\) return c\.json\(\{error:'인증 필요'\},401\)/);
assert.match(route,/Cache-Control','private, no-store'/);
assert.match(route,/owner_scoped:true/);
assert.doesNotMatch(route,/SELECT[^;]*stream_url|SELECT[^;]*origin_hash/);
const sqlMatch=route.match(/\x60(SELECT id,title,artist,album,duration,file_tl,[\s\S]*?ORDER BY created_at DESC LIMIT \? OFFSET \?)\x60/);
assert.ok(sqlMatch,'owner-only share SQL missing');
const sql=sqlMatch[1];
const db=new DatabaseSync(':memory:');
try{
 db.exec(`CREATE TABLE tl_shares(
 id TEXT PRIMARY KEY,user_id INTEGER,title TEXT,artist TEXT,album TEXT,
 duration INTEGER,file_tl INTEGER,category TEXT,file_type TEXT,category_type TEXT,
 description TEXT,cover_url TEXT,content_kind TEXT,release_mode TEXT,pulse INTEGER,
 created_at INTEGER,stream_url TEXT,origin_hash TEXT);
 CREATE TABLE tl_files(id INTEGER PRIMARY KEY,user_id INTEGER,title TEXT,artist TEXT,
 genre TEXT,file_type TEXT,file_size_bytes INTEGER,duration_seconds INTEGER,
 auth_status TEXT,shared INTEGER,play_count INTEGER,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE tl3_v5_releases(share_id TEXT,file_id INTEGER,status TEXT,updated_at TEXT);
 CREATE TABLE tl3_spine_v4_releases(share_id TEXT,file_id INTEGER,status TEXT);
 CREATE TABLE tl3_releases(share_id TEXT,file_id INTEGER,status TEXT);
 INSERT INTO tl_shares(id,user_id,title,file_type,content_kind,pulse,created_at,stream_url,origin_hash)
 VALUES('own',2,'내 작품','audio/tl3','tl3',25,1,'SECRET-PRIVATE-URL','HASH-PRIVATE'),
       ('other',3,'다른 회원 작품','audio/tl3','tl3',90,2,'OTHER-SECRET','OTHER-HASH');
 INSERT INTO tl_files(id,user_id,title,auth_status,shared,play_count,created_at)
 VALUES(22,2,'나의 검증 음원','approved',1,3,1),
       (23,2,'나의 비공개 원본','pending',0,0,2),
       (33,3,'다른 회원 원본','approved',1,500,3);
 INSERT INTO tl3_v5_releases(share_id,file_id,status,updated_at)
 VALUES('own',22,'sealed','2026-10-29'),('other',33,'sealed','2026-10-29');`);
 const ours=db.prepare(sql).all(2,200,0);
 const others=db.prepare(sql).all(3,200,0);
 assert.equal(ours.length,1);assert.equal(ours[0].id,'own');
 assert.equal(ours[0].file_id,22);
 assert.equal(others.length,1);assert.equal(others[0].id,'other');
 assert.equal(ours[0].stream_url,undefined);
 assert.equal(ours[0].origin_hash,undefined);
 assert.deepEqual(db.prepare(sql).all(2,200,1),[]);
 const filesSQL=route.match(/"(SELECT id,title,artist,genre,file_type,file_size_bytes,duration_seconds,[^"]*?LIMIT \? OFFSET \?)"/);
 assert.ok(filesSQL,'private file inventory SQL missing');
 const privateItems=db.prepare(filesSQL[1]).all(2,200,0);
 assert.equal(privateItems.length,2);
 assert.equal(privateItems.find(x=>x.id===23).shared,0);
 assert.ok(privateItems.every(x=>x.id!==33));
 console.log('PASS owner-scoped personal share listing, file ID for verified release, private unpublished files, no stream URL and cross-user isolation');
}finally{db.close()}
