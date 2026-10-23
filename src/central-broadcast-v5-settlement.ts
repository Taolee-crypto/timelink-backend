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


/**
 * V5 TILO creator solidarity contribution, applied AFTER the 70/30 split.
 * Rates are marginal, not flat. All amounts are integer TL atoms (10,000/TL).
 * This pure calculation is deliberately separate from wallet posting:
 * only an approved, versioned monthly settlement may post ledger entries.
 */
export const TILO_CREATOR_CONTRIBUTION_V1 = Object.freeze({
  atomsPerTl: 10_000n,
  // Monthly creator TILO gross reward thresholds in TL.
  thresholdsTl: [100_000n, 500_000n, 2_000_000n, 5_000_000n],
  // Marginal basis points: 0%, 5%, 10%, 15%, 20%.
  ratesBps: [0n, 500n, 1_000n, 1_500n, 2_000n],
  policyVersion: 'tilo-creator-contribution-v1',
});

/** Never assess per track: aggregate all rights-holder TILO allocations per local calendar month first. */
export function calculateTiloCreatorMonthlyContribution(grossCreatorAtoms: bigint): {
  grossCreatorAtoms: bigint;
  contributionAtoms: bigint;
  netCreatorAtoms: bigint;
  effectiveRateBps: bigint;
  policyVersion: string;
} {
  if (grossCreatorAtoms < 0n) throw new RangeError('grossCreatorAtoms must be nonnegative');
  const { atomsPerTl, thresholdsTl, ratesBps, policyVersion } = TILO_CREATOR_CONTRIBUTION_V1;
  let previous = 0n;
  let contributionAtoms = 0n;
  for (let i = 0; i < ratesBps.length; i++) {
    const upper = i < thresholdsTl.length ? thresholdsTl[i] * atomsPerTl : grossCreatorAtoms;
    const taxable = grossCreatorAtoms > previous
      ? (grossCreatorAtoms < upper ? grossCreatorAtoms : upper) - previous
      : 0n;
    // Integer math: round down once per bracket; no floating-point drift.
    contributionAtoms += (taxable * ratesBps[i]) / 10_000n;
    previous = upper;
    if (previous >= grossCreatorAtoms) break;
  }
  return {
    grossCreatorAtoms,
    contributionAtoms,
    netCreatorAtoms: grossCreatorAtoms - contributionAtoms,
    effectiveRateBps: grossCreatorAtoms === 0n ? 0n : (contributionAtoms * 10_000n) / grossCreatorAtoms,
    policyVersion,
  };
}

/**
 * Initial POC redemption eligibility proposal; distinct from cash/TL exchange price.
 * Not enabled for payouts until admin-approved, verified POC snapshot and funding checks.
 */
export function tiloCreatorRedemptionRateBps(pocIndex: number): number {
  if (!Number.isFinite(pocIndex) || pocIndex < 0.1 || pocIndex > 5) {
    throw new RangeError('POC index must be in [0.1, 5]');
  }
  return pocIndex >= 4 ? 8000 : pocIndex >= 3 ? 6000 : pocIndex >= 2 ? 4000 : pocIndex >= 1 ? 2000 : 1000;
}
