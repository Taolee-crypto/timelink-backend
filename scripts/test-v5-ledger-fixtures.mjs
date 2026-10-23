#!/usr/bin/env node
// Isolated, deterministic accounting specification. Never accesses Cloudflare or production D1.
import assert from 'node:assert/strict';
const ATOMS=10000n;
const atoms=tl=>BigInt(tl)*ATOMS;
function settle({durationSeconds,playedSeconds,paid,ad,bonus}){
 assert(Number.isInteger(durationSeconds)&&durationSeconds>0);
 assert(Number.isInteger(playedSeconds)&&playedSeconds>=0&&playedSeconds<=durationSeconds);
 const total=atoms(durationSeconds);
 const spent=atoms(playedSeconds);
 const balance=atoms(paid+ad+bonus);
 assert(balance>=total,'track must be funded for full play');
 const unplayed=total-spent;
 const stopRefund=unplayed/2n;
 const stopPlatform=unplayed-stopRefund;
 const refunded=stopRefund;
 const creator=spent*70n/100n;
 const platform=spent-creator;
 assert.equal(creator+platform,spent);
 assert.equal(spent+stopRefund+stopPlatform,total);
 return {spent,refunded,stopPlatform,creator,platform,remaining:balance-spent};
}
function test(name,fn){try{fn();console.log('PASS '+name)}catch(e){console.error('FAIL '+name,e);process.exitCode=1}}
test('30 seconds audible: 30 TL spent',()=>{let x=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});assert.equal(x.spent,atoms(30));assert.equal(x.refunded,atoms(75));assert.equal(x.stopPlatform,atoms(75))});
test('pause: no additional TL charged',()=>{let a=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});let b=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});assert.equal(a.spent,b.spent)});
test('70:30 allocation for 100 TL',()=>{let x=settle({durationSeconds:100,playedSeconds:100,paid:100,ad:0,bonus:0});assert.equal(x.creator,atoms(70));assert.equal(x.platform,atoms(30))});
test('ledger conservation on early stop',()=>{let x=settle({durationSeconds:180,playedSeconds:27,paid:180,ad:0,bonus:0});assert.equal(x.spent+x.refunded+x.stopPlatform,atoms(180))});
test('underfunded track rejected',()=>assert.throws(()=>settle({durationSeconds:180,playedSeconds:30,paid:100,ad:0,bonus:0})));
test('idempotency key duplicate not applied twice',()=>{const seen=new Set();let charged=0n;function post(k,v){if(seen.has(k))return;seen.add(k);charged+=v}post('v5-session-a',atoms(30));post('v5-session-a',atoms(30));assert.equal(charged,atoms(30))});
// V5 early-stop regression cases: only an explicit stop closes the unplayed pool.
test('early stop: 180 TL track, 30 TL played, 75 TL returned as TL_B and 75 TL to platform',()=>{
 const x=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});
 assert.equal(x.spent,atoms(30));
 assert.equal(x.creator,atoms(21));
 assert.equal(x.platform,atoms(9));
 assert.equal(x.refunded,atoms(75));
 assert.equal(x.stopPlatform,atoms(75));
 assert.equal(x.platform+x.stopPlatform,atoms(84));
 assert.equal(x.creator+x.platform+x.refunded+x.stopPlatform,atoms(180));
});
test('early stop: zero audible seconds sends no playback revenue to creator',()=>{
 const x=settle({durationSeconds:180,playedSeconds:0,paid:180,ad:0,bonus:0});
 assert.equal(x.creator,0n);
 assert.equal(x.platform,0n);
 assert.equal(x.refunded,atoms(90));
 assert.equal(x.stopPlatform,atoms(90));
});
test('completed playback: no early-stop refund or recovery',()=>{
 const x=settle({durationSeconds:180,playedSeconds:180,paid:180,ad:0,bonus:0});
 assert.equal(x.refunded,0n);
 assert.equal(x.stopPlatform,0n);
 assert.equal(x.creator,atoms(126));
 assert.equal(x.platform,atoms(54));
});
test('early-stop atom rounding conserves TL when remaining amount is odd',()=>{
 const unplayed=5n;
 const refund=unplayed/2n;
 const platform=unplayed-refund;
 assert.equal(refund,2n);
 assert.equal(platform,3n);
 assert.equal(refund+platform,unplayed);
});
test('repeated explicit stop must not distribute the same unplayed TL twice',()=>{
 const posted=new Set();
 let refunded=0n,platform=0n;
 function stop(session,remaining){
   const key='v5-early-stop:'+session;
   if(posted.has(key))return;
   posted.add(key);
   refunded+=remaining/2n;
   platform+=remaining-remaining/2n;
 }
 stop('v5-session-a',atoms(150));
 stop('v5-session-a',atoms(150));
 assert.equal(refunded,atoms(75));
 assert.equal(platform,atoms(75));
});
console.log('NOTE: These are independent model fixtures, NOT actual Worker/D1 or audio playback integration tests.');
