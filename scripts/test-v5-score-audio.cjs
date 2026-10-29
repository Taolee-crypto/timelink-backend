const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),esbuild=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'score-audio-'));
esbuild.buildSync({entryPoints:['src/v5-score-audio.ts','src/v5-score-lyrics.ts'],bundle:true,platform:'node',format:'cjs',outdir:dir});
const {recoverScoreAudio}=require(path.join(dir,'v5-score-audio.js'));
const {validateScoreLyrics}=require(path.join(dir,'v5-score-lyrics.js'));
const hash=async b=>Buffer.from(await crypto.subtle.digest('SHA-256',b));
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
(async()=>{
 // Fixed synthetic fixtures only, never production keys or audio.
 const legacy='fixture-legacy-secret-not-for-production',v2='fixture-v2-secret-not-for-production';
 const env={TL3_MASTER_SECRET:legacy,TL3_MASTER_KEYRING:JSON.stringify({v2}),TL3_MASTER_KEY_ACTIVE_ID:'v2'};
 const audio=Buffer.from('fixture audio payload');const digest=(await hash(audio)).toString('hex');
 const manifest=Buffer.from(JSON.stringify({source_sha256:digest}));const plain=Buffer.concat([u32(manifest.length),manifest,audio]);
 const content=Buffer.alloc(32,7),nonce=Buffer.alloc(12,9),iv=Buffer.alloc(12,3);
 const key=await crypto.subtle.importKey('raw',content,'AES-GCM',false,['encrypt']);
 const header=Buffer.from(JSON.stringify({profile:'TL3-V5',algorithm:'AES-256-GCM',nonce:nonce.toString('base64url'),ciphertext_bytes:plain.length+16}));
 const prefix=Buffer.concat([Buffer.from('TLNK'),Buffer.from([5]),u32(header.length),header]);
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:prefix},key,plain);
 const container=Buffer.concat([prefix,Buffer.from(encrypted)]);
 for(const [key_id,secret] of [['legacy',legacy],['v2',v2]]){
  const wrap=await crypto.subtle.importKey('raw',await hash(Buffer.from(secret)),'AES-GCM',false,['encrypt']);
  const wrapped=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:Buffer.from('timelink:tl3:v5:asset-key:178:tl3_178')},wrap,content);
  const release={file_id:178,share_id:'tl3_178',key_id,wrapped_content_key:Buffer.concat([iv,Buffer.from(wrapped)]).toString('base64url'),container_sha256:(await hash(container)).toString('hex'),source_sha256:digest};
  assert.deepEqual(Buffer.from(await recoverScoreAudio(env,container,release)),audio);
  await assert.rejects(()=>recoverScoreAudio(env,container,{...release,key_id:'missing'}));
  await assert.rejects(()=>recoverScoreAudio(env,container,{...release,source_sha256:'0'.repeat(64)}));
  const bad=Buffer.from(container);bad[bad.length-1]^=1;
  await assert.rejects(()=>recoverScoreAudio(env,bad,{...release,container_sha256:release.container_sha256}));
 }
 const score={lyrics_status:'aligned_draft',lyrics_alignment:{engine:'stable-ts-whisper-small',source:'creator_supplied'},lyrics_words:[{s:1,d:1,text:'사랑해'}]};
 assert.equal(validateScoreLyrics(score,'[Verse]\n사랑해',10),true);
 assert.equal(validateScoreLyrics(score,'다른 가사',10),false);
 assert.equal(validateScoreLyrics(score,'사랑해',1),false);
 fs.rmSync(dir,{recursive:true});console.log('PASS legacy/v2 decryption, integrity and lyric source validation');
})().catch(e=>{console.error(e);process.exitCode=1});
