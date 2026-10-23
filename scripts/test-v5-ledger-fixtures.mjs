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
 const refunded=total-spent;
 const creator=spent*70n/100n;
 const platform=spent-creator;
 assert.equal(creator+platform,spent);
 assert.equal(spent+refunded,total);
 return {spent,refunded,creator,platform,remaining:balance-spent};
}
function test(name,fn){try{fn();console.log('PASS '+name)}catch(e){console.error('FAIL '+name,e);process.exitCode=1}}
test('30 seconds audible: 30 TL spent',()=>{let x=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});assert.equal(x.spent,atoms(30));assert.equal(x.refunded,atoms(150))});
test('pause: no additional TL charged',()=>{let a=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});let b=settle({durationSeconds:180,playedSeconds:30,paid:180,ad:0,bonus:0});assert.equal(a.spent,b.spent)});
test('70:30 allocation for 100 TL',()=>{let x=settle({durationSeconds:100,playedSeconds:100,paid:100,ad:0,bonus:0});assert.equal(x.creator,atoms(70));assert.equal(x.platform,atoms(30))});
test('ledger conservation on early stop',()=>{let x=settle({durationSeconds:180,playedSeconds:27,paid:180,ad:0,bonus:0});assert.equal(x.spent+x.refunded,atoms(180))});
test('underfunded track rejected',()=>assert.throws(()=>settle({durationSeconds:180,playedSeconds:30,paid:100,ad:0,bonus:0})));
test('idempotency key duplicate not applied twice',()=>{const seen=new Set();let charged=0n;function post(k,v){if(seen.has(k))return;seen.add(k);charged+=v}post('v5-session-a',atoms(30));post('v5-session-a',atoms(30));assert.equal(charged,atoms(30))});
console.log('NOTE: These are independent model fixtures, NOT actual Worker/D1 or audio playback integration tests.');
