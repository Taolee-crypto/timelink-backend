import { calculateCentralBroadcastAtoms } from './central-broadcast-v5-settlement';

/**
 * Check the financial amounts recorded by the trusted broadcaster.
 *
 * New records carry the administrator's discount coefficient and revision at
 * ingestion time. A later policy change must never reprice those records.
 * Legacy rows predate the snapshot columns: validate their persisted 70/30
 * split and maximum nominal rate, without inventing a historical coefficient.
 */
export type PersistedTiloAirtime = {
  audible_ms: number;
  creator_atoms: number;
  platform_atoms: number;
  discount_coefficient_bps?: number | null;
  discount_revision?: number | null;
};

export function auditPersistedTiloAirtime(row: PersistedTiloAirtime): {
  creatorAtoms: bigint;
  platformAtoms: bigint;
  totalAtoms: bigint;
  hasPolicySnapshot: boolean;
} {
  if (![row.audible_ms, row.creator_atoms, row.platform_atoms].every(Number.isSafeInteger) ||
      row.audible_ms <= 0 || row.audible_ms > 3_600_000 ||
      row.creator_atoms < 0 || row.platform_atoms < 0)
    throw new RangeError('INVALID_STORED_AIRTIME');

  const creatorAtoms = BigInt(row.creator_atoms);
  const platformAtoms = BigInt(row.platform_atoms);
  const totalAtoms = creatorAtoms + platformAtoms;
  const audibleMs = BigInt(row.audible_ms);
  if (totalAtoms > audibleMs * 10n ||
      creatorAtoms !== totalAtoms * 7n / 10n ||
      platformAtoms !== totalAtoms - creatorAtoms)
    throw new RangeError('AIRTIME_AMOUNT_MISMATCH');

  const hasPolicySnapshot = row.discount_coefficient_bps != null;
  if (hasPolicySnapshot) {
    const coefficient = row.discount_coefficient_bps!;
    if (!Number.isSafeInteger(coefficient) || coefficient < 0 || coefficient > 10_000 ||
        !Number.isSafeInteger(row.discount_revision) || Number(row.discount_revision) < 0)
      throw new RangeError('INVALID_DISCOUNT_SNAPSHOT');
    const expected = calculateCentralBroadcastAtoms(audibleMs, BigInt(coefficient));
    if (expected.creatorAtoms !== creatorAtoms || expected.platformAtoms !== platformAtoms)
      throw new RangeError('AIRTIME_AMOUNT_MISMATCH');
  } else if (row.discount_revision != null) {
    throw new RangeError('INVALID_DISCOUNT_SNAPSHOT');
  }

  return {creatorAtoms, platformAtoms, totalAtoms, hasPolicySnapshot};
}
