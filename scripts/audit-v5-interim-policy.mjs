#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';
const ledger=fs.readFileSync('src/economy-ledger.ts','utf8');
const policy=fs.readFileSync('src/economy-policy.ts','utf8');
const fixtures=fs.readFileSync('scripts/test-v5-ledger-fixtures.mjs','utf8');
const sql=fs.readFileSync('tests/v5/local-ledger-fixture.sql','utf8');
const prod=fs.readFileSync('wrangler.toml','utf8');
const test=fs.readFileSync('wrangler.v5-test.toml','utf8');
let failures=0;
function check(name,fn){try{fn();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.message)}}
check('70/30 policy constants',()=>{assert.match(policy,/CREATOR_SHARE_RATE\s*=\s*0\.70/);assert.match(policy,/PLATFORM_SHARE_RATE\s*=\s*0\.30/)});
check('settlement consumes track pool',()=>assert.match(ledger,/export async function settleTrackPlayback[\s\S]*?add\(pool,-consumed\)/));
check('settlement records creator and platform separately',()=>{assert.match(ledger,/creatorShareAtoms\+=creatorPart/);assert.match(ledger,/platformShareAtoms\+=platformPart/)});
check('settlement transaction idempotency',()=>assert.match(ledger,/idempotencyKey,transactionType:'track_playback_settlement'/));
check('stop refunds 100 percent as TL_B',()=>{assert.match(ledger,/const refund=amount,platform=0/);assert.match(ledger,/accountId:await ensureLedgerAccount\(db,'user',userId,'TL','wallet_bonus'\),assetCode:'TL',amountAtoms:refund/);assert.match(ledger,/idempotencyKey:'v5-early-stop:'\+sessionId/)});
check('test D1 is separate',()=>{const id=x=>x.match(/database_id\s*=\s*"([^"]+)"/)?.[1];assert(id(prod)&&id(test)&&id(prod)!==id(test));assert.match(test,/ENVIRONMENT\s*=\s*"test"/)});
check('local SQL fixture is repeatable',()=>{assert.match(sql,/INSERT OR IGNORE INTO v5_test_transactions/);assert.match(sql,/INSERT INTO v5_test_once\(applied\) SELECT changes\(\)/);assert.match(sql,/\(SELECT applied FROM v5_test_once\)=1/);assert.match(sql,/CREATE TABLE IF NOT EXISTS v5_test_once/)});
check('model matches actual early-stop refund policy',()=>{assert.match(fixtures,/stopRefund=unplayed/);assert.match(fixtures,/stopPlatform=0n/)});
console.log(JSON.stringify({passed:8-failures,failed:failures,classification:'interim source-policy audit; runtime Worker/D1 not executed'},null,2));
if(failures)process.exitCode=1;

