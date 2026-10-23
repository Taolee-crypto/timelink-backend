#!/usr/bin/env node
// Local D1 SQL smoke, fail closed. Uses dedicated local state, never --remote.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const prod=fs.readFileSync('wrangler.toml','utf8');
const test=fs.readFileSync('wrangler.v5-test.toml','utf8');
const id=x=>x.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
assert(id(prod)&&id(test)&&id(prod)!==id(test),'production D1 binding detected');
assert.match(test,/ENVIRONMENT\s*=\s*"test"/);
const state='.wrangler/state/v5-ledger-ci';
fs.rmSync(state,{recursive:true,force:true});
const args=['wrangler','d1','execute','timelink-v5-ledger-test','--local','--config','wrangler.v5-test.toml','--persist-to',state,'--file','tests/v5/local-ledger-fixture.sql','--json'];
function run(){
 const p=spawnSync('npx',args,{encoding:'utf8',shell:process.platform==='win32',maxBuffer:4*1024*1024});
 if(p.status!==0)throw Error('local D1 command failed: '+p.stderr+'\n'+p.stdout);
 const output=p.stdout;
 if(!output.includes('PASS'))throw Error('D1 conservation check did not PASS: '+output);
 console.log('PASS local D1 conservation fixture');
}
run();run();console.log('PASS fixture replay remains idempotent');
