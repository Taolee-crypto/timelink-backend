'use strict';
const assert=require('node:assert/strict');
const {perform,classifyAccountIntegrity,UNBALANCED_SQL,HEALTH_SQL}=require('./v5-d1-accounting-audit.cjs');
const legacy=[
 {transaction_id:'8ae5aadd-e85d-4c38-9aca-2ef2e0b003e3',asset_code:'TL',transaction_type:'admin_adjustment',count:1,delta:10000000000},
 {transaction_id:'6cde8940-148e-4fb9-bba2-a5d7900a6d79',asset_code:'TL',transaction_type:'admin_adjustment',count:1,delta:1000000000},
 {transaction_id:'8252188e-8db3-4f45-bc6d-e1ffb4d12260',asset_code:'TL',transaction_type:'admin_adjustment',count:1,delta:1000000000},
 {transaction_id:'e4ef5195-f43f-4476-8044-50e28f081331',asset_code:'TL',transaction_type:'admin_adjustment',count:1,delta:1000000000}
];
const known=classifyAccountIntegrity({quickCheck:'ok',unbalanced:legacy});
assert.equal(known.ok,true);assert.equal(known.ledger_is_fully_balanced,false);
assert.equal(known.status,'historic_manual_review_required');
assert.equal(known.historic_unbalanced_count,4);
assert.equal(known.historic_unbalanced_tl,1300000);
assert.equal(known.historical_reconciliation_performed,false);
assert.ok(!JSON.stringify(known).includes(legacy[0].transaction_id));
assert.equal(classifyAccountIntegrity({quickCheck:'ok',unbalanced:[]}).ledger_is_fully_balanced,true);
assert.equal(classifyAccountIntegrity({quickCheck:'damaged',unbalanced:legacy}).ok,false);
assert.equal(classifyAccountIntegrity({quickCheck:'ok',unbalanced:null}).ok,false);
assert.equal(classifyAccountIntegrity({quickCheck:'ok',unbalanced:legacy.map((r,i)=>i===0?{...r,delta:9000000000}:r)}).ok,false);
assert.equal(classifyAccountIntegrity({quickCheck:'ok',unbalanced:[...legacy,{...legacy[1],transaction_id:'new-leak'}]}).new_unbalanced_count,1);
(async()=>{
 const calls=[];
 const fetcher=async(_url,opts)=>{
  calls.push(JSON.parse(opts.body).sql);
  assert.equal(opts.method,'POST');
  assert.equal(opts.redirect,'error');
  const sql=JSON.parse(opts.body).sql;
  assert.ok([HEALTH_SQL,UNBALANCED_SQL].includes(sql));
  const rows=sql===HEALTH_SQL?[{quick_check:'ok'}]:legacy;
  return {ok:true,json:async()=>({success:true,result:[{results:rows}]})};
 };
 const out=await perform({accountId:'test',token:'private-fixture',fetcher});
 assert.equal(out.ok,true);assert.equal(out.historic_unbalanced_count,4);
 assert.deepEqual(calls,[HEALTH_SQL,UNBALANCED_SQL]);
 assert.ok(!JSON.stringify(out).includes('private-fixture'));
 console.log('PASS infra D1: SQLite check, immutable historic 4 mismatches, new mismatch alert, zero write SQL, sensitive transaction ID redacted');
})().catch(e=>{console.error(e);process.exitCode=1});
