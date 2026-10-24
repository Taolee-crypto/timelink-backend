// Regression checks for V5 TILO settlement arithmetic; no D1 writes or payout calls.
// Run: node scripts/test-tilo-v5-contribution.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {transformSync}=require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/central-broadcast-v5-settlement.ts'), 'utf8');
const compiled = transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code;
const exportsObj = {};
const moduleObj={exports:exportsObj};
vm.runInNewContext(compiled, { exports: exportsObj, module:moduleObj, Intl, Date, Set, Map, BigInt, Number, RangeError }, { timeout: 2000 });
const { calculateCentralBroadcastAtoms: allocation, calculateTiloCreatorMonthlyContribution: monthly,
  calculateTiloCreatorContributionDelta: delta, tiloCreatorRedemptionRateBps: redemption } = moduleObj.exports;
const TL = 10000n;
assert.deepEqual([...Object.values(allocation(1000n))], [3000n,2100n,900n]);
assert.equal(monthly(100000n*TL).contributionAtoms,0n);
assert.equal(monthly(100001n*TL).contributionAtoms,500n);
assert.equal(monthly(500000n*TL).contributionAtoms,20000n*TL);
assert.equal(monthly(2000000n*TL).contributionAtoms,170000n*TL);
assert.equal(monthly(5000000n*TL).contributionAtoms,620000n*TL);
assert.equal(monthly(5000001n*TL).contributionAtoms,620000n*TL+2000n);
for (const [before, added] of [[0n,100000n],[99999n,2n],[499999n,2n],[1999999n,2n],[4999999n,2n]]) {
  const a=delta(before*TL,added*TL);
  assert.equal(a.additionalContributionAtoms,monthly((before+added)*TL).contributionAtoms-monthly(before*TL).contributionAtoms);
  assert.equal(a.newlySettledNetAtoms+a.additionalContributionAtoms,added*TL);
}
assert.deepEqual([0.1,1,2,3,4,5].map(redemption),[1000,2000,4000,6000,8000,8000]);
assert.throws(()=>redemption(0));
assert.throws(()=>monthly(-1n));
assert.throws(()=>delta(0n,-1n));
console.log('TILO V5 contribution invariants: PASS');
