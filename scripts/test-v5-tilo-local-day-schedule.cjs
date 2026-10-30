'use strict';
// Existing TILO station planning must follow the country's LOCAL calendar date,
// rather than accidentally reshuffle at 00:00 UTC.
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tilo-local-station-'));
const output=path.join(dir,'station.cjs');
buildSync({stdin:{contents:"export * from './src/tilo-station-schedule';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'silent'});
const {scheduledStationTracks,tiloStationBroadcastDayKey:key}=require(output);
const tracks=Array.from({length:14},(_,i)=>({file_id:i+1,duration_ms:60000,title:'Track '+(i+1),artist:'Artist '+(i+1)}));
function dbWithPremium(fileIds=null){
 const activity={inventory:0,premium:0};
 const db={prepare(sql){
  if(sql.includes('FROM central_broadcast_service_accounts')){
   return {bind:()=>({all:async()=>{activity.inventory++;return {results:tracks};}})};
  }
  if(sql.includes('FROM v5_premium_orders')){
   return {all:async()=>{
    activity.premium++;
    if(fileIds===null)throw new Error('D1_ERROR: no such table: v5_premium_orders');
    return {results:fileIds.map(file_id=>({file_id}))};
   }};
  }
  throw Error('Unexpected query: '+sql.slice(0,120));
 }};
 return {db,activity};
}
const time=t=>new Date(t);
async function ids(country,when,premium=null){
 const h=dbWithPremium(premium);
 const list=await scheduledStationTracks(h.db,country,time(when));
 assert.equal(h.activity.inventory,1);
 assert.equal(h.activity.premium,1);
 assert.equal(list.length,tracks.length);
 assert.equal(new Set(list.map(x=>x.file_id)).size,list.length);
 assert.equal(list.every(x=>Number.isSafeInteger(x.duration_ms)),true);
 return list.map(x=>x.file_id);
}
(async()=>{
 const before='2026-10-30T23:59:50.000Z',after='2026-10-31T00:00:10.000Z';
 for(const country of ['KR','JP','US','CN','TH','VN']){
  assert.equal(key(country,time(before)),key(country,time(after)),
    country+' schedule must not reset at UTC midnight while local date stays the same');
  assert.deepEqual(await ids(country,before),await ids(country,after),
    country+' shuffled rights-granted tracks must remain stable through UTC midnight');
 }
 const localBorders=[
  ['KR','2026-10-30T14:59:59Z','2026-10-30T15:00:01Z'],
  ['JP','2026-10-30T14:59:59Z','2026-10-30T15:00:01Z'],
  ['CN','2026-10-30T15:59:59Z','2026-10-30T16:00:01Z'],
  ['TH','2026-10-30T16:59:59Z','2026-10-30T17:00:01Z'],
  ['VN','2026-10-30T16:59:59Z','2026-10-30T17:00:01Z'],
  ['US','2026-10-31T03:59:59Z','2026-10-31T04:00:01Z']
 ];
 for(const [country,beforeLocal,afterLocal] of localBorders){
  assert.notEqual(key(country,time(beforeLocal)),key(country,time(afterLocal)),
    country+' schedule seed must advance at LOCAL midnight');
 }
 assert.equal(key('KR',time('2026-10-30T15:01:00Z')),'KR:2026-10-31');
 assert.equal(key('US',time('2026-11-01T05:59:00Z')),'US:2026-11-01');
 assert.equal(key('US',time('2026-11-01T06:01:00Z')),'US:2026-11-01',
   'NY daylight-saving hour repeats but should not produce a new schedule');
 assert.deepEqual(await ids('US','2026-11-01T05:59:00Z'),await ids('US','2026-11-01T06:01:00Z'));
 assert.notEqual(key('KR',time(before)),key('JP',time(before)),
   'country seeds must be distinct even if time zones are equal');
 assert.throws(()=>key('INVALID',time(before)),/Invalid station country or clock/);
 assert.throws(()=>key('KR',new Date('invalid')),/Invalid station country or clock/);
 const priority=await ids('KR','2026-10-30T14:00:00Z',[3]);
 assert.equal(priority[0],3,'an authorized funded promotion has priority, not a rights bypass');
 const baseline=await ids('KR','2026-10-30T14:00:00Z');
 assert.equal(baseline.length,priority.length,'unfunded ordinary music must still be scheduled');
 console.log('PASS TILO six-country LOCAL midnight schedules, UTC rollover continuity, US daylight-saving repeat, rights-pool fallback and eligible funded priority');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
