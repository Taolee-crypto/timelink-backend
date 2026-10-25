import type { Env } from './types';
import { getD1ObjectMeta, readD1Range } from './d1-storage';
import { analyzeGateAudio, GateAnalysisError, MAX_GATE_AUDIO_BYTES, MUSIC_GATE_PIPELINE_VERSION } from './v5-music-gate-provider';

const MAX_ATTEMPTS=3;
type Job={id:string;user_id:number;source_key:string;source_sha256:string;
  registration_mode:string;analysis_attempts:number;evidence_json:string|null};
function retryCount(encoded:string|null):number {
  try{return JSON.parse(encoded||'{}').manual_retry_count===1?1:0;}catch{return 0;}
}
function metadataRecoveryCount(encoded:string|null):number {
  try{return JSON.parse(encoded||'{}').cas_metadata_recovered===1?1:0;}catch{return 0;}
}
function redirectRecoveryCount(encoded:string|null):number {
  try{return JSON.parse(encoded||'{}').fetch_redirect_recovered===1?1:0;}catch{return 0;}
}
/** Pre-fix Worker requests failed before transmission because redirect:error was unsupported. */
export async function recoverInvalidRedirectMusicGateAnalyses(env:Env) {
  const valid="CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END";
  await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status='pending_analysis',analysis_attempts=0,
    analysis_token=NULL,analysis_lease_until=NULL,analysis_next_at=0,analysis_error=NULL,
    reasons_json='["SYSTEM_RECOVERY_WORKER_FETCH_REDIRECT"]',evidence_sha256=NULL,
    evidence_json=json_set(${valid},'$.fetch_redirect_recovered',1,'$.analysis_stage','queued'),
    updated_at=datetime('now') WHERE id IN (
      SELECT id FROM v5_music_gate_reviews WHERE status='review_required' AND analysis_error='AI_NETWORK_ERROR'
      AND json_extract(${valid},'$.analysis_stage')='requesting_ai'
      AND COALESCE(json_extract(${valid},'$.fetch_redirect_recovered'),0)=0
      AND json_type(${valid},'$.audio_analysis') IS NULL
      AND json_extract(${valid},'$.submitted_by_admin_user_id') IS NULL
      AND COALESCE(json_extract(${valid},'$.analysis_complete'),0)=0
      ORDER BY created_at,id LIMIT 20
    )`).run();
}
/** Repair only expired jobs that never reached the first analysis checkpoint.
 * A durable marker prevents repeated recovery. Completed inference, human evidence,
 * approvals, rejections and jobs that actually started source processing are excluded.
 */
export async function recoverUnstartedMusicGateAnalyses(env:Env) {
  const valid="CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END";
  await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status='pending_analysis',analysis_attempts=0,
    analysis_token=NULL,analysis_lease_until=NULL,analysis_next_at=0,analysis_error=NULL,
    reasons_json='["SYSTEM_RECOVERY_D1_CHANGE_METADATA"]',evidence_sha256=NULL,
    evidence_json=json_set(${valid},'$.cas_metadata_recovered',1,'$.analysis_stage','queued'),
    updated_at=datetime('now') WHERE id IN (
      SELECT id FROM v5_music_gate_reviews WHERE status='review_required' AND analysis_error='ANALYSIS_LEASE_EXPIRED'
      AND COALESCE(json_extract(${valid},'$.analysis_stage'),'') IN ('','queued','claimed')
      AND COALESCE(json_extract(${valid},'$.cas_metadata_recovered'),0)=0
      AND json_type(${valid},'$.audio_analysis') IS NULL
      AND json_extract(${valid},'$.submitted_by_admin_user_id') IS NULL
      AND COALESCE(json_extract(${valid},'$.analysis_complete'),0)=0
      ORDER BY created_at,id LIMIT 20
    )`).run();
}
export function retryableMusicGateError(code:string|null):boolean {
  return ['ANALYSIS_LEASE_EXPIRED','AI_NETWORK_ERROR','INVALID_AI_OUTPUT','INVALID_AI_RESPONSE',
    'INCOMPLETE_AI_RESPONSE','ANALYSIS_STORAGE_ERROR','AI_HTTP_429','AI_HTTP_408'].includes(code||'')||/^AI_HTTP_5[0-9]{2}$/.test(code||'');
}
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
      ready:config.enabled&&config.providerConfigured,automatic_approval_enabled:false,upload_requires_ai_approval:false,screening_mode:'profanity_advisory',
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
  try{await env.DB.prepare('SELECT analysis_token,evidence_sha256 FROM v5_music_gate_reviews LIMIT 1').first();}
  catch{return {processed:0,state:'schema_not_ready'};}
  // A dead worker cannot leave a permanent analyzing row. Preserve the retry budget.
  await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status=CASE WHEN analysis_attempts>=? THEN 'review_required' ELSE 'pending_analysis' END,
    analysis_token=NULL,analysis_lease_until=NULL,analysis_error='ANALYSIS_LEASE_EXPIRED',
    reasons_json='["ANALYSIS_LEASE_EXPIRED"]',updated_at=datetime('now')
    WHERE status='analyzing' AND analysis_token IS NOT NULL AND analysis_lease_until<=?`)
    .bind(MAX_ATTEMPTS,now).run();
  await recoverUnstartedMusicGateAnalyses(env);
  await recoverInvalidRedirectMusicGateAnalyses(env);
  const job=await env.DB.prepare(`SELECT id,user_id,source_key,source_sha256,registration_mode,analysis_attempts,evidence_json
    FROM v5_music_gate_reviews WHERE status='pending_analysis' AND analysis_attempts<? AND analysis_next_at<=?
    ORDER BY created_at,id LIMIT 1`).bind(MAX_ATTEMPTS,now).first<Job>();
  if(!job)return {processed:0,state:'idle'};
  const token=crypto.randomUUID(),attempt=Number(job.analysis_attempts)+1;
  const claimed=await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status='analyzing',analysis_token=?,
    analysis_lease_until=?,analysis_attempts=analysis_attempts+1,analysis_error=NULL,updated_at=datetime('now')
    WHERE id=? AND status='pending_analysis' AND analysis_attempts=? AND analysis_next_at<=? RETURNING id`)
    .bind(token,now+180,job.id,job.analysis_attempts,now).first<{id:string}>();
  if(claimed?.id!==job.id)return {processed:0,state:'claim_conflict'};
  const manualRetryCount=retryCount(job.evidence_json);
  const metadataRecovered=metadataRecoveryCount(job.evidence_json);
  const redirectRecovered=redirectRecoveryCount(job.evidence_json);
  let stage='claimed';
  const progress=async (next:string)=>{
    stage=next;
    const value=JSON.stringify({pipeline_version:MUSIC_GATE_PIPELINE_VERSION,source_sha256:job.source_sha256,
      analysis_complete:false,analysis_stage:stage,stage_updated_at:new Date().toISOString(),manual_retry_count:manualRetryCount,cas_metadata_recovered:metadataRecovered,fetch_redirect_recovered:redirectRecovered});
    const digest=await hashBytes(new TextEncoder().encode(value));
    const result=await env.DB.prepare(`UPDATE v5_music_gate_reviews SET evidence_json=?,evidence_sha256=?,
      classifier_version=?,updated_at=datetime('now') WHERE id=? AND status='analyzing' AND analysis_token=? AND analysis_lease_until>? RETURNING id`)
      .bind(value,digest,MUSIC_GATE_PIPELINE_VERSION,job.id,token,Math.floor(Date.now()/1000)).first<{id:string}>();
    if(result?.id!==job.id)throw new GateAnalysisError('ANALYSIS_LEASE_LOST',false);
  };
  let evidence:Record<string,unknown>,reasons:string[],errorCode:string|null=null,retry=false;
  try {
    await progress('reading_source');
    if(!job.source_key.startsWith(`tracks/u${job.user_id}/`)||!/^[a-f0-9]{64}$/.test(job.source_sha256))
      throw new GateAnalysisError('INVALID_SOURCE_BINDING',false);
    // Intake stores in D1; do not fetch a client URL or silently read a different R2 object.
    const meta=await getD1ObjectMeta(env.DB,job.source_key);
    if(!meta)throw new GateAnalysisError('SOURCE_NOT_FOUND',false);
    if(meta.size<=0||meta.size>MAX_GATE_AUDIO_BYTES)
      throw new GateAnalysisError('AUDIO_ANALYSIS_SIZE_LIMIT',false);
    const audio=await readD1Range(env.DB,job.source_key,0,meta.size);
    await progress('hashing_source');
    if(await hashBytes(audio)!==job.source_sha256)throw new GateAnalysisError('SOURCE_HASH_MISMATCH',false);
    const result=await analyzeGateAudio(audio,{apiKey:env.MUSIC_GATE_GEMINI_API_KEY!,model:env.MUSIC_GATE_GEMINI_MODEL!,onStage:progress},request);
    await progress('saving_result');
    const a=result.analysis;
    // Advisory profanity screening only; these results do not gate manufacture.
    reasons=a.risk_signals.includes('profanity')?['AI_RISK_PROFANITY']:[];
    const autoApproved = a.audio_understood && a.full_audio_reviewed && a.unsafe_content === 'clear' &&
      a.music_probability >= 0.98 && a.risk_signals.length === 0;
    evidence={pipeline_version:MUSIC_GATE_PIPELINE_VERSION,provider:'gemini',analysis_stage:'finished',manual_retry_count:manualRetryCount,cas_metadata_recovered:metadataRecovered,fetch_redirect_recovered:redirectRecovered,
      requested_model:env.MUSIC_GATE_GEMINI_MODEL,model_version:result.modelVersion,response_id:result.responseId,
      source_sha256:job.source_sha256,source_bytes:audio.length,registration_mode:job.registration_mode,
      analyzed_at:new Date().toISOString(),analysis_complete:a.audio_understood&&a.full_audio_reviewed,
      audio_analysis:a,decoded:null,fingerprint_matches:null,catalog_match:'unavailable',
      automatic_approval:autoApproved,rights_verified:false,rewards_approved:false,
      auto_approval_basis:autoApproved?'verified_source_hash_and_complete_ai_audio_screening':null};
  }catch(error) {
    const problem=error instanceof GateAnalysisError?error:new GateAnalysisError('ANALYSIS_STORAGE_ERROR',true);
    errorCode=problem.code;retry=problem.retryable&&attempt<MAX_ATTEMPTS;
    reasons=[problem.code];
    evidence={pipeline_version:MUSIC_GATE_PIPELINE_VERSION,source_sha256:job.source_sha256,analysis_stage:stage,manual_retry_count:manualRetryCount,cas_metadata_recovered:metadataRecovered,fetch_redirect_recovered:redirectRecovered,
      analysis_complete:false,error:problem.code,analysis_detail:problem.detail||null,attempt,automatic_approval:false,
      rights_verified:false,rewards_approved:false};
  }
  const encoded=JSON.stringify(evidence),digest=await hashBytes(new TextEncoder().encode(encoded));
  const next=retry?'pending_analysis':(!errorCode && evidence.automatic_approval===true?'approved':'review_required');
  const saved=await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status=?,reasons_json=?,
    decided_at=CASE WHEN ?='approved' THEN datetime('now') ELSE decided_at END,
    classifier_version=?,evidence_json=?,evidence_sha256=?,analysis_error=?,analysis_token=NULL,
    analysis_lease_until=NULL,analysis_next_at=?,updated_at=datetime('now')
    WHERE id=? AND status='analyzing' AND analysis_token=? AND source_sha256=? AND analysis_lease_until>? RETURNING id`)
    .bind(next,JSON.stringify(reasons),next,MUSIC_GATE_PIPELINE_VERSION,encoded,digest,errorCode,
      now+Math.min(3600,60*2**attempt),job.id,token,job.source_sha256,Math.floor(Date.now()/1000)).first<{id:string}>();
  return saved?.id===job.id?{processed:1,state:next,error:errorCode}:{processed:0,state:'lease_lost'};
}

/** A single explicit owner retry for infrastructure failures. No approval or sanctions. */
export async function requestMusicGateRetry(env:Env,userId:number,id:string) {
  const record=await env.DB.prepare(`SELECT status,source_sha256,evidence_json,evidence_sha256,analysis_error
    FROM v5_music_gate_reviews WHERE id=? AND user_id=?`).bind(id,userId)
    .first<{status:string;source_sha256:string;evidence_json:string|null;evidence_sha256:string|null;analysis_error:string|null}>();
  if(!record)throw Error('REVIEW_NOT_FOUND');
  if(['pending_analysis','analyzing'].includes(record.status)&&retryCount(record.evidence_json)>=1)
    return {ok:true,review_id:id,review_status:record.status,analysis_status:record.status==='analyzing'?'analyzing':'queued',retry_available:false};
  if(record.status!=='review_required'||!retryableMusicGateError(record.analysis_error))throw Error('ANALYSIS_NOT_RETRYABLE');
  if(retryCount(record.evidence_json)>=1)throw Error('ANALYSIS_RETRY_EXHAUSTED');
  const evidence=JSON.stringify({pipeline_version:MUSIC_GATE_PIPELINE_VERSION,source_sha256:record.source_sha256,
    analysis_complete:false,analysis_stage:'queued',manual_retry_count:1,retry_requested_by_user_id:userId,
    cas_metadata_recovered:metadataRecoveryCount(record.evidence_json),fetch_redirect_recovered:redirectRecoveryCount(record.evidence_json),
    retry_requested_at:new Date().toISOString(),previous_error:record.analysis_error});
  const digest=await hashBytes(new TextEncoder().encode(evidence));
  const result=await env.DB.prepare(`UPDATE v5_music_gate_reviews SET status='pending_analysis',analysis_attempts=0,
    analysis_token=NULL,analysis_lease_until=NULL,analysis_next_at=0,analysis_error=NULL,reasons_json='["OWNER_REQUESTED_SYSTEM_RETRY"]',
    evidence_json=?,evidence_sha256=?,updated_at=datetime('now') WHERE id=? AND user_id=? AND status='review_required'
    AND analysis_error=? AND COALESCE(evidence_sha256,'')=? RETURNING id`)
    .bind(evidence,digest,id,userId,record.analysis_error,record.evidence_sha256||'').first<{id:string}>();
  if(result?.id!==id){
    const latest=await env.DB.prepare('SELECT status,evidence_json FROM v5_music_gate_reviews WHERE id=? AND user_id=?').bind(id,userId).first<{status:string;evidence_json:string|null}>();
    if(latest&&['pending_analysis','analyzing'].includes(latest.status)&&retryCount(latest.evidence_json)>=1)
      return {ok:true,review_id:id,review_status:latest.status,analysis_status:latest.status==='analyzing'?'analyzing':'queued',retry_available:false};
    throw Error('ANALYSIS_RETRY_CONFLICT');
  }
  return {ok:true,review_id:id,review_status:'pending_analysis',analysis_status:'queued',analysis_stage:'queued',retry_available:false};
}
