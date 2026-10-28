const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('src/routes/score.ts','utf8');
const start=src.indexOf("router.post('/scores/v5/:reference/draft'");
const end=src.indexOf('\n});',start)+4;
let handler;
vm.runInNewContext(src.slice(start,end).replaceAll('.first<any>()','.first()'),{
 router:{post:(_path,fn)=>{handler=fn;}},v5ScoreUser:async()=>1,
 lookupV5Score:async()=>({file_id:178,user_id:1}),console
});
let reads=0;
const c={req:{param:()=> '178',text:()=>{throw Error('must not read retired analysis payload');}},
 env:{DB:{prepare:sql=>{assert.match(sql,/SELECT rights_role/);reads++;return {bind:()=>({first:async()=>({rights_declared:1,rights_role:'owner'})})};}}},
 json:(body,status)=>({body,status})};
(async()=>{const result=await handler(c);assert.equal(result.status,409);assert.equal(result.body.code,'VOCAL_ANALYSIS_NOT_READY');assert.equal(result.body.retryable,false);assert.equal(reads,1);assert.match(src,/can_generate:false/);console.log('PASS retired analysis rejected before payload processing or writes');})().catch(e=>{console.error(e);process.exitCode=1;});
