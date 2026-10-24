/** TimeLink V5: adjudicated negative contribution and three-strike policy.
 * Proposal only. No production sanctions or wallet changes are triggered here.
 * Reports are allegations; only independently confirmed decisions count.
 */
export type ViolationKind =
  | 'false_creator_claim'
  | 'false_rightsholder_claim'
  | 'repeat_infringing_upload'
  | 'fraudulent_contribution'
  | 'malicious_false_report';
export type ViolationStatus = 'reported'|'under_review'|'confirmed'|'dismissed'|'reversed';
export interface ViolationDecision {
  caseId: string;
  userId: string;
  kind: ViolationKind;
  status: ViolationStatus;
  decidedAt?: string;
  reviewerId?: string;
  evidenceRef?: string;
  appealPending?: boolean;
}
export interface ViolationPolicy {
  version: string;
  penalties: Record<ViolationKind,number>;
  strikeLimit: number;
  suspendAt: number;
}
export const V5_VIOLATION_POLICY_DRAFT: ViolationPolicy = {
  version:'v5-negative-poc-draft-20261025',
  penalties:{
    false_creator_claim:150,
    false_rightsholder_claim:200,
    repeat_infringing_upload:200,
    fraudulent_contribution:120,
    malicious_false_report:100
  },
  strikeLimit:3,
  suspendAt:3
};
export function evaluateViolationDecisions(
  decisions: ViolationDecision[],
  policy: ViolationPolicy = V5_VIOLATION_POLICY_DRAFT
) {
  if (!policy.version || !Number.isSafeInteger(policy.strikeLimit) || policy.strikeLimit < 1 ||
      !Number.isSafeInteger(policy.suspendAt) || policy.suspendAt < 1) throw Error('INVALID_VIOLATION_POLICY');
  for (const kind of Object.keys(policy.penalties) as ViolationKind[]) {
    const value=policy.penalties[kind];
    if (!Number.isSafeInteger(value) || value < 0) throw Error('INVALID_VIOLATION_PENALTY');
  }
  const unique=new Map<string,ViolationDecision>();
  for (const d of decisions) {
    if (!d.caseId || !d.userId || !(d.kind in policy.penalties) ||
        !['reported','under_review','confirmed','dismissed','reversed'].includes(d.status)) throw Error('INVALID_VIOLATION_CASE');
    if (unique.has(d.caseId)) throw Error('DUPLICATE_VIOLATION_CASE');
    unique.set(d.caseId,d);
  }
  const userIds=new Set(decisions.map(d=>d.userId));
  if (userIds.size>1) throw Error('MIXED_VIOLATION_USERS');
  let negativePoints=0, strikes=0, pending=0;
  for (const d of unique.values()) {
    if (d.status==='reported'||d.status==='under_review') {pending++;continue;}
    if (d.status!=='confirmed') continue;
    if (!d.decidedAt || !d.reviewerId || !d.evidenceRef) throw Error('UNVERIFIED_CONFIRMED_CASE');
    // A pending appeal does not silently become a final sanction.
    if (d.appealPending) {pending++;continue;}
    negativePoints+=policy.penalties[d.kind];
    if (!Number.isSafeInteger(negativePoints)) throw Error('NEGATIVE_POC_OVERFLOW');
    strikes++;
  }
  return {
    userId:decisions[0]?.userId||null,policyVersion:policy.version,
    negativePoints,strikes,pending,
    threeOut:strikes>=policy.strikeLimit,
    suspensionRecommended:strikes>=policy.suspendAt
  };
}
