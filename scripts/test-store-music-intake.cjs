const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),esbuild=require('esbuild');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'store-intake-')),out=path.join(tmp,'route.cjs');
esbuild.buildSync({entryPoints:['src/routes/store-music-v5.ts'],bundle:true,platform:'node',format:'cjs',outfile:out});
const router=require(out).default;
const id='global-20261028-'+'0'.repeat(16),raw=Buffer.alloc(417*40);for(let i=0;i<40;i++)raw.set([255,251,144,0],i*417);
const hex=async b=>Buffer.from(await crypto.subtle.digest('SHA-256',b)).toString('hex');
(async()=>{
 const hash=await hex(raw),secret='test-import-secret-'.repeat(3),master='test-master-secret-'.repeat(3);
 const track={track_key:id,title:'Test',artist:'Test',source_page:'https://opengameart.org/content/test',license_code:'CC0',status:'awaiting_upload',source_sha256:hash,expected_seconds:1};
 const objects=new Map();let saved;
 const DB={prepare(sql){
  return {bind(...values){
   return {first:async()=>track,run:async()=>{
    if(sql.startsWith('UPDATE v5_store_music_tracks')){saved=values;track.status='ready';}
    return {meta:{changes:1}};
   }};
  }};
 }};
 const env={DB,TL3_MASTER_SECRET:master,STORE_MUSIC_INTAKE_SECRET:secret,STORE_MUSIC_BUCKET:{put:async(k,v)=>objects.set(k,Buffer.from(v))}};
 const request=(body=raw,key=secret,e=env)=>router.request('https://example.test/intake/'+id,{method:'PUT',headers:{'X-Store-Intake-Key':key},body},e);
 assert.equal((await request(raw,secret,{...env,STORE_MUSIC_INTAKE_SECRET:undefined})).status,404);
 assert.equal((await request(raw,'wrong')).status,403);
 assert.equal((await request(Buffer.alloc(2048))).status,422);
 const response=await request();assert.equal(response.status,200);assert.equal(objects.size,1);
 const [duration,objectKey,containerHash,wrapped,size]=saved,container=objects.get(objectKey.slice(3));
 assert.equal(await hex(container),containerHash);assert.equal(container.length,size);
 const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',Buffer.from(master)),'AES-GCM',false,['decrypt']);
 const wrap=Buffer.from(wrapped,'base64url');const contentKey=await crypto.subtle.decrypt({name:'AES-GCM',iv:wrap.subarray(0,12),additionalData:Buffer.from('timelink:store:v5:'+id)},key,wrap.subarray(12));
 const bootEnd=9+container.readUInt32BE(5),boot=JSON.parse(container.subarray(9,bootEnd));
 const plain=Buffer.from(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(boot.nonce,'base64url'),additionalData:container.subarray(0,bootEnd)},await crypto.subtle.importKey('raw',contentKey,'AES-GCM',false,['decrypt']),container.subarray(bootEnd)));
 const end=4+plain.readUInt32BE(0),manifest=JSON.parse(plain.subarray(4,end));
 assert.equal(manifest.rights.proof_url,track.source_page);assert.equal(manifest.scope,'commercial_broadcast_only');assert.deepEqual(plain.subarray(end),raw);
 assert.equal((await (await request()).json()).already_ready,true);
 console.log('PASS intake authorization, reviewed hash, R2 storage, encrypted provenance, decryption, exact audio round trip and idempotent retry');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
