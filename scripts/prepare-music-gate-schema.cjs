#!/usr/bin/env node
// Explicit production migration step. Reruns verify readiness without repeating ALTERs.
const {spawnSync}=require('node:child_process');
const wrangler=require.resolve('wrangler/bin/wrangler.js');
function run(args){
  const p=spawnSync(process.execPath,[wrangler,'d1','execute','timelink-db','--remote',...args],
    {encoding:'utf8',maxBuffer:4*1024*1024});
  if(p.status!==0)throw Error('Music Gate schema command failed: '+p.stderr+'\n'+p.stdout);
  return p.stdout;
}
function query(sql){
  const value=JSON.parse(run(['--command',sql,'--json']));
  if(!Array.isArray(value)||value.some(r=>r.success===false))throw Error('Unexpected D1 result');
  return value.flatMap(r=>r.results||[]);
}
function prepare(){
  run(['--file','migrations/20261025_v5_ai_music_gate_reviews.sql']);
  const required=['analysis_token','analysis_lease_until','analysis_attempts','analysis_next_at','analysis_error','evidence_sha256'];
  const columns=new Set(query('PRAGMA table_info(v5_music_gate_reviews)').map(r=>r.name));
  const found=required.filter(name=>columns.has(name));
  if(found.length===0)run(['--file','migrations/20261025_v5_music_gate_analysis_worker.sql']);
  else if(found.length!==required.length)throw Error('Partial Music Gate migration; manual recovery required');
  const after=new Set(query('PRAGMA table_info(v5_music_gate_reviews)').map(r=>r.name));
  if(!required.every(name=>after.has(name)))throw Error('Music Gate schema verification failed');
  const names=query("SELECT name FROM sqlite_master WHERE name IN ('v5_music_gate_audit','v5_music_gate_audit_insert','v5_music_gate_audit_transition','v5_music_gate_audit_no_update','v5_music_gate_audit_no_delete')");
  if(names.length!==5)throw Error('Music Gate audit schema incomplete');
  console.log('Music Gate analysis and audit schema verified');
}
if(require.main===module){try{prepare()}catch(e){console.error(e.message);process.exitCode=1}}
module.exports={prepare};
