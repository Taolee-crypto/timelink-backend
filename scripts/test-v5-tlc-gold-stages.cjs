'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tlc-two-stage-'));
try{
 buildSync({stdin:{contents:"export * from './src/v5-tlc-mining-split';",loader:'ts',resolveDir:process.cwd()},
  outfile:path.join(dir,'check.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const policy=require(path.join(dir,'check.cjs'));
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.fixed_max_supply,null);
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.group_mining_share_bps,5000);
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.member_mining_share_bps,5000);
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.automatic_gold_conversion,false);
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.direct_tlc_gold_redemption_guaranteed,false);
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.gold_custody_verified,false);
 assert.equal(policy.TLC_TWO_STAGE_VALUE_POLICY.gold_grams_verified,0);
 assert.match(policy.TLC_TWO_STAGE_VALUE_POLICY.permissible_future_conversion,/retirement_or_counterparty_lock/);
 assert.equal(policy.TLC_RESERVE_BUCKET,'permanent_value_reserve_locked');
 assert.equal(policy.splitMinedTlcAtoms(100000000000).memberAtoms,50000000000);
 assert.equal(policy.splitMinedTlcAtoms(100000000000).groupAtoms,50000000000);
 assert.equal(policy.splitMinedTlcAtoms(5).memberAtoms,2);
 assert.equal(policy.splitMinedTlcAtoms(5).groupAtoms,3);
 console.log('PASS: no fixed supply; gross 50/50; locked group half, no automatic gold trade or unproven backing');
}finally{fs.rmSync(dir,{force:true,recursive:true})}
