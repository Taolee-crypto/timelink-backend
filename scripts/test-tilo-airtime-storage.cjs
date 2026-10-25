const {spawnSync}=require('node:child_process');
const test=String.raw`
import sqlite3,pathlib
db=sqlite3.connect(':memory:')
for _ in range(2):
 for path in ['20261024_tilo_v5_airtime_settlement.sql','20261024_tilo_v5_settlement_approvals.sql','20261025_tilo_v5_airtime_overlap_guard.sql']:
  db.executescript(pathlib.Path('migrations/'+path).read_text())
sql='INSERT OR IGNORE INTO tilo_v5_verified_airtime(event_id,country,service_id,creator_id,file_id,started_at,ended_at,local_month,audible_ms,creator_atoms,platform_atoms,evidence_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
def add(event,start,end,country='KR',file=147):
 db.execute(sql,[event,country,'central-tilo-33',33,file,'2026-10-25T'+start+'Z','2026-10-25T'+end+'Z','2026-10',1000,2100,900,'a'*64])
add('original','01:00:00','01:00:01')
add('original','01:00:00','01:00:01')
assert db.execute('SELECT COUNT(*) FROM tilo_v5_verified_airtime').fetchone()[0]==1
for start,end,file in [('01:00:00','01:00:01',147),('01:00:00.500','01:00:01.500',148)]:
 try:
  add('duplicate-'+str(file),start,end,file=file)
  raise AssertionError('overlap accepted')
 except sqlite3.IntegrityError as e: assert 'TILO_AIRTIME_INTERVAL_OVERLAP' in str(e)
add('adjacent','01:00:01','01:00:02')
add('other-country','01:00:00','01:00:01',country='JP')
assert db.execute('SELECT COUNT(*) FROM tilo_v5_verified_airtime').fetchone()[0]==3
assert db.execute('SELECT COUNT(*) FROM tilo_v5_settlement_approvals').fetchone()[0]==0
print('PASS TILO storage: migration replay, event replay, duplicate/overlap rejection, adjacent/country intervals, no automatic payout')
`;
const p=spawnSync('python',['-c',test],{encoding:'utf8'});process.stdout.write(p.stdout);process.stderr.write(p.stderr);if(p.status)process.exit(p.status);
