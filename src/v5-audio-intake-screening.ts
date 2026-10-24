/** TimeLink V5 upload preflight: conservative metadata/signal triage.
 * This module never adjudicates copyright, profanity, sexuality, or strikes.
 * Signal statistics MUST be measured server-side from decoded audio, not user input.
 */
export type AudioRegistrationMode = 'original_creation'|'existing_release_share';
export interface AudioSignalEvidence {
  durationSeconds:number;
  sampleRateHz:number;
  channels:number;
  decoded:boolean;
  silentFraction:number; // 0..1, measured over windows
  clippingFraction:number; // 0..1
  exactRepeatFraction:number; // 0..1, measured from signal fingerprint windows
}
export interface AudioIntakeInput {
  mode:AudioRegistrationMode;
  fileBytes:number;
  declaredMime:string;
  detectedMime:string; // server magic/decoder determination
  title:string;
  artist:string;
  signal:AudioSignalEvidence;
}
export type AudioIntakeReason =
  | 'INVALID_FILE'|'MIME_MISMATCH'|'DECODE_FAILED'|'INVALID_DURATION'
  | 'MOSTLY_SILENT'|'HEAVY_CLIPPING'|'REPEATED_SIGNAL'
  | 'MISSING_METADATA'|'EXTERNAL_CATALOG_MATCH_REQUIRED';
export interface AudioIntakeResult {
  decision:'reject_technical'|'hold_for_review'|'pass_preflight';
  reasons:AudioIntakeReason[];
  canPublish:boolean;
  canEarnRewards:boolean;
  requiresCatalogLookup:boolean;
}
const allowed=new Set(['audio/mpeg','audio/mp4','audio/wav','audio/flac','audio/ogg','audio/webm']);
export function screenAudioIntake(input:AudioIntakeInput):AudioIntakeResult {
  const reasons:AudioIntakeReason[]=[];
  const s=input.signal;
  const finite=(v:number)=>Number.isFinite(v);
  if (!['original_creation','existing_release_share'].includes(input.mode) ||
      !Number.isSafeInteger(input.fileBytes) || input.fileBytes<=0 ||
      !allowed.has(input.detectedMime) || !input.title.trim() || !input.artist.trim()) {
    reasons.push('INVALID_FILE');
    if (!input.title.trim() || !input.artist.trim()) reasons.push('MISSING_METADATA');
  }
  if (input.declaredMime!==input.detectedMime) reasons.push('MIME_MISMATCH');
  if (!s.decoded) reasons.push('DECODE_FAILED');
  if (!finite(s.durationSeconds) || s.durationSeconds<=0 || s.durationSeconds>4*3600 ||
      !Number.isSafeInteger(s.sampleRateHz) || s.sampleRateHz<=0 ||
      !Number.isSafeInteger(s.channels) || s.channels<1 || s.channels>8) reasons.push('INVALID_DURATION');
  if (![s.silentFraction,s.clippingFraction,s.exactRepeatFraction].every(v=>finite(v)&&v>=0&&v<=1)) reasons.push('INVALID_FILE');
  else {
    if (s.silentFraction>=0.95) reasons.push('MOSTLY_SILENT');
    if (s.clippingFraction>=0.20) reasons.push('HEAVY_CLIPPING');
    if (s.exactRepeatFraction>=0.95) reasons.push('REPEATED_SIGNAL');
  }
  if (input.mode==='existing_release_share') reasons.push('EXTERNAL_CATALOG_MATCH_REQUIRED');
  const technical=new Set<AudioIntakeReason>(['INVALID_FILE','DECODE_FAILED','INVALID_DURATION']);
  const decision=reasons.some(r=>technical.has(r))?'reject_technical':reasons.length?'hold_for_review':'pass_preflight';
  return {
    decision,reasons,canPublish:decision==='pass_preflight',
    canEarnRewards:decision==='pass_preflight',
    requiresCatalogLookup:input.mode==='existing_release_share'
  };
}
