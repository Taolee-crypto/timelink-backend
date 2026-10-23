#!/usr/bin/env node
// Fail closed: only allow wrangler D1 local execution with explicit test config.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const config=fs.readFileSync('wrangler.v5-test.toml','utf8');
const prod=fs.readFileSync('wrangler.toml','utf8');
const prodId=prod.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
const testId=config.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
assert(testId&&testId!==prodId,'Test D1 must not be production D1');
assert.match(config,/ENVIRONMENT\s*=\s*"test"/);
assert.doesNotMatch(config,/\[\[routes\]\]|\[triggers\]/);
const args=process.argv.slice(2);
assert(args.length===2&&args[0]==='--file'&&/^tests\/v5\/[-\w]+\.sql$/.test(args[1]),'Only approved SQL fixture file allowed');
assert(fs.existsSync(args[1]),'SQL fixture file missing');
const sql=fs.readFileSync(args[1],'utf8');
assert(!/\b(ATTACH|DETACH|load_extension)\b/i.test(sql),'Unsafe SQL operation');
const cmd=['wrangler','d1','execute','timelink-v5-ledger-test','--local','--config','wrangler.v5-test.toml','--file',args[1]];
console.log('LOCAL TEST D1 ONLY:',cmd.join(' '));
const result=spawnSync('npx',cmd,{stdio:'inherit',shell:process.platform==='win32'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
