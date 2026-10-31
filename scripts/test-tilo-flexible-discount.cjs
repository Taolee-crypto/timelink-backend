const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {buildSync} = require('esbuild');
const {spawnSync} = require('node:child_process');

// Bundle the exact production TypeScript helper and arithmetic without a Worker.
const built = buildSync({
  entryPoints: [path.join(__dirname, '../src/tilo-v5-airtime-audit.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false
});
const compiled = {exports: {}};
new Function('module', 'exports', built.outputFiles[0].text)(compiled, compiled.exports);
const {auditPersistedTiloAirtime: audit} = compiled.exports;

for(const coefficient of [0, 1, 1250, 3000, 5300, 7750, 10000]){
  for(const ms of [1, 333, 1000, 1001, 167_029, 3_600_000]){
    const total = (BigInt(ms) * BigInt(coefficient)) / 1000n;
    const creator = total * 7n / 10n;
    const row = {
      audible_ms: ms, creator_atoms: Number(creator),
      platform_atoms: Number(total - creator),
      discount_coefficient_bps: coefficient, discount_revision: 4
    };
    const reviewed = audit(row);
    assert.equal(reviewed.totalAtoms, total);
    assert.equal(reviewed.hasPolicySnapshot, true);
    assert.equal(audit({...row, discount_coefficient_bps: null, discount_revision: null}).hasPolicySnapshot, false);
    if(coefficient > 0 && total > 0n)
      assert.throws(() => audit({...row, creator_atoms: row.creator_atoms + 1}), /AIRTIME_AMOUNT_MISMATCH/);
  }
}
// Historical rows cannot be repriced using today's discount coefficient.
assert.equal(audit({audible_ms: 1000, creator_atoms: 2100, platform_atoms: 900}).totalAtoms, 3000n);
assert.equal(audit({audible_ms: 1000, creator_atoms: 3500, platform_atoms: 1500}).totalAtoms, 5000n);
assert.throws(()=>audit({audible_ms: 1000, creator_atoms: 2100, platform_atoms: 900,
  discount_coefficient_bps: 6000, discount_revision: 1}), /AIRTIME_AMOUNT_MISMATCH/);
assert.throws(()=>audit({audible_ms: 1000, creator_atoms: 2100, platform_atoms: 900,
  discount_coefficient_bps: 3000}), /INVALID_DISCOUNT_SNAPSHOT/);
assert.throws(()=>audit({audible_ms: 1000, creator_atoms: 2101, platform_atoms: 899}), /AIRTIME_AMOUNT_MISMATCH/);
assert.throws(()=>audit({audible_ms: 1000, creator_atoms: 7001, platform_atoms: 3000}), /AIRTIME_AMOUNT_MISMATCH/);
assert.throws(()=>audit({audible_ms: 0, creator_atoms: 0, platform_atoms: 0}), /INVALID_STORED_AIRTIME/);
assert.throws(()=>audit({audible_ms: 1000, creator_atoms: -1, platform_atoms: 1}), /INVALID_STORED_AIRTIME/);

// Both administrator candidate and posting-readiness must use the same audit.
const route=fs.readFileSync(path.join(__dirname,'../src/routes/tilo-v5-approvals.ts'),'utf8');
assert.match(route, /auditPersistedTiloAirtime\(e\)/);
assert.equal((route.match(/auditPersistedTiloAirtime\(e\)/g)||[]).length, 2);
assert.doesNotMatch(route, /ms\s*\*\s*3n/);
const ingestion=fs.readFileSync(path.join(__dirname,'../src/routes/central-broadcast-v5.ts'),'utf8');
assert.match(ingestion, /discount_coefficient_bps,discount_revision/);

// SQLite migration verification: legacy evidence survives and prospective evidence stores policy.
const script = String.raw`
import sqlite3, pathlib
db=sqlite3.connect(':memory:')
db.executescript(pathlib.Path('migrations/20261024_tilo_v5_airtime_settlement.sql').read_text())
db.execute("INSERT INTO tilo_v5_verified_airtime(event_id,country,service_id,creator_id,file_id,started_at,ended_at,local_month,audible_ms,creator_atoms,platform_atoms,evidence_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ['old','KR','central-tilo-1',1,1,'2026-10-30T00:00:00Z','2026-10-30T00:00:01Z','2026-10',1000,2100,900,'a'*64])
db.executescript(pathlib.Path('migrations/20261031_tilo_v5_airtime_discount_snapshot.sql').read_text())
assert db.execute('SELECT discount_coefficient_bps,discount_revision FROM tilo_v5_verified_airtime').fetchone() == (None,None)
db.execute("INSERT INTO tilo_v5_verified_airtime(event_id,country,service_id,creator_id,file_id,started_at,ended_at,local_month,audible_ms,creator_atoms,platform_atoms,evidence_digest,discount_coefficient_bps,discount_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ['new','KR','central-tilo-1',1,1,'2026-10-30T00:00:01Z','2026-10-30T00:00:02Z','2026-10',1000,3500,1500,'b'*64,5000,2])
assert db.execute('SELECT discount_coefficient_bps,discount_revision FROM tilo_v5_verified_airtime WHERE event_id=?',('new',)).fetchone() == (5000,2)
print('PASS TILO discount evidence migration and legacy retention')
`;
const python=spawnSync('python3',['-c',script],{encoding:'utf8'});
assert.equal(python.status,0,python.stderr||python.stdout);
process.stdout.write(python.stdout);
console.log('PASS TILO elastic discount: 70/30, 0-100% coefficient, historical immutability, settlement audits');
