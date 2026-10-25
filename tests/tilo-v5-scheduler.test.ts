import { strict as assert } from 'node:assert';
import { planTiloBroadcast } from '../src/tilo-v5-scheduler';

const tracks = [
  {fileId:1,artist:'A',durationMs:60000,campaignId:11,eligiblePromotion:true},
  {fileId:2,artist:'B',durationMs:60000},
  {fileId:3,artist:'C',durationMs:60000,campaignId:12,eligiblePromotion:true},
  {fileId:4,artist:'D',durationMs:60000}
];
const plan = planTiloBroadcast(tracks,{promotedMs:0,ordinaryMs:0},240000);
assert.equal(plan.selections.length,4);
assert.equal(plan.projected.promotedMs,120000);
assert.equal(plan.projected.ordinaryMs,120000);
assert.equal(plan.unfilledMs,0);
assert.equal(new Set(plan.selections.map(s=>s.track.fileId)).size,4);
const noPromotion = planTiloBroadcast(tracks.map(t=>({...t,eligiblePromotion:false})),{promotedMs:0,ordinaryMs:0},240000);
assert.equal(noPromotion.projected.promotedMs,0);
assert.equal(noPromotion.projected.ordinaryMs,240000);
assert.equal(planTiloBroadcast(tracks,{promotedMs:0,ordinaryMs:0},60000,[1]).selections[0].track.fileId,3);
assert.throws(()=>planTiloBroadcast(tracks,{promotedMs:-1,ordinaryMs:0},60000));

// Premium is a priority, never the only broadcast-eligible category.
assert.deepEqual(plan.selections.map(s=>s.kind),['promoted','promoted','ordinary','ordinary']);
const premiumOnly=planTiloBroadcast(tracks,{promotedMs:900000,ordinaryMs:0},120000);
assert.deepEqual(premiumOnly.selections.map(s=>s.kind),['promoted','promoted']);
const fallback=planTiloBroadcast(tracks.map(t=>({...t,eligiblePromotion:false})),{promotedMs:0,ordinaryMs:0},240000,[],[],()=>0);
assert.equal(fallback.selections.length,4);
assert(fallback.selections.every(s=>s.kind==='ordinary'));
const otherRandom=planTiloBroadcast(tracks.map(t=>({...t,eligiblePromotion:false})),{promotedMs:0,ordinaryMs:0},240000,[],[],()=>0.99);
assert.notDeepEqual(fallback.selections.map(s=>s.track.fileId),otherRandom.selections.map(s=>s.track.fileId));
assert.throws(()=>planTiloBroadcast(tracks,{promotedMs:0,ordinaryMs:0},60000,[],[],()=>1));
console.log('PASS TILO: promotion priority without quota, random ordinary fallback, repeat guards');

// After all six premium songs, use unheard ordinary songs before any replay.
const fullCatalogue=Array.from({length:11},(_,i)=>({fileId:i+1,artist:'Artist',durationMs:60000,campaignId:i<6?i+100:null,eligiblePromotion:i<6}));
const rotation=planTiloBroadcast(fullCatalogue,{promotedMs:0,ordinaryMs:0},900000,[],[],()=>0.4);
assert.equal(rotation.selections.length,11);
assert.equal(new Set(rotation.selections.map(s=>s.track.fileId)).size,11);
assert(rotation.selections.slice(0,6).every(s=>s.kind==='promoted'));
assert(rotation.selections.slice(6).every(s=>s.kind==='ordinary'));
assert.equal(rotation.unfilledMs,240000,'do not fill the remainder by repeating premium tracks');
console.log('PASS full catalogue rotation: six premium then five unheard ordinary tracks, no replay');
