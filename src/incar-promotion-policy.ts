/**
 * TimeLink V5 — In-car promotion settlement policy.
 *
 * Promotion purchases are NOT ordinary TL3 playback royalties.
 * A creator pays for promotion from purchased TL_P; drivers listen free.
 * Central radio retains 100% of the promotion service revenue.
 * DJ-selected promotion broadcasts split revenue between the DJ and platform.
 * Cafe/DJ contracts and their 50/30/20 defaults are a separate product.
 *
 * This module only computes a validated policy snapshot. Charging and payout
 * MUST be posted atomically to the V5 ledger by a verified listening service.
 */
export type IncarPromotionChannel = 'central' | 'dj';

export interface IncarPromotionPolicy {
  /** integer basis points: 5000 = 50% */
  djShareBps: number;
  /** nonnegative, four-decimal TL per verified second */
  tlPerVerifiedSecond: number;
}

export const DEFAULT_INCAR_PROMOTION_POLICY: Readonly<IncarPromotionPolicy> = Object.freeze({
  djShareBps: 5000,
  tlPerVerifiedSecond: 1,
});

export function validateIncarPromotionPolicy(input: IncarPromotionPolicy): IncarPromotionPolicy {
  const { djShareBps, tlPerVerifiedSecond } = input;
  if (!Number.isSafeInteger(djShareBps) || djShareBps < 0 || djShareBps > 10000) {
    throw new Error('INVALID_DJ_PROMOTION_SHARE');
  }
  if (!Number.isFinite(tlPerVerifiedSecond) || tlPerVerifiedSecond < 0 ||
      Math.round(tlPerVerifiedSecond * 10000) !== tlPerVerifiedSecond * 10000) {
    throw new Error('INVALID_PROMOTION_RATE');
  }
  return { djShareBps, tlPerVerifiedSecond };
}

export function splitIncarPromotionAtoms(
  totalAtoms: number,
  channel: IncarPromotionChannel,
  policy: IncarPromotionPolicy = DEFAULT_INCAR_PROMOTION_POLICY,
): { djAtoms: number; platformAtoms: number } {
  validateIncarPromotionPolicy(policy);
  if (!Number.isSafeInteger(totalAtoms) || totalAtoms < 0) {
    throw new Error('INVALID_PROMOTION_AMOUNT');
  }
  if (channel !== 'central' && channel !== 'dj') throw new Error('INVALID_PROMOTION_CHANNEL');
  if (channel === 'dj') throw new Error('RETIRED_DJ_PROMOTION_CHANNEL');
  const djAtoms = 0; // DJ selection retired; only central promotion remains.
  return { djAtoms, platformAtoms: totalAtoms - djAtoms };
}

/** Read the administrator's in-car promotion policy; invalid settings fail closed. */
export async function getIncarPromotionPolicy(db: D1Database): Promise<IncarPromotionPolicy> {
  const row = await db.prepare("SELECT value FROM tl_settings WHERE key='incar_promotion_policy'").first<{value:string}>().catch(() => null);
  if (!row) return { ...DEFAULT_INCAR_PROMOTION_POLICY };
  return validateIncarPromotionPolicy(JSON.parse(row.value));
}
