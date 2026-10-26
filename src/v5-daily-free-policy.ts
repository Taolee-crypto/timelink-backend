/** V5 economy rebuild: pure calculations, no balance mutation or automatic activation. */
export const DAILY_FREE_VERSION = '2026-10-26';
const HOUR_MS = 3_600_000;
export const TL_ATOMS = 10_000;

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_' + name);
  return value;
}
function integer(value: number, name: string): number {
  nonnegative(value, name);
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_' + name);
  return value;
}
export function dailyFreeProduct(level: number) {
  integer(level, 'LEVEL');
  if (level < 1 || level > 24) throw new Error('INVALID_LEVEL');
  return {
    code: `TL-${level}`, level, dailyIncludedMs: level * HOUR_MS,
    monthlyPriceKrw: 900 + level * 1000,
    miningMode: 'individual' as const,
    miningIndexTlcPerHour: level <= 3 ? level * 0.02 : Number((0.08 + (level - 4) * 0.005).toFixed(3)),
    overageTlPerSecond: 1,
  };
}
export function dailyFreeCatalogue() {
  return Array.from({ length: 24 }, (_, i) => dailyFreeProduct(i + 1));
}

/** Call once for each UNIQUE server-verified interval, split at the billing-day boundary.
 * The caller must atomically store usage and post the returned debit with an idempotency key.
 * No client-reported playback duration or timezone may be passed as authoritative usage.
 */
export function quoteDailyUsage(level: number, usedMs: number, verifiedDeltaMs: number) {
  const product = dailyFreeProduct(level);
  integer(usedMs, 'USED_MS'); integer(verifiedDeltaMs, 'DELTA_MS');
  const nextUsedMs = usedMs + verifiedDeltaMs;
  integer(nextUsedMs, 'TOTAL_MS');
  if (nextUsedMs > 24 * HOUR_MS) throw new Error('DAILY_WALL_CLOCK_LIMIT');
  const includedMs = Math.min(verifiedDeltaMs, Math.max(0, product.dailyIncludedMs - usedMs));
  const overageMs = verifiedDeltaMs - includedMs;
  return {
    nextUsedMs, includedMs, overageMs,
    remainingIncludedMs: Math.max(0, product.dailyIncludedMs - nextUsedMs),
    // 1 TL/second at 10,000 atoms/TL is exactly 10 atoms/ms: no per-heartbeat rounding.
    debitAtoms: overageMs * 10,
  };
}

/** Downward-only adjustment proposal. Never runs automatically or changes paid rewards.
 * reference/recent values use the same window and units. Price must be a verified
 * aggregate; pass null when there is insufficient trading evidence.
 */
export function proposeMiningIndex(input: {
  initialIndex: number; currentIndex: number; referenceVolume: number;
  recentVolume: number; referencePrice: number; verifiedPrice: number | null;
}) {
  for (const [key, value] of Object.entries(input)) {
    if (value !== null) nonnegative(value, key);
  }
  if (input.referenceVolume === 0 || input.referencePrice === 0) throw new Error('INVALID_REFERENCE');
  if (input.currentIndex > input.initialIndex) throw new Error('INVALID_CURRENT_INDEX');
  const supplyFactor = input.recentVolume > input.referenceVolume
    ? input.referenceVolume / input.recentVolume : 1;
  const valueFactor = input.verifiedPrice !== null && input.verifiedPrice > input.referencePrice
    ? input.referencePrice / input.verifiedPrice : 1;
  return Math.min(input.currentIndex, input.initialIndex * supplyFactor * valueFactor);
}

/** Preview only. Coefficient must be explicitly calibrated in TLC per listening HOUR
 * per PoC unit; the legacy TL_P coefficient 0.08 is NOT a default here.
 */
export function previewMining(listenMs: number, pocWithoutListen: number,
  calibratedTlcPerHour: number, multiplier: number, capTlc: number) {
  integer(listenMs, 'LISTEN_MS');
  for (const value of [pocWithoutListen, calibratedTlcPerHour, multiplier, capTlc]) nonnegative(value, 'MINING_INPUT');
  const estimate = listenMs / HOUR_MS * pocWithoutListen * calibratedTlcPerHour * multiplier;
  if (!Number.isFinite(estimate)) throw new Error('MINING_OVERFLOW');
  return Math.min(capTlc, estimate);
}
