#!/usr/bin/env node
// Read-only source contract test. Does not create sessions or debit TL.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src=fs.readFileSync('src/index.ts','utf8');
const checks=[
 ['V5 preflight',/app\.post\('\/api\/v1\/tl3\/play\/preflight\/:id'/],
 ['V5 stop',/app\.post\('\/api\/v1\/tl3\/play\/stop\/:id'/],
 ['V5 sealed releases',/tl3_v5_releases/],
 ['V5 duration based price',/Math\.ceil\(totalMs\/1000/],
 ['V5 ledger wallet lookup',/getLedgerWallet\(c\.env\.DB,user\.id\)/],
 ['V5 track pool lookup',/getTrackPoolBalances\(c\.env\.DB,user\.id/],
 ['V5 play meter sessions',/tl3_play_meter_sessions/],
 ['No billing on preflight',/\/\/ 재생 전 자산 길이와 곡별 충전 잔액을 조회한다\. 예약·차감은 하지 않는다\./]
];
let failures=0;
for(const [name,re] of checks){const ok=re.test(src);console.log((ok?'PASS':'FAIL')+' '+name);if(!ok)failures++;}
const preflight=src.split("app.post('/api/v1/tl3/play/preflight/:id'")[1]?.split("app.post('/api/v1/tl3/play/stop/:id'")[0]||'';
if(!preflight.includes('can_play:!insufficientTL')){console.error('FAIL preflight denies insufficient track pool');failures++;}
else console.log('PASS preflight denies insufficient track pool');
assert.equal(failures,0,failures+' V5 playback source contracts failed');
console.log('Source checks passed; authenticated playback, audible time, 70/30 settlement and D1 ledger balances remain UNVERIFIED.');
