const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync('src/tilo-station.ts','utf8');
const sql=source.match(/db\.prepare\(`([\s\S]*?)`\)/)[1];
const test=String.raw`
import sqlite3,json,sys
q=json.loads(sys.stdin.read())
db=sqlite3.connect(':memory:')
db.executescript('''
CREATE TABLE central_broadcast_service_accounts(service_id TEXT,parent_admin_user_id INTEGER,status TEXT);
CREATE TABLE central_broadcast_service_file_grants(service_id TEXT,file_id INTEGER,country TEXT,status TEXT,expires_at TEXT);
CREATE TABLE central_broadcast_rights_grants(file_id INTEGER,creator_id INTEGER,country TEXT,status TEXT,expires_at TEXT);
CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT,duration_ms INTEGER);
CREATE TABLE tl_files(id INTEGER,title TEXT,artist TEXT,shared INTEGER,file_type TEXT,revenue_held INTEGER);
CREATE TABLE tl_creator_metadata(file_id INTEGER,user_id INTEGER,rights_declared INTEGER,rights_role TEXT,rights_scope TEXT,declaration_status TEXT);
INSERT INTO central_broadcast_service_accounts VALUES('central-tilo-33',33,'active');
INSERT INTO central_broadcast_service_file_grants VALUES('central-tilo-33',147,'KR','active',NULL);
INSERT INTO central_broadcast_rights_grants VALUES(147,33,'KR','active',NULL);
INSERT INTO tl3_v5_releases VALUES(147,33,'sealed',302360);
INSERT INTO tl_files VALUES(147,'Track','Artist',1,'audio/tl3',0);
INSERT INTO tl_creator_metadata VALUES(147,33,1,'owner','master_recording','declared');
''')
def rows(country='KR',admin=None): return db.execute(q,[admin,admin,country,country]).fetchall()
assert len(rows())==1,'V5-only track must play without a legacy release row'
assert len(rows('JP'))==1,'ordinary public tracks do not need a premium or per-country purchase'
db.execute('SAVEPOINT no_grants');db.execute('DELETE FROM central_broadcast_service_file_grants');db.execute('DELETE FROM central_broadcast_rights_grants');assert len(rows())==1,'ordinary tracks must play without purchase grants';db.execute('ROLLBACK TO no_grants');db.execute('RELEASE no_grants')
assert not rows(admin=34),'service owner must match'
for table,assignment in [('tl_files','shared=0'),('tl_files','revenue_held=1'),('tl3_v5_releases',"status='revoked'"),('tl_creator_metadata',"declaration_status='rejected'"),('tl_creator_metadata','user_id=34'),('central_broadcast_service_accounts',"status='disabled'"),('central_broadcast_service_file_grants',"expires_at='2000-01-01'"),('central_broadcast_rights_grants',"status='revoked'")]:
 db.execute('SAVEPOINT scenario')
 db.execute('UPDATE '+table+' SET '+assignment)
 assert not rows(), table+' must fail closed'
 db.execute('ROLLBACK TO scenario');db.execute('RELEASE scenario')
print('PASS V5-only station playback, country scope, revocation, dispute and declaration guards')
`;
const p=spawnSync('python',['-c',test],{input:JSON.stringify(sql),encoding:'utf8'});
process.stdout.write(p.stdout);process.stderr.write(p.stderr);if(p.status)process.exit(p.status);
