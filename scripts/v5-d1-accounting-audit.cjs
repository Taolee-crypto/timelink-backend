'use strict';
/**
 * Read-only production D1 economic integrity check. POST /query must contain
 * SELECT only. NEVER apply historic "fixes", and never print customer IDs.
 */
const DATABASE_ID='7a61cb9f-d368-439e-b175-f3e958aeb84f';
const HISTORIC_MANUAL_ADJUSTMENTS=new Set([
 '8ae5aadd-e85d-4c38-9aca-2ef2e0b003e3',
 '6cde8940-148e-4fb9-bba2-a5d7900a6d79',
 '8252188e-8db3-4f45-bc6d-e1ffb4d12260',
 'e4ef5195-f43f-4476-8044-50e28f081331'
]);
const UNBALANCED_SQL=`SELECT e.transaction_id,e.asset_code,
    SUM(e.amount_atoms) AS delta,COUNT(*) AS count,
    COALESCE(t.transaction_type,'NO_TRANSACTION') AS transaction_type
  FROM v3_economy_entries e
  LEFT JOIN v3_economy_transactions t ON t.id=e.transaction_id
  GROUP BY e.transaction_id,e.asset_code
  HAVING SUM(e.amount_atoms)<>0 ORDER BY e.transaction_id LIMIT 500`;
const HEALTH_SQL='PRAGMA quick_check';
function classifyAccountIntegrity({quickCheck,unbalanced,checkedAt}){
 const violations=[],legacy=[];
 if(quickCheck!=='ok')violations.push('SQLITE_QUICK_CHECK_FAILED');
 if(!Array.isArray(unbalanced))violations.push('LEDGER_READ_UNAVAILABLE');
 else for(const row of unbalanced){
   const historic=HISTORIC_MANUAL_ADJUSTMENTS.has(row.transaction_id)
     && row.asset_code==='TL'&&row.transaction_type==='admin_adjustment'
     && Number(row.count)===1&&Number(row.delta)>0;
   if(historic)legacy.push({asset_code:row.asset_code,
     amount_atoms:Number(row.delta),incident:'LEGACY_SINGLE_SIDED_ADMIN_ADJUSTMENT'});
   else violations.push('UNRECONCILED_LEDGER_ENTRY');
 }
 // A maximum results limit is safety-critical: truncation cannot be "clean".
 if(Array.isArray(unbalanced)&&unbalanced.length>=500)violations.push('LEDGER_SCAN_LIMIT_REACHED');
 return {ok:violations.length===0,
  status:violations.length?'fail':legacy.length?'historic_manual_review_required':'clear',
  checked_at:checkedAt||new Date().toISOString(),
  findings:[...new Set(violations)],
  historic_unbalanced_count:legacy.length,
  historic_unbalanced_tl:legacy.reduce((n,x)=>n+x.amount_atoms,0)/10000,
  historical_reconciliation_performed:false,
  new_unbalanced_count:Math.max(0,(Array.isArray(unbalanced)?unbalanced.length:0)-legacy.length),
  database_check:quickCheck==='ok'?'ok':'fail',
  ledger_is_fully_balanced:Array.isArray(unbalanced)&&unbalanced.length===0,
  read_only:true,customer_identifiers_exposed:false};
}
async function perform({accountId,token,fetcher=fetch}){
 if(!accountId||!token)throw Error('D1_AUDIT_CREDENTIALS_MISSING');
 const url='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(accountId)+'/d1/database/'+DATABASE_ID+'/query';
 const query=async(sql)=>{
   if(!(sql===HEALTH_SQL||sql===UNBALANCED_SQL))throw Error('UNAPPROVED_READ_ONLY_SQL');
   const r=await fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},
     body:JSON.stringify({sql}),redirect:'error',signal:AbortSignal.timeout(15000)});
   const body=await r.json().catch(()=>null);
   if(!r.ok||body?.success!==true||!Array.isArray(body?.result?.[0]?.results))throw Error('D1_READ_ONLY_QUERY_FAILED');
   return body.result[0].results;
 };
 const quick=await query(HEALTH_SQL);
 const unbalanced=await query(UNBALANCED_SQL);
 return classifyAccountIntegrity({quickCheck:quick[0]?.quick_check,unbalanced});
}
if(require.main===module){
 perform({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN})
  .then(result=>{console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;})
  .catch(e=>{console.error(JSON.stringify({ok:false,error:String(e?.message||'D1_AUDIT_FAILED').slice(0,100),read_only:true}));process.exitCode=2;});
}
module.exports={classifyAccountIntegrity,perform,UNBALANCED_SQL,HEALTH_SQL,DATABASE_ID};
