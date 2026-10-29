'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {classify,perform,DATABASE_ID,REQUIRED_PAGES}=require('./v5-release-watch.cjs');
const good=()=>({checked_at:'2026-10-29T00:00:00Z',
 health:{status:200,body:{status:'ok',database:'ok'}},
 database:{success:true,uuid:DATABASE_ID},bookmark:{success:true,exists:true},
 worker:{success:true,has_deployment:true},
 pages:Object.fromEntries(REQUIRED_PAGES.map(name=>[name,{success:true,status:'success'}]))});
const passed=classify(good());assert.equal(passed.ok,true);assert.equal(passed.restore_performed,false);
for(const [part,key,expected] of [
 ['health','status','PUBLIC_API_HEALTH_FAILED'],
 ['database','uuid','D1_DATABASE_ID_MISMATCH_OR_UNAVAILABLE'],
 ['bookmark','exists','D1_PITR_BOOKMARK_UNAVAILABLE'],
 ['worker','has_deployment','WORKER_DEPLOYMENT_NOT_VERIFIED']
]){
 const state=good();state[part][key]=key==='status'?503:key==='uuid'?'wrong':false;
 const result=classify(state);assert.equal(result.ok,false);assert.ok(result.failures.includes(expected));
}
for(const name of REQUIRED_PAGES){const a=good();a.pages[name].status='failure';assert.ok(!classify(a).ok);}
(async()=>{
 // A synthetic SQLite backup/restore exercise: NEVER touch D1 production.
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'timelink-recovery-'));
 try{
  const orig=path.join(tmp,'source.sqlite'),copy=path.join(tmp,'snapshot.sqlite');
  const db=new DatabaseSync(orig);
  db.exec("CREATE TABLE v5_work_ledger(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);INSERT INTO v5_work_ledger VALUES(1,21)");
  db.exec("CREATE TABLE v3_economy_transactions(id TEXT PRIMARY KEY,amount INTEGER NOT NULL);INSERT INTO v3_economy_transactions VALUES('fixture',100)");
  db.exec('VACUUM INTO '+JSON.stringify(copy).replaceAll('"',"'"));
  db.exec("UPDATE v5_work_ledger SET version=999; DELETE FROM v3_economy_transactions");
  db.close();
  const recovered=new DatabaseSync(copy);
  assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(recovered.prepare('SELECT version FROM v5_work_ledger WHERE id=1').get().version,21);
  assert.equal(recovered.prepare('SELECT amount FROM v3_economy_transactions WHERE id=\'fixture\'').get().amount,100);
  recovered.close();
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 const issued=[];
 const oldFetch=global.fetch;
 global.fetch=async(url,opts)=>{
  issued.push({url,method:opts.method,redirect:opts.redirect});
  const isApi=url.includes('/api/v1/health'),isDb=url.endsWith('/d1/database/'+DATABASE_ID);
  const isPitr=url.endsWith('/time_travel/bookmark'),isWorker=url.includes('/workers/scripts/');
  let result;
  if(isApi)result={status:'ok',database:'ok'};
  else if(isDb)result={success:true,result:{uuid:DATABASE_ID}};
  else if(isPitr)result={success:true,result:{bookmark:'supersecret-do-not-print'}};
  else if(isWorker)result={success:true,result:{deployments:[{id:'deployment-1'}]}};
  else result={success:true,result:[{latest_stage:{status:'active'}}]};
  return {status:200,ok:true,json:async()=>result};
 };
 try{
  const checked=await perform({accountId:'fixture-account',token:'not-a-live-secret'});
  assert.equal(checked.ok,true);
  assert.ok(!JSON.stringify(checked).includes('supersecret-do-not-print'));
  assert.ok(issued.every(x=>x.method==='GET'&&x.redirect==='error'));
  assert.equal(issued.length,6);
  // A rejected Pages request retains its project identity and must fail
  // rather than silently writing a bogus "undefined" page state.
  global.fetch=async(url,opts)=>{
    if(url.includes('/pages/projects/timelink-admin/'))throw Error('simulated-pages-unreachable');
    const isApi=url.includes('/api/v1/health'),isDb=url.endsWith('/d1/database/'+DATABASE_ID);
    const isPitr=url.endsWith('/time_travel/bookmark'),isWorker=url.includes('/workers/scripts/');
    let result;
    if(isApi)result={status:'ok',database:'ok'};
    else if(isDb)result={success:true,result:{uuid:DATABASE_ID}};
    else if(isPitr)result={success:true,result:{bookmark:'secret-not-for-logs'}};
    else if(isWorker)result={success:true,result:{deployments:[{id:'fixture'}]}};
    else result={success:true,result:[{latest_stage:{status:'success'}}]};
    return {status:200,ok:true,json:async()=>result};
  };
  const failed=await perform({accountId:'fixture-account',token:'test-credential'});
  assert.equal(failed.ok,false);
  assert.ok(failed.failures.includes('PAGES_DEPLOYMENT_UNAVAILABLE_TIMELINK_ADMIN'));
  assert.equal(failed.checks.pages['timelink-admin'],'unavailable');
  assert.ok(!JSON.stringify(failed).includes('secret-not-for-logs'));
 }finally{global.fetch=oldFetch;}
 console.log('PASS ops: API, D1 identity, PITR bookmark, 2 Pages and Worker deployment, local SQLite snapshot restore, GET-only, no recovery secret leak');
})().catch(e=>{console.error(e);process.exitCode=1});
