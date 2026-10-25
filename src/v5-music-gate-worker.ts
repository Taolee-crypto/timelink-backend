import type { Env } from './types';
import { getD1ObjectMeta, readD1Range } from './d1-storage';
import { analyzeGateAudio, GateAnalysisError, MAX_GATE_AUDIO_BYTES, MUSIC_GATE_PIPELINE_VERSION } from './v5-music-gate-provider';

const MAX_ATTEMPTS=3;
type Job={id:string;user_id:number;source_key:string;source_sha256:string;
  registration_mode:string;analysis_attempts:number};
export function musicGateConfiguration(env:Env) {
  return {enabled:env.MUSIC_GATE_ANALYSIS_ENABLED==='true',
    providerConfigured:!!env.MUSIC_GATE_GEMINI_API_KEY&&/^gemini-[a-zA-Z0-9._-]{1,100}$/.test(env.MUSIC_GATE_GEMINI_MODEL||'')};
}
export async function musicGateHealth(env:Env) {
  const config=musicGateConfiguration(env);
  try {
    await env.DB.prepare('SELECT analysis_token,evidence_sha256 FROM v5_music_gate_reviews LIMIT 1').first();
    const last=await env.DB.prepare('SELECT created_at,to_status FROM v5_music_gate_audit ORDER BY id DESC LIMIT 1')
      .first<{created_at:string;to_status:string}>();
    return {ok:true,pipeline_version:MUSIC_GATE_PIPELINE_VERSION,...config,schema_ready:true,
      ready:config.enabled&&config.providerConfigured,automatic_approval_enabled:false,
      last_event_at:last?.created_at||null,last_event_status:last?.to_status||null};
  }catch {return {ok:false,pipeline_version:MUSIC_GATE_PIPELINE_VERSION,...config,
    schema_ready:false,ready:false,automatic_approval_enabled:false};}
}
async function hashBytes(bytes:Uint8Array):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
/** One bounded job per cron, with a durable lease shared by every Worker instance. */
export async function runMusicGateAnalysis(env:Env, request:typeof fetch=fetch) {
  const config=musicGateConfiguration(env);
  if(!config.enabled||!config.providerConfigured)return {processed:0,state:'not_configured'};
  const now=Math.floor(Date.now()/1000);
  // Schema readiness is checked before any claim or external API call.
  if(!(await musicGateHealth(env)).schema_ready)return {processed:0,state:'schema_not_ready'};
  // A dead worker cannot leave a permanent analyzing row. Preserve the retry budget.
  await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status=CASE WHEN analysis_attempts>=? THEN 'review_required' ELSE 'pending_analysis' END,
    analysis_token=NULL,analysis_lease_until=NULL,analysis_error='ANALYSIS_LEASE_EXPIRED',
    reasons_json='["ANALYSIS_LEASE_EXPIRED"]',updated_at=datetime('now')
    WHERE status='analyzing' AND analysis_token IS NOT NULL AND analysis_lease_until<=?`)
    .bind(MAX_ATTEMPTS,now).run();
  const job=await env.DB.prepare(`SELECT id,user_id,source_key,source_sha256,registration_mode,analysis_attempts
    FROM v5_music_gate_reviews WHERE status='pending_analysis' AND analysis_attempts<? AND analysis_next_at<=?
    ORDER BY created_at,id LIMIT 1`).bind(MAX_ATTEMPTS,now).first<Job>();
  if(!job)return {processed:0,state:'idle'};
  const token=crypto.randomUUID(),attempt=Number(job.analysis_attempts)+1;
  const claimed=await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status='analyzing',analysis_token=?,
    analysis_lease_until=?,analysis_attempts=analysis_attempts+1,analysis_error=NULL,updated_at=datetime('now')
    WHERE id=? AND status='pending_analysis' AND analysis_attempts=? AND analysis_next_at<=?`)
    .bind(token,now+180,job.id,job.analysis_attempts,now).run();
  if(Number(claimed.meta?.changes)!==1)return {processed:0,state:'claim_conflict'};
  let evidence:Record<string,unknown>,reasons:string[],errorCode:string|null=null,retry=false;
  try {
    if(!job.source_key.startsWith(`tracks/u${job.user_id}/`)||!/^[a-f0-9]{64}$/.test(job.source_sha256))
      throw new GateAnalysisError('INVALID_SOURCE_BINDING',false);
    // Intake stores in D1; do not fetch a client URL or silently read a different R2 object.
    const meta=await getD1ObjectMeta(env.DB,job.source_key);
    if(!meta)throw new GateAnalysisError('SOURCE_NOT_FOUND',false);
    if(meta.size<=0||meta.size>MAX_GATE_AUDIO_BYTES)
      throw new GateAnalysisError('AUDIO_ANALYSIS_SIZE_LIMIT',false);
    const audio=await readD1Range(env.DB,job.source_key,0,meta.size);
    if(await hashBytes(audio)!==job.source_sha256)throw new GateAnalysisError('SOURCE_HASH_MISMATCH',false);
    const result=await analyzeGateAudio(audio,{apiKey:env.MUSIC_GATE_GEMINI_API_KEY!,model:env.MUSIC_GATE_GEMINI_MODEL!},request);
    const a=result.analysis;
    reasons=[...a.risk_signals.map(s=>'AI_RISK_'+s.toUpperCase())];
    if(!a.audio_understood||!a.full_audio_reviewed||a.unsafe_content==='unknown')reasons.push('INCOMPLETE_AUDIO_UNDERSTANDING');
    if(a.music_probability<0.98&&a.speech_probability<0.98)reasons.push('UNCERTAIN_AUDIO_CLASSIFICATION');
    // Generative audio understanding cannot replace a decoder or independent rights search.
    reasons.push('INDEPENDENT_DECODE_REQUIRED','FINGERPRINT_VERIFICATION_UNAVAILABLE','CATALOG_VERIFICATION_UNAVAILABLE');
    evidence={pipeline_version:MUSIC_GATE_PIPELINE_VERSION,provider:'gemini',
      requested_model:env.MUSIC_GATE_GEMINI_MODEL,model_version:result.modelVersion,response_id:result.responseId,
      source_sha256:job.source_sha256,source_bytes:audio.length,registration_mode:job.registration_mode,
      analyzed_at:new Date().toISOString(),analysis_complete:a.audio_understood&&a.full_audio_reviewed,
      audio_analysis:a,decoded:null,fingerprint_matches:null,catalog_match:'unavailable',
      automatic_approval:false,rights_verified:false,rewards_approved:false};
  }catch(error) {
    const problem=error instanceof GateAnalysisError?error:new GateAnalysisError('ANALYSIS_STORAGE_ERROR',true);
    errorCode=problem.code;retry=problem.retryable&&attempt<MAX_ATTEMPTS;
    reasons=[problem.code];
    evidence={pipeline_version:MUSIC_GATE_PIPELINE_VERSION,source_sha256:job.source_sha256,
      analysis_complete:false,error:problem.code,attempt,automatic_approval:false,
      rights_verified:false,rewards_approved:false};
  }
  const encoded=JSON.stringify(evidence),digest=await hashBytes(new TextEncoder().encode(encoded));
  const next=retry?'pending_analysis':'review_required';
  const saved=await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status=?,reasons_json=?,
    classifier_version=?,evidence_json=?,evidence_sha256=?,analysis_error=?,analysis_token=NULL,
    analysis_lease_until=NULL,analysis_next_at=?,updated_at=datetime('now')
    WHERE id=? AND status='analyzing' AND analysis_token=? AND source_sha256=? AND analysis_lease_until>?`)
    .bind(next,JSON.stringify(reasons),MUSIC_GATE_PIPELINE_VERSION,encoded,digest,errorCode,
      now+Math.min(3600,60*2**attempt),job.id,token,job.source_sha256,Math.floor(Date.now()/1000)).run();
  return Number(saved.meta?.changes)===1?{processed:1,state:next,error:errorCode}:{processed:0,state:'lease_lost'};
}
