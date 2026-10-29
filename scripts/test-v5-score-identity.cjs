const assert=require('node:assert/strict');
const esbuild=require('esbuild');
const fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'score-identity-'));
esbuild.buildSync({entryPoints:['src/v5-score-identity.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(dir,'identity.cjs')});
const {validateScoreClaims,verifyScoreIdentity,SCORE_AUDIENCE}=require(path.join(dir,'identity.cjs'));
const now=Math.floor(Date.now()/1000);
const good={iss:'https://token.actions.githubusercontent.com',aud:SCORE_AUDIENCE,repository:'Taolee-crypto/timelink-backend',repository_id:'1162984214',repository_owner_id:'85010918',ref:'refs/heads/main',sub:'repo:Taolee-crypto/timelink-backend:environment:production',environment:'production',runner_environment:'github-hosted',workflow_ref:'Taolee-crypto/timelink-backend/.github/workflows/v5-vocal-inference.yml@refs/heads/main',event_name:'workflow_dispatch',iat:now,nbf:now,exp:now+300,run_id:'123',run_attempt:'1'};
(async()=>{
 assert.equal(validateScoreClaims(good),'123:1');
 for(const [key,value] of Object.entries(good)) {
   if(['iat','nbf','exp'].includes(key))continue;
   assert.throws(()=>validateScoreClaims({...good,[key]:'wrong'}),key);
 }
 for(const bad of [{exp:now-1},{nbf:now+90},{iat:now-601}])assert.throws(()=>validateScoreClaims({...good,...bad}));
 assert.equal(await verifyScoreIdentity('Bearer bad'),null);
 const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const jwt=b64({alg:'none',kid:'test'})+'.'+b64(good)+'.AA';
 assert.equal(await verifyScoreIdentity('Bearer '+jwt),null);
 // Signature validity, including tamper detection, uses a test-only signing pair (not a TL3 encryption key).
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);publicKey.kid='test';publicKey.alg='RS256';
 const originalFetch=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({keys:[publicKey]})});
 const unsigned=b64({alg:'RS256',kid:'test'})+'.'+b64(good);
 const sig=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(unsigned))).toString('base64url');
 assert.equal(await verifyScoreIdentity('Bearer '+unsigned+'.'+sig),'123:1');
 assert.equal(await verifyScoreIdentity('Bearer '+unsigned+'.'+sig.slice(0,-8)+'AAAAAAAA'),null);
 global.fetch=originalFetch;fs.rmSync(dir,{recursive:true});console.log('PASS OIDC trust boundary, expiry, signature and tampering');
})().catch(e=>{console.error(e);process.exitCode=1});
