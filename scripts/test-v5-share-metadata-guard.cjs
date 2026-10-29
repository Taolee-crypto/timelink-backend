'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-share-auth-'));
try{
 buildSync({stdin:{contents:"export * from './src/v5-share-metadata-guard';export {makeAccessToken,verifyToken} from './src/auth';",
  loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',
  outfile:path.join(dir,'check.cjs'),logLevel:'silent'});
 const api=require(path.join(dir,'check.cjs'));
 (async()=>{
  const token=await api.makeAccessToken(2,'v5-share-auth-test-secret');
  assert.equal(String((await api.verifyToken(token,'v5-share-auth-test-secret')).sub),'2');
  const parts=token.split('.');
  const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  payload.sub='3';
  parts[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.equal(await api.verifyToken(parts.join('.'),'v5-share-auth-test-secret'),null);
  assert.equal(await api.verifyToken('fallback_2','v5-share-auth-test-secret'),null);
  const forbidden=['user_id','title','stream_url','file_type','file_tl','release_mode','origin_hash','price_per_sec','content_kind','storage_mode','rights_confirmed','shared'];
  for(const key of forbidden)assert.deepEqual(api.rejectedImmutableShareFields({[key]:'forged'}),[key]);
  assert.deepEqual(api.rejectedImmutableShareFields({lyrics:'내 가사',cover_url:'https://example.com/cover.jpg',artist:'내가수',category:'Pop'}),[]);
  assert.throws(()=>api.rejectedImmutableShareFields([]),/INVALID_SHARE_PATCH/);
  const src=fs.readFileSync('src/index.ts','utf8');
  const start=src.indexOf("app.patch('/api/shares/:id'");
  const end=src.indexOf("app.delete('/api/shares/:id'",start);
  const block=src.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.match(block,/const userId=await shareAuthUser\(c\)/);
  assert.doesNotMatch(block,/parseJWT\(/);
  assert.match(block,/rejectedImmutableShareFields\(body\)/);
  assert.match(block,/code:'IMMUTABLE_SHARE_FIELD'/);
  assert.doesNotMatch(block,/stream_url:'stream_url'|file_tl:'file_tl'|content_kind:'content_kind'/);
  assert.match(block,/validateSealedV5MetadataPatch\(body/);
  assert.match(block,/changes\.push\(db\.prepare\(/);
  assert.match(block,/await db\.batch\(changes\)/);
  assert.match(block,/tl3_v5_display_metadata/);
  assert.match(block,/tl3_v5_track_metadata/);
  console.log('PASS share metadata: JWT HMAC verified (forged or fallback denied), owner/sealed TL3 URL and billing fields immutable, lyrics/artwork editable');
 })().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
}catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e}
