/** Owner-visible diagnostics only; never return the stored raw evidence or source key. */
export interface MusicGateDetailsRecord {
  status:string;
  source_sha256:string;
  evidence_json:string|null;
  reasons_json:string|null;
  analysis_error:string|null;
  analysis_attempts:number;
}
const riskNames=new Set([
  'credible_threat','targeted_harassment','hate_incitation','child_sexual_exploitation',
  'nonconsensual_intimate_content','private_personal_data','fraudulent_impersonation',
  'unlawful_instructions','profanity','sexual_audio','uncertain_context'
]);
const pendingChecks=new Set([
  'INDEPENDENT_DECODE_REQUIRED','FINGERPRINT_VERIFICATION_UNAVAILABLE','CATALOG_VERIFICATION_UNAVAILABLE'
]);
const errorNames=new Set([
  'AI_NOT_CONFIGURED','AUDIO_ANALYSIS_SIZE_LIMIT','AI_NETWORK_ERROR','INVALID_AI_OUTPUT',
  'INVALID_AI_RESPONSE','AI_SAFETY_BLOCKED','INCOMPLETE_AI_RESPONSE','ANALYSIS_STORAGE_ERROR',
  'INVALID_SOURCE_BINDING','SOURCE_NOT_FOUND','SOURCE_HASH_MISMATCH','ANALYSIS_LEASE_EXPIRED','ANALYSIS_LEASE_LOST','AI_REDIRECT_REJECTED'
]);
function parse(value:string|null):unknown {try{return JSON.parse(value||'null');}catch{return null;}}
export function creatorMusicGateDetails(record:MusicGateDetailsRecord) {
  const raw=parse(record.evidence_json);
  const evidence=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
  const audio=evidence.audio_analysis&&typeof evidence.audio_analysis==='object'&&!Array.isArray(evidence.audio_analysis)
    ?evidence.audio_analysis as Record<string,unknown>:null;
  const modelEvidence=evidence.provider==='gemini'&&evidence.source_sha256===record.source_sha256&&!!audio;
  const rawReasons=parse(record.reasons_json);
  const reasons=Array.isArray(rawReasons)?rawReasons.filter((v):v is string=>typeof v==='string'&&/^[A-Z0-9_]{1,100}$/.test(v)).slice(0,40):[];
  const rawError=record.analysis_error||'';
  const error=errorNames.has(rawError)||/^AI_HTTP_[1-5][0-9]{2}$/.test(rawError)?rawError:null;
  let state='not_started';
  if(record.status==='pending_analysis')state=error?'retry_wait':'queued';
  else if(record.status==='analyzing')state='analyzing';
  else if(error)state='failed';
  else if(modelEvidence)state=evidence.analysis_complete===true&&audio?.audio_understood===true&&audio?.full_audio_reviewed===true&&['clear','suspected'].includes(String(audio?.unsafe_content))?'complete':'incomplete';
  else if(evidence.submitted_by_admin_user_id)state='manual_evidence';
  const signals=modelEvidence&&Array.isArray(audio?.risk_signals)
    ?audio.risk_signals.filter((v):v is string=>typeof v==='string'&&riskNames.has(v)).slice(0,11):[];
  const stages=new Set(['queued','claimed','reading_source','hashing_source','encoding_audio','requesting_ai',
    'reading_ai_response','validating_ai_output','saving_result','finished']);
  const stage=typeof evidence.analysis_stage==='string'&&stages.has(evidence.analysis_stage)?evidence.analysis_stage:'unknown';
  const retryable=['ANALYSIS_LEASE_EXPIRED','AI_NETWORK_ERROR','INVALID_AI_OUTPUT','INVALID_AI_RESPONSE',
    'INCOMPLETE_AI_RESPONSE','ANALYSIS_STORAGE_ERROR','AI_HTTP_429','AI_HTTP_408'].includes(error||'')||/^AI_HTTP_5[0-9]{2}$/.test(error||'');
  return {
    analysis_status:state,analysis_error:error,
    analysis_stage:stage,retry_available:record.status==='review_required'&&retryable&&evidence.manual_retry_count!==1,
    analysis_retry_count:evidence.manual_retry_count===1?1:0,
    analysis_attempts:Number.isSafeInteger(record.analysis_attempts)&&record.analysis_attempts>=0?record.analysis_attempts:0,
    risk_signals:state==='complete'||state==='incomplete'?[...new Set(signals)]:[],
    verification_pending:reasons.filter(v=>pendingChecks.has(v)),
    analysis_limit_bytes:10*1024*1024
  };
}
