#!/usr/bin/env node
// Storage and funding guards only. Never inserts airtime or posts money.
const {spawnSync}=require('node:child_process');
const wrangler=require.resolve('wrangler/bin/wrangler.js');
const migrations=['20261024_tilo_v5_airtime_settlement.sql','20261024_tilo_v5_settlement_approvals.sql','20261024_tilo_v5_atomic_funding_guard.sql','20261025_tilo_v5_airtime_overlap_guard.sql'];
const required=['tilo_v5_verified_airtime','tilo_v5_monthly_settlement_checkpoints','tilo_v5_settlement_runs','tilo_v5_settlement_approvals','tilo_v5_settlement_approval_audit','tilo_v5_funding_nonnegative_update','tilo_v5_funding_nonnegative_insert','tilo_v5_airtime_no_overlap'];
function run(args){
 const p=spawnSync(process.execPath,[wrangler,'d1','execute','timelink-db','--remote',...args],{encoding:'utf8',maxBuffer:4*1024*1024});
 if(p.status!==0)throw Error('TILO schema command failed: '+p.stderr+'\n'+p.stdout);
 return p.stdout;
}
function prepare(){
 for(const name of migrations)run(['--file','migrations/'+name]);
 const data=JSON.parse(run(['--command',"SELECT name FROM sqlite_master WHERE name LIKE 'tilo_v5_%'",'--json']));
 if(!Array.isArray(data)||data.some(r=>r.success===false))throw Error('Invalid TILO schema result');
 const names=new Set(data.flatMap(r=>r.results||[]).map(r=>r.name));
 if(!required.every(n=>names.has(n)))throw Error('TILO schema incomplete');
 console.log('TILO evidence storage, review tables and funding guards verified; no settlement posted');
}
if(require.main===module){try{prepare()}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={prepare};
