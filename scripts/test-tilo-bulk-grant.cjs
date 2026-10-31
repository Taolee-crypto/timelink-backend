'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync('src/routes/admin.ts','utf8');
const start=source.indexOf("router.post('/central-broadcast/stations/:country/grants/bulk'");
const end=source.indexOf("/** Read-only candidate audit",start);
assert.ok(start>0&&end>start);
const section=source.slice(start,end);
for(const re of [/requireAdmin\(c\)/,/body\?\.rights_confirmed!==true/,/ids\.length>60/,/new Set\(ids\)\.size/,/v\.user_id=\? AND f\.user_id=\?/,/central_broadcast_rights_grants/,/central_broadcast_service_file_grants/,/tilo_v5_country_grant_audit/,/c\.env\.DB\.batch\(statements\)/,/BROADCAST_BULK_GRANT_FAILED/]){
 assert.match(section,re);
}
assert.doesNotMatch(section,/postLedgerTransaction|TL_BALANCE|creator_reward|mineTlc/i);
const match=section.match(/const allowed=await c\.env\.DB\.prepare\(`([\s\S]*?)`/);
assert.ok(match);
const sql=match[1].replaceAll('${placeholders}','?,?,?');
const py=String.raw`
import sqlite3,sys
db=sqlite3.connect(':memory:')
db.executescript("""
CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,status TEXT);
CREATE TABLE tl_files(id INTEGER,user_id INTEGER,shared INTEGER,file_type TEXT,revenue_held INTEGER);
CREATE TABLE tl_creator_metadata(file_id INTEGER,user_id INTEGER,rights_declared INTEGER,rights_role TEXT,rights_scope TEXT,declaration_status TEXT);
CREATE TABLE central_broadcast_rights_grants(file_id INTEGER,creator_id INTEGER,country TEXT,status TEXT,expires_at TEXT);
CREATE TABLE central_broadcast_service_file_grants(service_id TEXT,file_id INTEGER,country TEXT,status TEXT,expires_at TEXT);
INSERT INTO tl3_v5_releases VALUES (201,33,'sealed'),(202,33,'sealed'),(203,34,'sealed');
INSERT INTO tl_files VALUES (201,33,1,'audio/tl3',0),(202,33,1,'audio/tl3',0),(203,34,1,'audio/tl3',0);
INSERT INTO tl_creator_metadata VALUES (201,33,1,'owner','master_recording','declared'),(202,33,1,'owner','master_recording','approved'),(203,34,1,'owner','master_recording','approved');
""")
sql=sys.stdin.read()
def rows(country='KR'):
 return db.execute(sql,[201,202,203,33,33,country,'central-tilo-33',country]).fetchall()
assert len(rows())==2,rows()
db.execute("INSERT INTO central_broadcast_rights_grants VALUES (201,33,'KR','revoked',NULL)")
assert len(rows())==1,'Revoked territory must be denied'
assert len(rows('JP'))==2,'Territorial grant must not leak between countries'
db.execute("UPDATE tl_files SET revenue_held=1 WHERE id=202")
assert len(rows())==0,'Held audio must be denied after revocation'
print('PASS TILO bulk owner-rights SQL: no other creator, no revoked country, no held recording')
`;
const p=spawnSync('python3',['-c',py],{encoding:'utf8',input:sql});
assert.equal(p.status,0,p.stderr||p.stdout);
process.stdout.write(p.stdout);
console.log('PASS TILO bulk country approval: explicit consent, max size, owner security, D1 batch, audit');
