/** TimeLink V5 AI Music Gate: MP3 intake approval BEFORE TL3 conversion.
 * Pure decision engine; real audio ML inference, catalog lookup and fingerprint
 * matching must be implemented by trusted server-side adapters.
 * Do not accept client-supplied evidence as authoritative.
 */
import { screenAudioIntake, type AudioIntakeInput } from './v5-audio-intake-screening';

export type GateState = 'approved_for_tl3'|'review_required'|'rejected_technical';
export interface TrustedMusicEvidence {
  /** Provider-reported confidence, not a copyright ownership determination. */
  musicProbability: number|null;
  speechProbability: number|null;
  audioFingerprintMatches: number;
  catalogMatch: 'matched'|'not_found'|'unavailable'|'not_required';
  unsafeContent: 'clear'|'suspected'|'unknown';
  classifierVersion: string;
}
export interface GateDecision {
  state:GateState;
  reasons:string[];
  allowTl3Conversion:boolean;
  allowPublication:boolean;
  allowRewards:boolean;
  rightsVerificationRequired:boolean;
  evidenceVersion:string;
}
function probability(v:number|null) {
  return v===null || (Number.isFinite(v)&&v>=0&&v<=1);
}
export function decideMusicGate(input:AudioIntakeInput, evidence:TrustedMusicEvidence):GateDecision {
  if (!evidence.classifierVersion ||
      !probability(evidence.musicProbability) || !probability(evidence.speechProbability) ||
      !Number.isSafeInteger(evidence.audioFingerprintMatches) || evidence.audioFingerprintMatches<0 ||
      !['matched','not_found','unavailable','not_required'].includes(evidence.catalogMatch) ||
      !['clear','suspected','unknown'].includes(evidence.unsafeContent)) {
    throw Error('INVALID_TRUSTED_MUSIC_EVIDENCE');
  }
  // This gate is explicitly for pre-conversion MP3 intake; other formats need a separate policy.
  const preflight=screenAudioIntake(input);
  if (input.detectedMime!=='audio/mpeg') {
    return {state:'rejected_technical',reasons:['MP3_REQUIRED_FOR_THIS_GATE'],
      allowTl3Conversion:false,allowPublication:false,allowRewards:false,
      rightsVerificationRequired:true,evidenceVersion:evidence.classifierVersion};
  }
  const reasons:string[]=[...preflight.reasons];
  if (evidence.musicProbability===null || evidence.speechProbability===null) reasons.push('CLASSIFICATION_UNAVAILABLE');
  // A low music score alone cannot reject experimental music or spoken-word art.
  // Route uncertain content to review, not an irreversible strike.
  else if (evidence.musicProbability<0.30 && evidence.speechProbability>0.80) reasons.push('POSSIBLE_SPOKEN_AUDIO_MISLABELING');
  if (evidence.unsafeContent!=='clear') reasons.push('CONTENT_REVIEW_REQUIRED');
  if (evidence.audioFingerprintMatches>0) reasons.push('FINGERPRINT_MATCH_REVIEW');
  if (input.mode==='existing_release_share' && evidence.catalogMatch!=='matched') reasons.push('CATALOG_VERIFICATION_REQUIRED');
  if (input.mode==='original_creation' && evidence.catalogMatch==='matched') reasons.push('POSSIBLE_EXISTING_RELEASE');
  const state:GateState=preflight.decision==='reject_technical'?'rejected_technical':
    reasons.length?'review_required':'approved_for_tl3';
  return {
    state,reasons:[...new Set(reasons)],
    allowTl3Conversion:state==='approved_for_tl3',
    // A separate rights/registration workflow must approve publication and payouts.
    allowPublication:false,allowRewards:false,
    rightsVerificationRequired:true,evidenceVersion:evidence.classifierVersion
  };
}
