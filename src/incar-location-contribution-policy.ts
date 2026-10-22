/**
 * V5 in-car location contribution policy.
 * This module defines eligibility ONLY. It never reads/stores GPS, credits POC,
 * issues TL_A/TL_B, or changes consent. All awards require server-side verification,
 * anti-abuse limits, an admin-controlled rate, and V5 ledger idempotency.
 */
export type LocationContributionEvent =
  | { kind: 'consent_recorded'; userId: number; consentVersion: string; at: number }
  | { kind: 'location_service_used'; userId: number; sessionId: string; at: number; consentActive: boolean; locationFresh: boolean; verifiedListening: boolean }
  | { kind: 'local_ad_completed'; userId: number; adImpressionId: string; at: number; verifiedListening: boolean; consentActive: boolean };

export type ContributionEligibility = {
  eligible: boolean;
  pocCategory: 'location_consent' | 'location_service' | 'ad_listening' | null;
  tlBucket: 'TL_A' | 'TL_B' | null;
  reason: string;
};

export function evaluateLocationContribution(event: LocationContributionEvent): ContributionEligibility {
  if (!Number.isSafeInteger(event.userId) || event.userId <= 0 || !Number.isFinite(event.at) || event.at <= 0)
    return { eligible: false, pocCategory: null, tlBucket: null, reason: 'invalid_event' };
  if (event.kind === 'consent_recorded') {
    if (!event.consentVersion.trim()) return { eligible: false, pocCategory: null, tlBucket: null, reason: 'missing_consent_version' };
    // Record consent participation once per consent version, never pay for simply opting in.
    return { eligible: true, pocCategory: 'location_consent', tlBucket: null, reason: 'consent_audit_only' };
  }
  if (!event.consentActive || !event.verifiedListening)
    return { eligible: false, pocCategory: null, tlBucket: null, reason: 'no_consent_or_unverified_listening' };
  if (event.kind === 'location_service_used') {
    if (!event.sessionId.trim() || !event.locationFresh)
      return { eligible: false, pocCategory: null, tlBucket: null, reason: 'missing_session_or_stale_location' };
    return { eligible: true, pocCategory: 'location_service', tlBucket: 'TL_B', reason: 'subject_to_admin_rate_and_limits' };
  }
  if (!event.adImpressionId.trim())
    return { eligible: false, pocCategory: null, tlBucket: null, reason: 'missing_impression' };
  return { eligible: true, pocCategory: 'ad_listening', tlBucket: 'TL_A', reason: 'subject_to_verified_completion_and_ad_budget' };
}
