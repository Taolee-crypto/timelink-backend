/** TimeLink V5 automated review policy. All evidence is server-side.
 * Automated technical clearance is NOT proof of ownership or permission to pay TL.
 */
export type MusicGateAutomationMode = 'manual'|'assisted'|'auto_low_risk';
export interface MusicGateAutomationPolicy {
  mode: MusicGateAutomationMode;
  minimumMusicConfidence: number;
  requireNoFingerprintMatch: boolean;
  requireClearSafetyResult: boolean;
  requireSuccessfulDecode: boolean;
}
export interface MusicGateAutomationEvidence {
  decoded: boolean;
  musicConfidence: number|null;
  safety: 'clear'|'suspected'|'unknown';
  fingerprintMatches: number;
  catalogVerified: boolean;
  registrationMode: 'original_creation'|'existing_release_share';
  classifierVersion: string;
}
export type MusicGateAutomationDecision = 'auto_technical_clearance'|'human_review'|'await_analysis';
export const DEFAULT_V5_MUSIC_GATE_AUTOMATION: MusicGateAutomationPolicy = {
  mode:'assisted',
  minimumMusicConfidence:0.98,
  requireNoFingerprintMatch:true,
  requireClearSafetyResult:true,
  requireSuccessfulDecode:true
};
export function decideMusicGateAutomation(
  evidence:MusicGateAutomationEvidence,
  policy:MusicGateAutomationPolicy=DEFAULT_V5_MUSIC_GATE_AUTOMATION
):MusicGateAutomationDecision {
  if (!evidence.classifierVersion || evidence.musicConfidence===null ||
      evidence.safety==='unknown') return 'await_analysis';
  if (!Number.isFinite(evidence.musicConfidence) ||
      evidence.musicConfidence<0 || evidence.musicConfidence>1 ||
      !Number.isSafeInteger(evidence.fingerprintMatches) || evidence.fingerprintMatches<0 ||
      !Number.isFinite(policy.minimumMusicConfidence) ||
      policy.minimumMusicConfidence<0 || policy.minimumMusicConfidence>1) return 'human_review';
  if (policy.mode!=='auto_low_risk') return 'human_review';
  if (policy.requireSuccessfulDecode&&!evidence.decoded) return 'human_review';
  if (policy.requireClearSafetyResult&&evidence.safety!=='clear') return 'human_review';
  if (policy.requireNoFingerprintMatch&&evidence.fingerprintMatches>0) return 'human_review';
  if (evidence.musicConfidence<policy.minimumMusicConfidence) return 'human_review';
  // Existing releases need independent rights verification, regardless of AI confidence.
  if (evidence.registrationMode==='existing_release_share'||evidence.catalogVerified) return 'human_review';
  return 'auto_technical_clearance';
}
