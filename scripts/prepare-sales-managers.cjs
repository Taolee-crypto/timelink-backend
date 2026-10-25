#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const wrangler=require.resolve('wrangler/bin/wrangler.js');
function run(args){const p=spawnSync(process.execPath,[wrangler,'d1','execute','timelink-db','--remote',...args],{encoding:'utf8',maxBuffer:4*1024*1024});if(p.status!==0)throw Error(p.stderr+'\n'+p.stdout);return p.stdout;}
run(['--file','migrations/20261026_sales_managers.sql']);
run(['--file','migrations/20261026_sales_finance.sql']);
const data=JSON.parse(run(['--command',"SELECT name FROM sqlite_master WHERE name LIKE 'v5_sales_%'",'--json']));
const names=new Set(data.flatMap(x=>x.results||[]).map(x=>x.name));
for(const name of ['v5_sales_policy','v5_sales_members','v5_sales_contract_immutable','v5_sales_stores','v5_sales_store_events','v5_sales_payments','v5_sales_meters','v5_sales_channel_requests','v5_sales_settlements','v5_sales_settlement_items','v5_sales_settlement_events'])if(!names.has(name))throw Error('Sales schema missing: '+name);
console.log('Sales onboarding, immutable contracts and store assignment storage ready. No cash receipt, member approval or TL settlement created.');
