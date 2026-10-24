/**
 * TimeLink V5 PoC reward policy — isolated proposal implementation.
 * Not wired into issuance or settlement. All quantities are integer units.
 * Administrators may change parameters only through a versioned, approved policy.
 */
export type PocActivity = 'qualified_listen' | 'verified_share' | 'helpful_comment' | 'meaningful_like' | 'verified_upload';
export interface PocEvent {
  id: string;
  userId: string;
  activity: PocActivity;
  targetId: string;
  day: string; // YYYY-MM-DD in configured settlement timezone
  qualityBps: number; // 0..10000, established by anti-abuse verification
  trustBps: number; // 0..10000, established by account risk controls
  distinctCounterparty?: string;
}
export interface PocPolicy {
  version: string;
  pointsPerActivity: Record<PocActivity, number>;
  dailyEventCaps: Record<PocActivity, number>;
  perTargetDailyCap: number;
  dailyPointCap: number;
  minimumQualityBps: number;
  minimumTrustBps: number;
}
export const POC_V5_CONSERVATIVE_DRAFT: PocPolicy = {
  version: 'poc-v5-draft-20261025',
  pointsPerActivity: {
    qualified_listen: 10,
    verified_share: 15,
    helpful_comment: 8,
    meaningful_like: 2,
    verified_upload: 40
  },
  dailyEventCaps: {
    qualified_listen: 20,
    verified_share: 5,
    helpful_comment: 8,
    meaningful_like: 10,
    verified_upload: 2
  },
  perTargetDailyCap: 2,
  dailyPointCap: 250,
  minimumQualityBps: 6000,
  minimumTrustBps: 7000,
};
function assertNonnegativeSafeInt(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_POC_'+field);
}
export function scorePocDay(events: PocEvent[], policy: PocPolicy = POC_V5_CONSERVATIVE_DRAFT) {
  if (!policy.version || !/^\d{4}-\d{2}-\d{2}$/.test(events[0]?.day || '2000-01-01'))
    throw new Error('INVALID_POC_POLICY_OR_DAY');
  assertNonnegativeSafeInt(policy.dailyPointCap,'POINT_CAP');
  assertNonnegativeSafeInt(policy.perTargetDailyCap,'TARGET_CAP');
  for (const activity of Object.keys(policy.pointsPerActivity) as PocActivity[]) {
    assertNonnegativeSafeInt(policy.pointsPerActivity[activity], 'ACTIVITY_POINTS');
    assertNonnegativeSafeInt(policy.dailyEventCaps[activity], 'ACTIVITY_CAP');
  }
  if (!Number.isSafeInteger(policy.minimumQualityBps) ||
      !Number.isSafeInteger(policy.minimumTrustBps) ||
      policy.minimumQualityBps < 0 || policy.minimumQualityBps > 10000 ||
      policy.minimumTrustBps < 0 || policy.minimumTrustBps > 10000) {
    throw new Error('INVALID_POC_POLICY_THRESHOLDS');
  }
  const counts = new Map<PocActivity,number>();
  const targetCounts = new Map<string,number>();
  const seenIds = new Set<string>();
  let points = 0;
  let accepted = 0;
  const sorted = [...events].sort((a,b) => a.id.localeCompare(b.id));
  const user = sorted[0]?.userId;
  const day = sorted[0]?.day;
  for (const e of sorted) {
    if (e.userId !== user || e.day !== day || !e.id || !e.targetId || !e.userId)
      throw new Error('POC_MIXED_USER_DAY_OR_INVALID_EVENT');
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    if (!(e.activity in policy.pointsPerActivity)) throw new Error('UNKNOWN_POC_ACTIVITY');
    if (!Number.isInteger(e.qualityBps) || !Number.isInteger(e.trustBps) ||
        e.qualityBps < 0 || e.qualityBps > 10000 ||
        e.trustBps < 0 || e.trustBps > 10000) throw new Error('INVALID_POC_BPS');
    if (e.distinctCounterparty && e.distinctCounterparty === e.userId) continue;
    if (e.qualityBps < policy.minimumQualityBps || e.trustBps < policy.minimumTrustBps) continue;
    const count = counts.get(e.activity) || 0;
    const targetKey = e.activity+':'+e.targetId;
    const targetCount = targetCounts.get(targetKey) || 0;
    if (count >= policy.dailyEventCaps[e.activity] || targetCount >= policy.perTargetDailyCap) continue;
    const base = policy.pointsPerActivity[e.activity];
    assertNonnegativeSafeInt(base,'BASE_POINTS');
    // Avoid unsafe intermediate multiplication even when the final score is small.
    const product = BigInt(base) * BigInt(e.qualityBps) * BigInt(e.trustBps);
    const weightedBig = product / 100000000n;
    if (weightedBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('POC_POINT_OVERFLOW');
    const weighted = Number(weightedBig);
    points = Math.min(policy.dailyPointCap,points+weighted);
    counts.set(e.activity,count+1);
    targetCounts.set(targetKey,targetCount+1);
    accepted++;
    if (points >= policy.dailyPointCap) break;
  }
  return {userId:user || null,day:day || null,policyVersion:policy.version,points,accepted,seen:seenIds.size};
}
/**
 * PoC only evaluates verified contribution. It must NEVER mint TLC.
 * P2P TL/TLC trades transfer existing balances and NEVER create TLC supply.
 * Any separately authorized TLC issuance must use its own auditable ledger path.
 * Exchange eligibility and rates are not defined by PoC scoring.
 */
export function pocContributionOnly(events: PocEvent[], policy: PocPolicy = POC_V5_CONSERVATIVE_DRAFT) {
  return scorePocDay(events, policy);
}
