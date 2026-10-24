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
  dailyTlcBudgetAtoms: number;
  perUserDailyTlcCapAtoms: number;
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
  dailyTlcBudgetAtoms: 0, // fail closed until administrator explicitly funds a pool
  perUserDailyTlcCapAtoms: 0
};
function assertNonnegativeSafeInt(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_POC_'+field);
}
export function scorePocDay(events: PocEvent[], policy: PocPolicy = POC_V5_CONSERVATIVE_DRAFT) {
  if (!policy.version || !/^\d{4}-\d{2}-\d{2}$/.test(events[0]?.day || '2000-01-01'))
    throw new Error('INVALID_POC_POLICY_OR_DAY');
  assertNonnegativeSafeInt(policy.dailyPointCap,'POINT_CAP');
  const counts = new Map<PocActivity,number>();
  const targetCounts = new Map<string,number>();
  const seenIds = new Set<string>();
  let points = 0;
  let accepted = 0;
  const sorted = [...events].sort((a,b) => a.id.localeCompare(b.id));
  const user = sorted[0]?.userId;
  const day = sorted[0]?.day;
  for (const e of sorted) {
    if (e.userId !== user || e.day !== day || !e.id || !e.targetId)
      throw new Error('POC_MIXED_USER_DAY_OR_INVALID_EVENT');
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    if (!(e.activity in policy.pointsPerActivity)) throw new Error('UNKNOWN_POC_ACTIVITY');
    if (!Number.isInteger(e.qualityBps) || !Number.isInteger(e.trustBps) ||
        e.qualityBps < 0 || e.qualityBps > 10000 ||
        e.trustBps < 0 || e.trustBps > 10000) throw new Error('INVALID_POC_BPS');
    if (e.qualityBps < policy.minimumQualityBps || e.trustBps < policy.minimumTrustBps) continue;
    const count = counts.get(e.activity) || 0;
    const targetKey = e.activity+':'+e.targetId;
    const targetCount = targetCounts.get(targetKey) || 0;
    if (count >= policy.dailyEventCaps[e.activity] || targetCount >= policy.perTargetDailyCap) continue;
    const base = policy.pointsPerActivity[e.activity];
    assertNonnegativeSafeInt(base,'BASE_POINTS');
    const weighted = Math.floor(base * e.qualityBps * e.trustBps / 100000000);
    if (!Number.isSafeInteger(weighted)) throw new Error('POC_POINT_OVERFLOW');
    points = Math.min(policy.dailyPointCap,points+weighted);
    counts.set(e.activity,count+1);
    targetCounts.set(targetKey,targetCount+1);
    accepted++;
    if (points >= policy.dailyPointCap) break;
  }
  return {userId:user || null,day:day || null,policyVersion:policy.version,points,accepted,seen:seenIds.size};
}
/**
 * Pro-rata allocation with floor rounding; never exceed daily budget or per-user cap.
 * Residual atoms stay in the treasury (no automatic redistribution).
 */
export function allocatePocTlcDaily(
  scores: Array<{userId:string;points:number}>, policy: PocPolicy
): Array<{userId:string;points:number;tlcAtoms:number}> {
  assertNonnegativeSafeInt(policy.dailyTlcBudgetAtoms,'DAILY_BUDGET');
  assertNonnegativeSafeInt(policy.perUserDailyTlcCapAtoms,'USER_CAP');
  const ids = new Set<string>();
  let total = 0;
  for (const s of scores) {
    if (!s.userId || ids.has(s.userId)) throw new Error('DUPLICATE_POC_USER');
    ids.add(s.userId);
    assertNonnegativeSafeInt(s.points,'POINTS');
    if (s.points > policy.dailyPointCap) throw new Error('POC_POINTS_EXCEED_CAP');
    total += s.points;
    if (!Number.isSafeInteger(total)) throw new Error('POC_TOTAL_OVERFLOW');
  }
  return [...scores].sort((a,b)=>a.userId.localeCompare(b.userId)).map(s => ({
    userId:s.userId,points:s.points,
    tlcAtoms:total === 0 ? 0 : Math.min(policy.perUserDailyTlcCapAtoms,
      Math.floor(policy.dailyTlcBudgetAtoms * (s.points / total)))
  }));
}
