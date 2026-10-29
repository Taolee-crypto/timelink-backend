const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('src/routes/score.ts','utf8');
const start=src.indexOf("router.post('/scores/v5/:reference/draft'");
const end=src.indexOf('\n});',start)+4;
let handler;
let writes=0;
vm.runInNewContext(src.slice(start,end).replaceAll('.first<any>()','.first()').replaceAll('.json<any>()','.json()'),{
 router:{post:(_path,fn)=>{handler=fn;}},v5ScoreUser:async()=>1,
 lookupV5Score:async()=>({file_id:178,user_id:1,source_sha256:'a'.repeat(64),duration_ms:120000}),
 ensureV5ScoreDrafts:async()=>{},console
});
let payload;
const c={req:{param:()=> '178',json:async()=>payload},
 env:{DB:{prepare:sql=>({bind:()=>({
 first:async()=>({rights_declared:1,rights_role:'owner'}),
 run:async()=>{assert.match(sql,/INSERT INTO v5_track_score_drafts/);writes++;return {success:true};}
 })})}},json:(body,status)=>({body,status})};
(async()=>{
 payload={provenance:{method:'manual',engine:'reviewed-import-v1'},rights_confirmed:true,source_sha256:'a'.repeat(64),score_data:{
 part:'lead_vocal',melody:[{s:1,d:0.5,m:64,lyric:'사'},{s:1.5,d:0.5,m:67,lyric:'랑'}],
 chords:[{s:1,sym:'C'},{s:1.5,sym:'G7/B'}]}};
 let result=await handler(c);assert.equal(result.status,201);assert.equal(result.body.notes,2);assert.equal(writes,1);
 payload.score_data.part='mixed';result=await handler(c);assert.equal(result.status,422);assert.equal(result.body.code,'VOCAL_PART_REQUIRED');
 payload.score_data.part='vocal';payload.score_data.melody[1].s=0.5;
 result=await handler(c);assert.equal(result.status,422);assert.equal(result.body.code,'SCORE_NOTES_INVALID');
 payload.score_data.melody[1].s=1.5;payload.source_sha256='b'.repeat(64);
 result=await handler(c);assert.equal(result.status,422);assert.equal(result.body.code,'SCORE_SOURCE_MISMATCH');
 assert.equal(writes,1);
 assert.ok(src.includes('can_generate:canGenerate&&!!(c.env as any).V5_SCORE_WORKER_TOKEN'));
 assert.match(src,/VOCAL_ANALYSIS_NOT_READY/);
 console.log('PASS validated vocal draft import, malformed notes and source mismatch');
})().catch(e=>{console.error(e);process.exitCode=1;});
