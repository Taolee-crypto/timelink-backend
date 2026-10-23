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
