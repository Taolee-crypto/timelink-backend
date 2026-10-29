const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {buildSync}=require('esbuild'),{Miniflare}=require('miniflare');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'score-runtime-'));
const file=path.join(dir,'worker.mjs');
buildSync({stdin:{loader:'ts',resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import score from './src/routes/score';const app=new Hono().route('/api/v1',score);export default app;`},bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:file,logLevel:'silent'});
(async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='fixture';jwk.alg='RS256';
 const n=Math.floor(Date.now()/1000),b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const p={iss:'https://token.actions.githubusercontent.com',aud:'https://api.timelink.digital/v5-vocal-score',repository:'Taolee-crypto/timelink-backend',repository_id:'1162984214',repository_owner_id:'85010918',ref:'refs/heads/main',sub:'repo:Taolee-crypto/timelink-backend:environment:production',environment:'production',runner_environment:'github-hosted',workflow_ref:'Taolee-crypto/timelink-backend/.github/workflows/v5-vocal-inference.yml@refs/heads/main',event_name:'workflow_dispatch',iat:n,nbf:n,exp:n+300,run_id:'123',run_attempt:'1'};
 const u=b({alg:'RS256',kid:'fixture'})+'.'+b(p);const sig=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(u))).toString('base64url');
 let redirect=false;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-01-01',script:fs.readFileSync(file,'utf8'),d1Databases:['DB'],async outboundService(req){assert.equal(req.url,'https://token.actions.githubusercontent.com/.well-known/jwks');return redirect?new Response(null,{status:302,headers:{Location:'https://untrusted.invalid'}}):Response.json({keys:[jwk]});}});
 try{
  const url='http://localhost/api/v1/scores/v5/internal/claim';
  assert.equal((await mf.dispatchFetch(url,{method:'POST'})).status,403);
  const options={method:'POST',headers:{Authorization:'Bearer '+u+'.'+sig}};
  const response=await mf.dispatchFetch(url,options);assert.equal(response.status,200);assert.equal((await response.json()).job,null);
  const db=await mf.getD1Database('DB');
  await db.exec("INSERT INTO v5_score_jobs(file_id,owner_id,source_sha256,status,worker_run_id) VALUES(178,1,'fixture','running','other:1');");
  assert.equal((await mf.dispatchFetch('http://localhost/api/v1/scores/v5/internal/complete/178',options)).status,409);
  const fail=await mf.dispatchFetch('http://localhost/api/v1/scores/v5/internal/fail/178',{...options,body:JSON.stringify({code:'TEST_FAILURE'})});assert.equal((await fail.json()).ok,false);
  assert.equal((await db.prepare('SELECT status FROM v5_score_jobs WHERE file_id=178').first()).status,'running');
  redirect=true;assert.equal((await mf.dispatchFetch(url,options)).status,403);
  console.log('PASS actual workerd OIDC verification, redirect rejection and run ownership');
 }finally{await mf.dispose();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
