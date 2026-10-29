'use strict';
/*
 * TimeLink V5 read-only operational guard.
 * Safe for scheduled GitHub Actions: GET requests only, no D1 query/export/restore.
 * Bookmarks are credentials-like recovery references: never print raw values.
 */
const API='https://api.timelink.digital/api/v1/health';
const DATABASE_ID='7a61cb9f-d368-439e-b175-f3e958aeb84f';
const REQUIRED_PAGES=['timelink-frontend','timelink-admin'];
const TIMEOUT_MS=15000;
function classify(input){
 const reasons=[],h=input.health||{},db=input.database||{},bookmark=input.bookmark||{};
 const workers=input.worker||{},pages=input.pages||{};
 if(h.status!==200||h.body?.status!=='ok'||h.body?.database!=='ok')reasons.push('PUBLIC_API_HEALTH_FAILED');
 if(db.success!==true||db.uuid!==DATABASE_ID)reasons.push('D1_DATABASE_ID_MISMATCH_OR_UNAVAILABLE');
 if(bookmark.success!==true||bookmark.exists!==true)reasons.push('D1_PITR_BOOKMARK_UNAVAILABLE');
 if(workers.success!==true||workers.has_deployment!==true)reasons.push('WORKER_DEPLOYMENT_NOT_VERIFIED');
 for(const name of REQUIRED_PAGES){
  const p=pages[name]||{};
  if(p.success!==true||!['success','active'].includes(p.status))reasons.push('PAGES_DEPLOYMENT_UNAVAILABLE_'+name.toUpperCase().replace(/-/g,'_'));
 }
 return {ok:reasons.length===0,failures:reasons,checked_at:input.checked_at||new Date().toISOString(),
  checks:{api:reasons.includes('PUBLIC_API_HEALTH_FAILED')?'fail':'pass',
   database:reasons.includes('D1_DATABASE_ID_MISMATCH_OR_UNAVAILABLE')?'fail':'pass',
   pitr:reasons.includes('D1_PITR_BOOKMARK_UNAVAILABLE')?'fail':'pass',
   pages:Object.fromEntries(REQUIRED_PAGES.map(name=>[name,pages[name]?.status||'unknown'])),
   worker:workers.has_deployment?'present':'missing'},
  non_destructive:true,restore_performed:false,replication_verified:false};
}
async function getJson(url,headers={}){
 const response=await fetch(url,{method:'GET',headers,signal:AbortSignal.timeout(TIMEOUT_MS),redirect:'error'});
 let body=null;try{body=await response.json()}catch(_){}
 return {status:response.status,success:response.ok&&body?.success!==false,body};
}
async function perform(config){
 const accountId=config.accountId,token=config.token;
 if(!accountId||!token)throw Error('MISSING_CLOUDFLARE_READ_CREDENTIALS');
 const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(accountId);
 const auth={Authorization:'Bearer '+token,Accept:'application/json'};
 const tasks=[
  [getJson(API),x=>({status:x.status,body:x.body})],
  [getJson(base+'/d1/database/'+DATABASE_ID,auth),x=>({success:x.success,uuid:x.body?.result?.uuid})],
  [getJson(base+'/d1/database/'+DATABASE_ID+'/time_travel/bookmark',auth),x=>({success:x.success,exists:typeof x.body?.result?.bookmark==='string'&&x.body.result.bookmark.length>10})],
  [getJson(base+'/workers/scripts/timelink-backend/deployments',auth),x=>({success:x.success,has_deployment:(x.body?.result?.deployments||[]).length>0})],
  ...REQUIRED_PAGES.map(name=>[getJson(base+'/pages/projects/'+name+'/deployments?env=production&page=1&per_page=1',auth),x=>({name,success:x.success,status:x.body?.result?.[0]?.latest_stage?.status||'missing'})])
 ];
 const responses=await Promise.allSettled(tasks.map(([promise])=>promise));
 const readings=responses.map((r,i)=>{
  if(r.status==='rejected')return {error:'CHECK_FAILED',name:i>=4?REQUIRED_PAGES[i-4]:'core-'+i};
  return tasks[i][1](r.value);
 });
 const pageStates={};
 for(let i=0;i<REQUIRED_PAGES.length;i++){
  const name=REQUIRED_PAGES[i],row=readings[i+4]||{};
  pageStates[name]={success:row.success===true,status:row.status||'unavailable'};
 }
 return classify({health:readings[0],database:readings[1],bookmark:readings[2],worker:readings[3],pages:pageStates,checked_at:new Date().toISOString()});
}
async function main(){
 const env=process.env;
 const result=await perform({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
 console.log(JSON.stringify(result,null,2));
 if(!result.ok)process.exitCode=2;
}
if(require.main===module)main().catch(e=>{
 // Deliberately avoid including API token, bookmarks or remote raw body.
 console.error(JSON.stringify({ok:false,failures:[String(e?.message||'MONITOR_FAILED').slice(0,120)],non_destructive:true}));
 process.exitCode=2;
});
module.exports={classify,perform,DATABASE_ID,REQUIRED_PAGES};
