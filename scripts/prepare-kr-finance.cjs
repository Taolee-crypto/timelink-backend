#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const wrangler=require.resolve('wrangler/bin/wrangler.js');
function run(args){const p=spawnSync(process.execPath,[wrangler,'d1','execute','timelink-db','--remote',...args],{encoding:'utf8',maxBuffer:4*1024*1024});if(p.status!==0)throw Error(p.stderr+'\n'+p.stdout);return p.stdout;}
run(['--file','migrations/20261026_kr_finance_accounting.sql']);
const data=JSON.parse(run(['--command',"SELECT name FROM sqlite_master WHERE name LIKE 'v5_kr_%'",'--json']));
const names=new Set(data.flatMap(x=>x.results||[]).map(x=>x.name));
for(const name of ['v5_kr_accounts','v5_kr_policy','v5_kr_journals','v5_kr_lines','v5_kr_tax_profiles','v5_kr_seal_guard','v5_kr_journal_immutable_update','v5_kr_line_immutable_insert','v5_kr_periods'])if(!names.has(name))throw Error('KR schema missing: '+name);
console.log('KR accounting storage and immutable posting guards ready. No TL balance, financial journal or tax liability posted.');
