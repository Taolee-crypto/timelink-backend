'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync('src/tilo-station.ts','utf8');
const match=source.match(/db\.prepare\(`([\s\S]*?)`\)/);
assert.ok(match,'read production station SQL');
const sql=match[1];
assert.match(sql,/EXISTS\(SELECT 1 FROM central_broadcast_rights_grants rg/);
assert.match(sql,/EXISTS\(SELECT 1 FROM central_broadcast_service_file_grants sg/);
const test=String.raw`
import sqlite3,sys,json
q=json.loads(sys.stdin.read())
db=sqlite3.connect(':memory:')
db.executescript("""
CREATE TABLE central_broadcast_service_accounts(service_id TEXT,parent_admin_user_id INTEGER,status TEXT);
CREATE TABLE central_broadcast_service_file_grants(service_id TEXT,file_id INTEGER,country TEXT,status TEXT,permission TEXT,expires_at TEXT);
CREATE TABLE central_broadcast_rights_grants(file_id INTEGER,creator_id INTEGER,country TEXT,status TEXT,expires_at TEXT);
CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT,duration_ms INTEGER);
CREATE TABLE tl_files(id INTEGER,title TEXT,artist TEXT,shared INTEGER,file_type TEXT,revenue_held INTEGER);
CREATE TABLE tl_creator_metadata(file_id INTEGER,user_id INTEGER,rights_declared INTEGER,rights_role TEXT,rights_scope TEXT,declaration_status TEXT);
INSERT INTO central_broadcast_service_accounts VALUES('central-tilo-33',33,'active');
INSERT INTO tl3_v5_releases VALUES(147,33,'sealed',302360);
INSERT INTO tl_files VALUES(147,'Track','Artist',1,'audio/tl3',0);
INSERT INTO tl_creator_metadata VALUES(147,33,1,'owner','master_recording','declared');
""")
def rows(country='KR',admin=None):
 return db.execute(q,[admin,admin,country,country,country,country]).fetchall()
assert rows()==[],'A published track without broadcaster grant MUST NOT be on air'
db.execute("INSERT INTO central_broadcast_rights_grants VALUES(147,33,'KR','active',NULL)")
assert rows()==[],'Creator license alone does not grant a station access'
db.execute("INSERT INTO central_broadcast_service_file_grants VALUES('central-tilo-33',147,'KR','active','stream',NULL)")
assert len(rows())==1,'Both country and service rights authorize V5 station listing'
assert not rows('JP'),'KR broadcast rights must NOT authorize JP (or any other country)'
assert not rows(admin=34),'A different administrator must not reuse the service identity'
db.execute("INSERT INTO central_broadcast_rights_grants VALUES(147,33,'JP','active',NULL)")
assert not rows('JP'),'JP creator permission alone is insufficient'
db.execute("INSERT INTO central_broadcast_service_file_grants VALUES('central-tilo-33',147,'JP','active','stream',NULL)")
assert len(rows('JP'))==1,'Full JP license and service grant allow JP'
for table,condition,assignment in [
 ('tl_files','id=147','shared=0'),
 ('tl_files','id=147','revenue_held=1'),
 ('tl_files','id=147',"file_type='audio/mp3'"),
 ('tl3_v5_releases','file_id=147',"status='revoked'"),
 ('tl3_v5_releases','file_id=147','duration_ms=0'),
 ('tl_creator_metadata','file_id=147',"declaration_status='rejected'"),
 ('tl_creator_metadata','file_id=147','user_id=34'),
 ('central_broadcast_service_accounts',"service_id='central-tilo-33'","status='disabled'"),
 ('central_broadcast_service_file_grants',"country='KR'","expires_at='2000-01-01'"),
 ('central_broadcast_service_file_grants',"country='KR'","status='revoked'"),
 ('central_broadcast_service_file_grants',"country='KR'","permission='download'"),
 ('central_broadcast_rights_grants',"country='KR'","expires_at='2000-01-01'"),
 ('central_broadcast_rights_grants',"country='KR'","status='revoked'")
]:
 db.execute('SAVEPOINT scenario')
 db.execute('UPDATE '+table+' SET '+assignment+' WHERE '+condition)
 assert not rows(),(table,assignment,'must fail closed')
 db.execute('ROLLBACK TO scenario')
 db.execute('RELEASE scenario')
db.execute("INSERT INTO central_broadcast_rights_grants VALUES(147,33,'KR','revoked',NULL)")
assert not rows(),'Any revocation must deny even with a separate active grant'
db.execute("DELETE FROM central_broadcast_rights_grants WHERE country='KR' AND status='revoked'")
db.execute("INSERT INTO central_broadcast_service_accounts VALUES('central-tilo-34',34,'active')")
db.execute("INSERT INTO tl3_v5_releases VALUES(148,34,'sealed',300000)")
db.execute("INSERT INTO tl_files VALUES(148,'Other Track','Other',1,'audio/tl3',0)")
db.execute("INSERT INTO tl_creator_metadata VALUES(148,34,1,'owner','master_recording','approved')")
db.execute("INSERT INTO central_broadcast_rights_grants VALUES(148,34,'KR','active',NULL)")
assert not any(r[0]==148 for r in rows(admin=33)),'No unrelated creator enters admin 33 station without service grant'
assert len(rows(admin=33))==1
print('PASS TILO territorial station licensing: explicit grants, owner scoping, revocations and independent country gates')
`;
const p=spawnSync('python3',['-c',test],{input:JSON.stringify(sql),encoding:'utf8'});
process.stdout.write(p.stdout);
process.stderr.write(p.stderr);
if(p.status)process.exit(p.status||1);
