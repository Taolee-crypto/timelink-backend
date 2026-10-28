'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const esbuild=require('esbuild');
const source=fs.readFileSync(path.join(__dirname,'../src/routes/store-music-v5.ts'),'utf8');
const index=fs.readFileSync(path.join(__dirname,'../src/index.ts'),'utf8');
// CC0 store recordings were decommissioned: the previous "ingest CC0 -> 200"
// fixture must NEVER gate production deployment again.
assert.ok(!index.includes('ctx.waitUntil(runStoreMusicIntake(env)'), 'cron cannot re-seed scraped CC0');
assert.match(source,/export async function runStoreMusicIntake\(_env:Env\)\{return;\}/);
assert.match(source,/UPPER\(license_code\)<>\'CC0\'/);
assert.match(source,/UPPER\(t\.license_code\)<>\'CC0\'/);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'store-retired-')),out=path.join(tmp,'route.cjs');
try{
 esbuild.buildSync({entryPoints:['src/routes/store-music-v5.ts'],bundle:true,platform:'node',format:'cjs',outfile:out});
 const router=require(out).default;
 (async()=>{
  const r=await router.request('https://example.test/intake/global-20261028-0000000000000000',{
   method:'PUT',headers:{'Content-Type':'audio/mpeg'},body:Buffer.from([255,251,144,0])},{});
  assert.equal(r.status,410,'operator-retired CC0 importer must reject PUT');
  const j=await r.json();
  assert.equal(j.code,'STORE_CC0_INTAKE_RETIRED');
  console.log('PASS CC0 decommission: intake 410, cron disabled, queue/session/container reject CC0, no re-import');
 })().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
}catch(e){fs.rmSync(tmp,{recursive:true,force:true});throw e;}
