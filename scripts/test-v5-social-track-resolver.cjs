'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-social-resolve-'));
try{
 buildSync({stdin:{contents:"export * from './src/v5-social-asset';",loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path.join(dir,'resolver.cjs'),logLevel:'silent'});
 const {resolveSocialTrackAsset:resolve}=require(path.join(dir,'resolver.cjs'));
 const calls=[];
 const fixtures={legacy:{id:'sh_legacy',user_id:33,shared:1},sealed:{share_id:'tl3_178',user_id:77,shared:1},private:{share_id:'tl3_179',user_id:77,shared:0}};
 const db={prepare(sql){return {bind(...args){return {first:async()=>{
 calls.push({sql,params:args});
 if(sql.includes('tl_shares'))return args[0]==='sh_legacy'?fixtures.legacy:null;
 if(sql.includes('tl3_v5_releases')){
  if(args.some(a=>a==='tl3_178'||a==='178'))return fixtures.sealed;
  if(args.some(a=>a==='tl3_179'||a==='179'))return fixtures.private;
 }
 return null;
 }};}}}};
 (async()=>{
  const legacy=await resolve(db,'sh_legacy',4,async x=>x.shared===1);
  assert.deepEqual(legacy,{id:'sh_legacy',ownerId:33,canView:true,kind:'legacy'});
  const publicV5=await resolve(db,'tl3_178',4,async()=>false);
  assert.deepEqual(publicV5,{id:'tl3_178',ownerId:77,canView:true,kind:'v5'});
  const alias=await resolve(db,'178',4,async()=>false);
  assert.equal(alias.id,publicV5.id,'file ID and sealed release share ID use one social ledger');
  const privateV5=await resolve(db,'tl3_179',4,async()=>false);
  assert.equal(privateV5.canView,false,'nonpublic V5 social read must remain denied');
  const owner=await resolve(db,'179',77,async()=>false);
  assert.equal(owner.canView,true,'sealing owner can use private social records');
  assert.equal(await resolve(db,'bad/id',4,async()=>false),null,'invalid identifiers are rejected before SQL');
  assert.equal(await resolve(db,'missing',4,async()=>false),null);
  const src=fs.readFileSync('src/index.ts','utf8');
  const segment=src.slice(src.indexOf("app.get('/api/social/stats/:id'"),src.indexOf("app.get('/api/playlist/"));
  assert.ok((segment.match(/resolveSocialTrackAsset\(c\.env\.DB/g)||[]).length>=6,'stats/likes/comments/reports must resolve canonical asset');
  assert.match(segment,/if\(!asset\.canView\)return c\.json/,'private social content is guarded');
  assert.match(segment,/INSERT OR IGNORE INTO social_likes\(share_id,user_id\)/);
  assert.match(segment,/INSERT INTO social_comments\(share_id,user_id,username,content\)/);
  assert.doesNotMatch(segment,/SELECT c\.id,c\.share_id,s\.\* FROM social_comments c JOIN tl_shares/);
  console.log('PASS V5 social: published sealed IDs and numeric aliases, private/owner access, canonical likes/comments/report routing');
 })().catch(e=>{console.error(e);process.exitCode=1;});
}finally{process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));}
