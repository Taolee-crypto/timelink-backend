'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const s=fs.readFileSync('src/routes/tl3-v5.ts','utf8');
const i=s.indexOf("const bootstrap = {");
assert.ok(i>0,'bootstrap missing');
const block=s.slice(i,i+900);
assert.match(block,/love_code:\{version:1,file_signal:randomId\(24\)\}/);
for(const forbidden of ['user_id','player_id','entitlement','reserved','tl_balance','listening'])
  assert.ok(!block.includes(forbidden),'LOVE CODE bootstrap must not contain authorization field '+forbidden);
console.log('PASS TL3 LOVE CODE file signal remains public recognition-only metadata');
