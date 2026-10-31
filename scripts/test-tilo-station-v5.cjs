'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const station=fs.readFileSync('src/tilo-station.ts','utf8');
const match=station.match(/db\.prepare\(`([\s\S]*?)`\)/);
assert.ok(match,'must use production station inventory SQL');
const sql=match[1];
assert.match(sql,/JOIN tl3_v5_releases v ON v.status='sealed'/);
assert.match(sql,/tl_creator_metadata cm/);
assert.match(sql,/NOT EXISTS\(SELECT 1 FROM central_broadcast_rights_grants/);
assert.match(sql,/NOT EXISTS\(SELECT 1 FROM central_broadcast_service_file_grants/);
assert.doesNotMatch(sql,/AND EXISTS\(SELECT 1 FROM central_broadcast_rights_grants rg/,'the station must not require a second grant before honoring creator promotion');
assert.doesNotMatch(sql,/AND EXISTS\(SELECT 1 FROM central_broadcast_service_file_grants sg/,'optional admin service grants are not prerequisites for an ordinary rights-declared track');
const test=String.raw`
import sqlite3,json,sys
sql=json.loads(sys.stdin.read())
db=sqlite3.connect(':memory:')
db.executescript("""
CREATE TABLE central_broadcast_service_accounts(service_id TEXT,parent_admin_user_id INTEGER,status TEXT);
CREATE TABLE central_broadcast_service_file_grants(service_id TEXT,file_id INTEGER,country TEXT,status TEXT,permission TEXT,expires_at TEXT);
CREATE TABLE central_broadcast_rights_grants(file_id INTEGER,creator_id INTEGER,country TEXT,status TEXT,expires_at TEXT);
CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT,duration_ms INTEGER);
CREATE TABLE tl_files(id INTEGER,title TEXT,artist TEXT,shared INTEGER,file_type TEXT,revenue_held INTEGER);
CREATE TABLE tl_creator_metadata(file_id INTEGER,user_id INTEGER,rights_declared INTEGER,rights_role TEXT,rights_scope TEXT,declaration_status TEXT);
INSERT INTO central_broadcast_service_accounts VALUES('central-tilo-33',33,'active');
INSERT INTO tl3_v5_releases VALUES(147,33,'sealed',302360),(148,34,'sealed',180000);
INSERT INTO tl_files VALUES(147,'TILO promoter','Artist A',1,'audio/tl3',0),(148,'Ordinary creator','Artist B',1,'audio/tl3',0);
INSERT INTO tl_creator_metadata VALUES(147,33,1,'owner','master_recording','declared'),(148,34,1,'owner','master_recording','declared');
""")
def rows(country='KR',admin=33):
 return db.execute(sql,[admin,admin,country,country]).fetchall()
assert [r[0] for r in rows()]==[147,148],'Promotion candidate and ordinary V5 creator inventory MUST survive with no redundant country grants'
assert [r[0] for r in rows('JP')]==[147,148],'No invented country restrictions; explicit withdrawal still overrides'
assert rows(admin=34)==[],'No other administrator service'
db.execute("INSERT INTO central_broadcast_rights_grants VALUES(147,33,'KR','revoked',NULL)")
assert [r[0] for r in rows()]==[148],'Explicit territorial revocation blocks the affected song'
assert [r[0] for r in rows('JP')]==[147,148],'KR withdrawal must not restrict JP'
db.execute("DELETE FROM central_broadcast_rights_grants")
db.execute("INSERT INTO central_broadcast_service_file_grants VALUES('central-tilo-33',148,'KR','revoked','stream',NULL)")
assert [r[0] for r in rows()]==[147],'Explicit service revocation blocks only its song'
db.execute("DELETE FROM central_broadcast_service_file_grants")
for table,condition,assignment in [
 ('tl_files','id=147','shared=0'),
 ('tl_files','id=147','revenue_held=1'),
 ('tl_files','id=147',"file_type='audio/mp3'"),
 ('tl3_v5_releases','file_id=147',"status='revoked'"),
 ('tl3_v5_releases','file_id=147','duration_ms=0'),
 ('tl_creator_metadata','file_id=147',"declaration_status='rejected'"),
 ('tl_creator_metadata','file_id=147','rights_declared=0'),
 ('central_broadcast_service_accounts',"service_id='central-tilo-33'","status='disabled'")
]:
 db.execute('SAVEPOINT scenario')
 db.execute('UPDATE '+table+' SET '+assignment+' WHERE '+condition)
 assert not any(r[0]==147 for r in rows()),(table,assignment,'must not pass')
 db.execute('ROLLBACK TO scenario')
 db.execute('RELEASE scenario')
db.execute("INSERT INTO central_broadcast_rights_grants VALUES(147,33,'KR','active','2000-01-01')")
assert [r[0] for r in rows()]==[148],'Expired rights explicitly registered must fail closed'
print('PASS TILO promotion-first mixed eligible pool restored; revoked/expired/held V5 blocked; local service scoped')
`;
const p=spawnSync('python3',['-c',test],{input:JSON.stringify(sql),encoding:'utf8'});
process.stdout.write(p.stdout||'');
process.stderr.write(p.stderr||'');
if(p.status!==0)process.exit(p.status||1);
