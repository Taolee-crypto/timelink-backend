// Real Cloudflare runtime; all outbound responses are local fixtures, with no real keys or audio.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild'),{Miniflare}=require('miniflare');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'music-gate-workerd-'));
const outfile=path.join(dir,'worker.mjs');
buildSync({stdin:{loader:'ts',resolveDir:process.cwd(),contents:`
import {analyzeGateAudio} from './src/v5-music-gate-provider';
export default {async fetch(request:Request){
  try {
    if(new URL(request.url).pathname==='/unsupported') {
      await fetch('https://fixture.invalid',{redirect:'error'});
      return Response.json({unexpected:true});
    }
    const result=await analyzeGateAudio(new Uint8Array([255,251,144,0,1,2,3,4]),{apiKey:'fixture-not-a-real-key',model:'gemini-fixture'});
    return Response.json({ok:true,result});
  }catch(error:any){return Response.json({ok:false,name:error.name,error:error.code||null,message:error.message});}
}};`},bundle:true,format:'esm',platform:'browser',target:'es2022',outfile,logLevel:'silent'});
let count=0,redirect=false;
const mf=new Miniflare({modules:true,compatibilityDate:'2024-01-01',script:fs.readFileSync(outfile,'utf8'),
  async outboundService(request){
    count++;
    assert.equal(new URL(request.url).hostname,'generativelanguage.googleapis.com');
    assert.equal(request.headers.get('x-goog-api-key'),'fixture-not-a-real-key');
    const body=await request.json();assert.equal(body.contents[0].parts[0].inlineData.data,'//uQAAECAwQ=');
    if(redirect)return new Response(null,{status:302,headers:{Location:'https://unexpected.invalid'}});
    const analysis={audio_understood:true,full_audio_reviewed:true,music_probability:0.99,speech_probability:0.01,
      unsafe_content:'clear',risk_signals:[],summary:'fixture'};
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(analysis)}]}}]});
  }
});
(async()=>{
  const unsupported=await (await mf.dispatchFetch('http://localhost/unsupported')).json();
  assert.equal(unsupported.name,'TypeError');assert.ok(unsupported.message.includes('redirect'));assert.equal(count,0);
  const success=await (await mf.dispatchFetch('http://localhost/analyze')).json();
  assert.equal(success.ok,true,JSON.stringify(success));assert.equal(count,1);
  redirect=true;
  const blocked=await (await mf.dispatchFetch('http://localhost/analyze')).json();
  assert.equal(blocked.error,'AI_REDIRECT_REJECTED');assert.equal(count,2);
  console.log('PASS real workerd: unsupported redirect reproduces; manual mode reaches mocked AI; redirects do not forward credentials');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await mf.dispose();fs.rmSync(dir,{recursive:true,force:true})});
