#!/usr/bin/env node
// Isolated D1-compatible SQLite integration; provider responses are deterministic mocks.
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tl-music-gate-'));
buildSync({stdin:{contents:`export * from './src/v5-music-gate-worker';
export * from './src/v5-music-gate-provider';
export * from './src/v5-music-gate-public-details';
export {default as admin} from './src/routes/v5-music-gate-admin';
export {makeAccessToken} from './src/auth';
export {default as worker} from './src/index';`,resolveDir:process.cwd(),loader:'ts'},
  bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
const api=require(path.join(temp,'api.cjs'));
const sqlite=new DatabaseSync(':memory:');
const db={prepare(sql){let args=[];const s={bind(...a){args=a;return s},
  async first(){return sqlite.prepare(sql).get(...args)||null},
  async all(){return {results:sqlite.prepare(sql).all(...args)}},
  async run(){const before=sqlite.prepare('SELECT total_changes() n').get().n;sqlite.prepare(sql).run(...args);return {meta:{changes:Number(sqlite.prepare('SELECT total_changes() n').get().n-before)}}}};return s;}};
const base=fs.readFileSync('migrations/20261025_v5_ai_music_gate_reviews.sql','utf8');
const migration=fs.readFileSync('migrations/20261025_v5_music_gate_analysis_worker.sql','utf8');
const autoApprovalMigration=fs.readFileSync('migrations/20261025_v5_music_gate_ai_autoapproval.sql','utf8');
const sha=b=>createHash('sha256').update(b).digest('hex');
let calls=0;
const clear={audio_understood:true,full_audio_reviewed:true,music_probability:0.99,
  speech_probability:0.01,unsafe_content:'clear',risk_signals:[],summary:'기악 테스트 응답'};
const response=(analysis=clear,overrides={})=>new Response(JSON.stringify({
  modelVersion:'gemini-test',responseId:'fixture-response',candidates:[{finishReason:'STOP',
    content:{parts:[{text:JSON.stringify(analysis)}]}}],...overrides}),{headers:{'Content-Type':'application/json'}});
const env={DB:db,JWT_SECRET:'fixture-jwt-secret',MUSIC_GATE_ANALYSIS_ENABLED:'true',
  MUSIC_GATE_GEMINI_MODEL:'gemini-fixture',MUSIC_GATE_GEMINI_API_KEY:'fixture-not-real-key',
  MUSIC_GATE_WORKER_SECRET:'fixture-worker-secret-32-characters-long'};
// These bytes test exact transport/hash preservation, not real-model accuracy.
let audio=Buffer.from([0xff,0xfb,0x90,0,1,2,3,4]),sequence=0;
function insert({hash,key,mode='original_creation',user=1}={}) {
  audio=Buffer.from([0xff,0xfb,0x90,0,1,2,3,++sequence]);hash=hash||sha(audio);
  const id=crypto.randomUUID();key=key||`tracks/u${user}/${id}.mp3`;
  sqlite.prepare("INSERT INTO v5_music_gate_reviews(id,user_id,source_key,source_sha256,registration_mode) VALUES(?,?,?,?,?)")
    .run(id,user,key,hash,mode);
  sqlite.prepare("INSERT OR REPLACE INTO tl_d1_objects VALUES(?,?,'audio/mpeg','fixture.mp3',1,'complete')").run(key,audio.length);
  sqlite.prepare('INSERT OR REPLACE INTO tl_d1_object_parts VALUES(?,1,?)').run(key,audio);
  return id;
}
const review=id=>sqlite.prepare('SELECT * FROM v5_music_gate_reviews WHERE id=?').get(id);
const mock=async(url,init)=>{
  calls++;assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
  assert.equal(init.headers['x-goog-api-key'],env.MUSIC_GATE_GEMINI_API_KEY);
  assert.equal(init.redirect,'manual');
  const body=JSON.parse(init.body);
  assert.deepEqual(Buffer.from(body.contents[0].parts[0].inlineData.data,'base64'),audio);
  return response();
};
async function main(){
  assert.equal((await api.runMusicGateAnalysis({...env,MUSIC_GATE_ANALYSIS_ENABLED:'false'},mock)).state,'not_configured');
  assert.equal((await api.runMusicGateAnalysis(env,mock)).state,'schema_not_ready');assert.equal(calls,0);
  sqlite.exec(base);
  sqlite.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER);
    INSERT INTO users VALUES(1,'user',1),(2,'admin',1),(3,'admin',0);
    CREATE TABLE tl_d1_objects(object_key TEXT PRIMARY KEY,size INTEGER,content_type TEXT,file_name TEXT,part_count INTEGER,status TEXT);
    CREATE TABLE tl_d1_object_parts(object_key TEXT,part_number INTEGER,data BLOB,PRIMARY KEY(object_key,part_number));`);
  const before=insert();sqlite.exec(migration);sqlite.exec(autoApprovalMigration);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM v5_music_gate_audit WHERE review_id=?').get(before).n,1);
  assert.equal((await api.musicGateHealth(env)).ready,true);
  console.log('PASS configuration/schema guards and migration with existing review');

  let result=await api.runMusicGateAnalysis(env,mock);assert.equal(result.state,'approved');
  let row=review(before);assert.equal(row.analysis_attempts,1);assert.equal(row.reviewer_user_id,null);
  assert.ok(row.decided_at);assert.equal(JSON.parse(row.evidence_json).automatic_approval,true);
  assert.throws(()=>sqlite.prepare("UPDATE v5_music_gate_reviews SET status='approved',reviewer_user_id=NULL,decided_at=datetime('now') WHERE id=?").run(insert()),/MUSIC_GATE_APPROVAL_REQUIRES_VERIFIED_AI_OR_REVIEWER/);
  assert.equal(row.evidence_sha256,sha(row.evidence_json));
  let evidence=JSON.parse(row.evidence_json);assert.equal(evidence.audio_analysis.music_probability,0.99);
  assert.equal(evidence.fingerprint_matches,null);assert.equal(evidence.decoded,null);
  assert.equal(evidence.rights_verified,false);assert.equal(evidence.rewards_approved,false);
  // Consume the queued pre-migration review; otherwise it precedes the negative fixtures.
  assert.equal((await api.runMusicGateAnalysis(env,mock)).state,'approved');assert.equal(calls,2);
  assert.throws(()=>sqlite.exec('DELETE FROM v5_music_gate_audit'),/IMMUTABLE/);
  assert.throws(()=>sqlite.exec("UPDATE v5_music_gate_audit SET to_status='approved'"),/IMMUTABLE/);
  console.log('PASS full-byte inference transport, hash-bound evidence, no fabricated checks, immutable audit');

  calls=1; // Keep the original fixture's provider-call baseline after the two valid approvals.
  let id=insert({hash:'a'.repeat(64)});await api.runMusicGateAnalysis(env,mock);
  assert.equal(review(id).analysis_error,'SOURCE_HASH_MISMATCH');assert.equal(calls,1);
  id=insert({key:'tracks/u99/foreign.mp3'});await api.runMusicGateAnalysis(env,mock);
  assert.equal(review(id).analysis_error,'INVALID_SOURCE_BINDING');assert.equal(calls,1);
  id=insert();sqlite.prepare('UPDATE tl_d1_objects SET size=? WHERE object_key=?').run(11*1024*1024,review(id).source_key);
  await api.runMusicGateAnalysis(env,mock);assert.equal(review(id).analysis_error,'AUDIO_ANALYSIS_SIZE_LIMIT');
  assert.equal(calls,1);
  console.log('PASS altered source, foreign source and size limits never reach provider');

  id=insert();let retryCalls=0;
  const fail=async()=>{retryCalls++;return new Response('{}',{status:429})};
  for(let i=1;i<=3;i++){
    result=await api.runMusicGateAnalysis(env,fail);assert.equal(review(id).analysis_attempts,i);
    assert.equal(result.state,i===3?'review_required':'pending_analysis');
    if(i<3){assert.equal((await api.runMusicGateAnalysis(env,fail)).state,'idle');
      sqlite.prepare('UPDATE v5_music_gate_reviews SET analysis_next_at=0 WHERE id=?').run(id);}
  }
  assert.equal(retryCalls,3);assert.equal(review(id).analysis_error,'AI_HTTP_429');
  console.log('PASS bounded retry budget, backoff and exhausted-job exception review');

  id=insert();let release,started;
  const startedPromise=new Promise(r=>started=r),held=new Promise(r=>release=r);
  const running=api.runMusicGateAnalysis(env,async()=>{started();await held;return response()});
  await startedPromise;assert.equal((await api.runMusicGateAnalysis(env,mock)).state,'idle');
  release();assert.equal((await running).processed,1);assert.equal(review(id).analysis_attempts,1);
  console.log('PASS concurrent invocations share one durable claim');

  id=insert();result=await api.runMusicGateAnalysis(env,async()=>{
    sqlite.prepare("UPDATE v5_music_gate_reviews SET status='cancelled' WHERE id=?").run(id);return response();});
  assert.equal(result.state,'lease_lost');assert.equal(review(id).status,'cancelled');
  id=insert();sqlite.prepare("UPDATE v5_music_gate_reviews SET status='analyzing',analysis_token='dead',analysis_attempts=3,analysis_lease_until=0,evidence_json='{\"analysis_stage\":\"reading_source\"}' WHERE id=?").run(id);
  await api.runMusicGateAnalysis(env,mock);assert.equal(review(id).status,'review_required');
  assert.equal(review(id).analysis_error,'ANALYSIS_LEASE_EXPIRED');
  id=insert();sqlite.prepare("UPDATE v5_music_gate_reviews SET status='analyzing',analysis_token='dead',analysis_attempts=1,analysis_lease_until=0 WHERE id=?").run(id);
  await api.runMusicGateAnalysis(env,mock);assert.equal(review(id).status,'approved');assert.equal(review(id).analysis_attempts,2);
  assert.equal(review(id).analysis_error,null);
  assert.equal(JSON.parse(review(id).evidence_json).automatic_approval,true);
  console.log('PASS cancelled/expired work cannot overwrite decisions; dead workers recover');

  id=insert();await api.runMusicGateAnalysis(env,async()=>response({...clear,unsafe_content:'suspected',risk_signals:['targeted_harassment']}));
  assert.ok(JSON.parse(review(id).reasons_json).includes('AI_RISK_TARGETED_HARASSMENT'));
  assert.equal(review(id).status,'review_required');
  id=insert();await api.runMusicGateAnalysis(env,async()=>response(clear,{promptFeedback:{blockReason:'SAFETY'},candidates:[]}));
  assert.equal(review(id).analysis_error,'AI_SAFETY_BLOCKED');
  for(const value of [{...clear,music_probability:NaN},{...clear,risk_signals:['invented']}])
      assert.throws(()=>api.validateAudioAnalysis(value),/INVALID_AI_OUTPUT/);
  const contradictory=api.validateAudioAnalysis({...clear,risk_signals:['profanity']});
  assert.equal(contradictory.unsafe_content,'suspected');assert.equal(contradictory.provider_unsafe_content,'clear');assert.deepEqual(contradictory.risk_signals,['profanity']);
  assert.deepEqual(api.validateAudioAnalysis({...clear,unsafe_content:'suspected'}).risk_signals,['uncertain_context']);
  await assert.rejects(api.analyzeGateAudio(audio,{apiKey:'fixture',model:'gemini-fixture'},async()=>response(clear,{candidates:[{finishReason:'MAX_TOKENS'}]})),/INCOMPLETE_AI_RESPONSE/);
  await assert.rejects(api.analyzeGateAudio(audio,{apiKey:'fixture',model:'gemini-fixture'},async()=>new Response('x'.repeat(65537))),/INVALID_AI_RESPONSE/);
  await assert.rejects(api.analyzeGateAudio(audio,{apiKey:'fixture',model:'gemini-fixture'},async()=>{throw Error('secret upstream message')}),/AI_NETWORK_ERROR/);
  console.log('PASS risk triage, blocked/truncated/malformed/oversized responses and network failures');

  const token=await api.makeAccessToken(1,env.JWT_SECRET),adminToken=await api.makeAccessToken(2,env.JWT_SECRET);
  const inactiveToken=await api.makeAccessToken(3,env.JWT_SECRET);
  const req=(route,token,body)=>api.admin.request(route,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},env);
  assert.equal((await req('/reviews/'+id,token)).status,403);
  assert.equal((await req('/reviews/'+id,inactiveToken)).status,403);
  let res=await req('/reviews/'+id,adminToken);assert.equal(res.status,200);
  assert.ok((await res.json()).audit.length>=3);
  assert.equal((await api.admin.request('/automation/pending',{},env)).status,403);
  assert.equal((await api.admin.request('/automation/run',{method:'POST',headers:{'X-Music-Gate-Worker-Secret':'wrong'}},env)).status,403);
  assert.equal((await api.admin.request('/automation/health',{headers:{'X-Music-Gate-Worker-Secret':env.MUSIC_GATE_WORKER_SECRET}},env)).status,200);
  id=insert();res=await req('/reviews/'+id+'/analysis',adminToken,{
    source_sha256:review(id).source_sha256,classifier_version:'manual-fixture',decoded:true,
    music_probability:0.99,speech_probability:0.01,unsafe_content:'clear',fingerprint_matches:0,catalog_match:'not_found'});
  assert.equal(res.status,200);assert.equal((await res.json()).auto_technical_clearance,false);
  assert.equal(review(id).evidence_sha256,sha(review(id).evidence_json));
  res=await req('/reviews/'+id+'/decision',adminToken,{action:'approve',note:'Isolated fixture manual review',source_sha256:review(id).source_sha256});
  assert.equal(res.status,200);assert.equal(review(id).status,'approved');
  assert.equal((await req('/reviews/'+id+'/decision',adminToken,{action:'approve',note:'Repeated fixture manual review',source_sha256:review(id).source_sha256})).status,409);
  console.log('PASS admin/service authorization, manual evidence digest and one-time reviewer approval');

  res=await api.worker.fetch(new Request('https://fixture.test/api/v1/music-gate/reviews/'+id,{headers:{Authorization:'Bearer '+token}}),env,{});
  assert.equal(res.status,200);assert.equal((await res.json()).review_status,'approved');
  const other=insert({user:2});
  res=await api.worker.fetch(new Request('https://fixture.test/api/v1/music-gate/reviews/'+other,{headers:{Authorization:'Bearer '+token}}),env,{});
  assert.equal(res.status,404);
  res=await api.worker.fetch(new Request('https://fixture.test/api/v1/music-gate/health'),{...env,MUSIC_GATE_GEMINI_API_KEY:undefined},{});
  assert.equal(res.status,503);assert.equal((await res.json()).ready,false);
  console.log('PASS Creator bearer polling, owner isolation and truthful public readiness');

  const diagnosticRow={status:'review_required',source_sha256:'a'.repeat(64),analysis_attempts:1,analysis_error:null,
    reasons_json:JSON.stringify(['AI_RISK_PROFANITY','INDEPENDENT_DECODE_REQUIRED','CATALOG_VERIFICATION_UNAVAILABLE']),
    evidence_json:JSON.stringify({provider:'gemini',source_sha256:'a'.repeat(64),analysis_complete:true,
      source_key:'PRIVATE-SOURCE',summary:'PRIVATE-SUMMARY',audio_analysis:{audio_understood:true,full_audio_reviewed:true,unsafe_content:'suspected',
      risk_signals:['profanity','invented','profanity']}})};
  let diagnostic=api.creatorMusicGateDetails(diagnosticRow);
  assert.equal(diagnostic.analysis_status,'complete');assert.deepEqual(diagnostic.risk_signals,['profanity']);
  assert.equal(diagnostic.verification_pending.length,2);
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
  diagnostic=api.creatorMusicGateDetails({...diagnosticRow,analysis_error:'AI_HTTP_400'});
  assert.equal(diagnostic.analysis_status,'failed');assert.equal(diagnostic.analysis_error,'AI_HTTP_400');
  assert.deepEqual(diagnostic.risk_signals,[]);
  diagnostic=api.creatorMusicGateDetails({...diagnosticRow,status:'pending_analysis',analysis_error:'AI_HTTP_429'});
  assert.equal(diagnostic.analysis_status,'retry_wait');
  diagnostic=api.creatorMusicGateDetails({...diagnosticRow,evidence_json:'{"provider":"gemini","source_sha256":"wrong","audio_analysis":{"risk_signals":["profanity"]}}'});
  assert.equal(diagnostic.analysis_status,'not_started');assert.deepEqual(diagnostic.risk_signals,[]);
  diagnostic=api.creatorMusicGateDetails({...diagnosticRow,evidence_json:'invalid json',reasons_json:'{}',analysis_error:'PRIVATE-ERROR'});
  assert.equal(diagnostic.analysis_status,'not_started');assert.equal(diagnostic.analysis_error,null);
  console.log('PASS owner diagnostics distinguish real inference, provider errors and missing checks without raw evidence');


  res=await api.worker.fetch(new Request('https://fixture.test/api/v1/music-gate/reviews',{headers:{Authorization:'Bearer '+token}}),env,{});
  assert.equal(res.status,200);const history=await res.json();assert.equal(history.account_id,1);
  assert.ok(history.reviews.some(r=>r.review_id===id));assert.ok(!history.reviews.some(r=>r.review_id===other));
  assert.ok(!JSON.stringify(history).includes('source_key'));assert.ok(!JSON.stringify(history).includes('evidence_json'));
  assert.ok(history.reviews.length<=20);
  res=await api.worker.fetch(new Request('https://fixture.test/api/v1/music-gate/reviews'),env,{});
  assert.equal(res.status,401);
  res=await api.worker.fetch(new Request('https://fixture.test/api/v1/music-gate/reviews/'+other,{headers:{Authorization:'Bearer '+token}}),env,{});
  assert.equal(res.status,404);const absent=await res.json();assert.equal(absent.account_id,1);assert.equal(absent.error,'REVIEW_NOT_FOUND');
  console.log('PASS recent reviews: current account only, bounded history, no private evidence and indistinguishable foreign/missing IDs');


  sqlite.exec("UPDATE v5_music_gate_reviews SET status='cancelled' WHERE status='pending_analysis'");
  const leaseRetryId=insert();
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='ANALYSIS_LEASE_EXPIRED',analysis_attempts=3 WHERE id=?").run(leaseRetryId);
  await assert.rejects(api.requestMusicGateRetry(env,2,leaseRetryId),/REVIEW_NOT_FOUND/);
  const retry=await api.requestMusicGateRetry(env,1,leaseRetryId);assert.equal(retry.review_status,'pending_analysis');
  assert.equal(review(leaseRetryId).analysis_attempts,0);assert.equal(JSON.parse(review(leaseRetryId).evidence_json).manual_retry_count,1);
  assert.equal((await api.requestMusicGateRetry(env,1,leaseRetryId)).review_status,'pending_analysis');
  await api.runMusicGateAnalysis(env,mock);
  assert.equal(JSON.parse(review(leaseRetryId).evidence_json).analysis_stage,'finished');
  assert.equal(JSON.parse(review(leaseRetryId).evidence_json).manual_retry_count,1);
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='ANALYSIS_LEASE_EXPIRED' WHERE id=?").run(leaseRetryId);
  await assert.rejects(api.requestMusicGateRetry(env,1,leaseRetryId),/ANALYSIS_RETRY_EXHAUSTED/);
  const stages=[];await api.analyzeGateAudio(audio,{apiKey:'fixture',model:'gemini-fixture',onStage:async stage=>stages.push(stage)},async()=>response());
  assert.deepEqual(stages,['encoding_audio','requesting_ai','reading_ai_response','validating_ai_output']);
  console.log('PASS stage checkpoints and explicit owner retry: wrong owner denied, one retry cycle, no re-upload, bounded reset');


  const recoveredId=insert();
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='ANALYSIS_LEASE_EXPIRED',analysis_attempts=3,evidence_json=? WHERE id=?").run(JSON.stringify({analysis_stage:'queued',manual_retry_count:1}),recoveredId);
  await api.recoverUnstartedMusicGateAnalyses(env);
  assert.equal(review(recoveredId).status,'pending_analysis');assert.equal(review(recoveredId).analysis_attempts,0);
  assert.equal(JSON.parse(review(recoveredId).evidence_json).cas_metadata_recovered,1);
  assert.equal(JSON.parse(review(recoveredId).evidence_json).manual_retry_count,1);
  await api.runMusicGateAnalysis(env,mock);
  assert.equal(JSON.parse(review(recoveredId).evidence_json).analysis_stage,'finished');
  assert.equal(JSON.parse(review(recoveredId).evidence_json).cas_metadata_recovered,1);
  const changed=await db.prepare('UPDATE v5_music_gate_reviews SET analysis_attempts=analysis_attempts+1 WHERE id=?').bind(recoveredId).run();
  assert.equal(changed.meta.changes,2); // review update plus its audit trigger, matching D1 metadata
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='ANALYSIS_LEASE_EXPIRED',evidence_json=? WHERE id=?").run(JSON.stringify({analysis_stage:'queued',cas_metadata_recovered:1,manual_retry_count:1}),recoveredId);
  await api.recoverUnstartedMusicGateAnalyses(env);assert.equal(review(recoveredId).status,'review_required');
  const manualId=insert();
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='ANALYSIS_LEASE_EXPIRED',evidence_json=? WHERE id=?").run(JSON.stringify({submitted_by_admin_user_id:2}),manualId);
  await api.recoverUnstartedMusicGateAnalyses(env);assert.equal(review(manualId).status,'review_required');
  console.log('PASS D1 total_changes audit semantics: RETURNING CAS, automatic recovery once, no human evidence or real-start recovery');


  await assert.rejects(api.analyzeGateAudio(audio,{apiKey:'fixture',model:'gemini-fixture'},async()=>new Response(null,{status:302,headers:{Location:'https://unexpected.invalid'}})),/AI_REDIRECT_REJECTED/);
  console.log('PASS Worker-compatible manual redirect handling never follows a credentials-bearing request');


  const redirectId=insert();
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='AI_NETWORK_ERROR',analysis_attempts=3,evidence_json=? WHERE id=?").run(JSON.stringify({analysis_stage:'requesting_ai',manual_retry_count:1}),redirectId);
  await api.recoverInvalidRedirectMusicGateAnalyses(env);
  assert.equal(review(redirectId).status,'pending_analysis');
  await api.runMusicGateAnalysis(env,mock);
  assert.equal(JSON.parse(review(redirectId).evidence_json).fetch_redirect_recovered,1);
  assert.equal(JSON.parse(review(redirectId).evidence_json).analysis_stage,'finished');
  sqlite.prepare("UPDATE v5_music_gate_reviews SET status='review_required',analysis_error='AI_NETWORK_ERROR',evidence_json=? WHERE id=?").run(JSON.stringify({analysis_stage:'requesting_ai',fetch_redirect_recovered:1}),redirectId);
  await api.recoverInvalidRedirectMusicGateAnalyses(env);assert.equal(review(redirectId).status,'review_required');
  console.log('PASS one-time recovery of pre-transmission Worker redirect failures preserves the existing review');

  console.log('ALL MUSIC GATE INTEGRATION CHECKS PASSED (mock provider; live inference not tested)');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sqlite.close();fs.rmSync(temp,{recursive:true,force:true})});
