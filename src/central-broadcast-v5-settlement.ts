/** V5 central broadcast settlement policy. Pure arithmetic; does not credit wallets. */
export const CENTRAL_BROADCAST_V5 = Object.freeze({
  weightNumerator: 3n,
  weightDenominator: 10n,
  creatorNumerator: 7n,
  platformNumerator: 3n,
  splitDenominator: 10n,
});
export type BroadcastAllocation = {
  /** Hundredths of TL; the current ledger adapter must verify this precision before posting. */
  totalHundredths: bigint;
  creatorHundredths: bigint;
  platformHundredths: bigint;
};
/** Whole seconds only. Accumulate verified millisecond playback per event before calling. */
export function calculateCentralBroadcastAllocation(playedSeconds: bigint): BroadcastAllocation {
  if (playedSeconds < 0n) throw new RangeError('playedSeconds must be nonnegative');
  // 1 second × 0.3 TL = 30 hundredths; creator 21, platform 9.
  const totalHundredths = playedSeconds * 30n;
  const creatorHundredths = playedSeconds * 21n;
  const platformHundredths = totalHundredths - creatorHundredths;
  return { totalHundredths, creatorHundredths, platformHundredths };
}

/**
 * Calculate with the V5 ledger's 10,000 atoms per TL.
 * Fractional played seconds are supported at millisecond resolution.
 * Call only with verified audible music milliseconds (not DJ/news/buffering).
 * Rounding occurs once per event; no ledger posting is performed here.
 */
export function calculateCentralBroadcastAtoms(playedMilliseconds: bigint): {
  totalAtoms: bigint; creatorAtoms: bigint; platformAtoms: bigint;
} {
  if (playedMilliseconds < 0n) throw new RangeError('playedMilliseconds must be nonnegative');
  // 1,000 ms => 0.3 TL => 3,000 TL atoms; creator 2,100, platform 900.
  const totalAtoms = (playedMilliseconds * 3n + 0n) / 1n;
  const creatorAtoms = (totalAtoms * 7n) / 10n;
  return { totalAtoms, creatorAtoms, platformAtoms: totalAtoms - creatorAtoms };
}
