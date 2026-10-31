/** V5 central broadcast settlement policy. Pure arithmetic; does not credit wallets. */
export const CENTRAL_BROADCAST_V5 = Object.freeze({
  /** Initial 70% promotional discount: 0.3 of nominal 1 TL/second. */
  discountCoefficientBps: 3000n,
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
export function calculateCentralBroadcastAllocation(playedSeconds: bigint, discountCoefficientBps: bigint = CENTRAL_BROADCAST_V5.discountCoefficientBps): BroadcastAllocation {
  if (playedSeconds < 0n) throw new RangeError('playedSeconds must be nonnegative');
  const atoms=calculateCentralBroadcastAtoms(playedSeconds*1000n,discountCoefficientBps);
  // Hundredths are a legacy display precision. Truncation may lose atom dust;
  // the 10,000-atom allocation remains authoritative for actual settlement.
  const creatorHundredths=atoms.creatorAtoms/100n;
  const platformHundredths=atoms.platformAtoms/100n;
  return {totalHundredths:creatorHundredths+platformHundredths,creatorHundredths,platformHundredths};
}

/**
 * Calculate with the V5 ledger's 10,000 atoms per TL.
 * Fractional played seconds are supported at millisecond resolution.
 * Call only with verified audible music milliseconds (not DJ/news/buffering).
 * Rounding occurs once per event; no ledger posting is performed here.
 */
export function calculateCentralBroadcastAtoms(playedMilliseconds: bigint, discountCoefficientBps: bigint = CENTRAL_BROADCAST_V5.discountCoefficientBps): {
  totalAtoms: bigint; creatorAtoms: bigint; platformAtoms: bigint;
} {
  if (playedMilliseconds < 0n) throw new RangeError('playedMilliseconds must be nonnegative');
  if (discountCoefficientBps < 0n || discountCoefficientBps > 10_000n)
    throw new RangeError('Discount coefficient must be between 0 and 1 (basis points)');
  // 1 TL/sec = 10 atoms/ms; coefficient expressed in basis points.
  // Default 3000 bps: 1000 ms => 3000 atoms, creator 2100, platform 900.
  const totalAtoms = (playedMilliseconds * discountCoefficientBps) / 1000n;
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


/**
 * Daily local-midnight TILO settlement may cross a monthly progressive bracket.
 * Charge only the difference between the cumulative monthly assessments.
 * Caller MUST serialize settlements for each rights-holder + settlement month,
 * verify airtime and rights, and atomically persist the resulting delta with
 * an idempotency key in the V5 ledger before advancing the monthly watermark.
 */
export function calculateTiloCreatorContributionDelta(
  previousMonthlyGrossAtoms: bigint,
  newlySettledGrossAtoms: bigint,
): {
  nextMonthlyGrossAtoms: bigint;
  additionalContributionAtoms: bigint;
  newlySettledNetAtoms: bigint;
  cumulativeContributionAtoms: bigint;
  policyVersion: string;
} {
  if (previousMonthlyGrossAtoms < 0n || newlySettledGrossAtoms < 0n)
    throw new RangeError('Monthly gross and settlement increment must be nonnegative');
  const nextMonthlyGrossAtoms = previousMonthlyGrossAtoms + newlySettledGrossAtoms;
  const before = calculateTiloCreatorMonthlyContribution(previousMonthlyGrossAtoms);
  const after = calculateTiloCreatorMonthlyContribution(nextMonthlyGrossAtoms);
  const additionalContributionAtoms = after.contributionAtoms - before.contributionAtoms;
  if (additionalContributionAtoms < 0n || additionalContributionAtoms > newlySettledGrossAtoms)
    throw new RangeError('Invalid incremental contribution');
  return {
    nextMonthlyGrossAtoms,
    additionalContributionAtoms,
    newlySettledNetAtoms: newlySettledGrossAtoms - additionalContributionAtoms,
    cumulativeContributionAtoms: after.contributionAtoms,
    policyVersion: after.policyVersion,
  };
}


/**
 * Verified broadcaster evidence, NOT a listener play event or scheduled slot.
 * The trusted ingestion layer must authenticate the service, confirm broadcast
 * rights for the country/time, and deduplicate eventId in durable storage.
 */
export type TiloVerifiedAirtimeEvent = {
  eventId: string;
  country: 'KR'|'JP'|'US'|'CN'|'TH'|'VN';
  creatorId: number;
  fileId: number;
  startedAt: string;
  endedAt: string;
  audibleMs: number;
};

const TILO_SETTLEMENT_TIME_ZONES: Record<TiloVerifiedAirtimeEvent['country'],string> = {
  KR:'Asia/Seoul', JP:'Asia/Tokyo', US:'America/New_York',
  CN:'Asia/Shanghai', TH:'Asia/Bangkok', VN:'Asia/Ho_Chi_Minh',
};

/** Determine a local calendar month; never use UTC month for a country's settlement. */
export function tiloLocalSettlementMonth(country:TiloVerifiedAirtimeEvent['country'], isoTime:string):string {
  const time = new Date(isoTime);
  if(!Number.isFinite(time.getTime()) || !/Z$|[+-]\\d{2}:\\d{2}$/.test(isoTime))
    throw new RangeError('Timestamp must be valid ISO-8601 with timezone');
  const parts = new Intl.DateTimeFormat('en-US',{
    timeZone:TILO_SETTLEMENT_TIME_ZONES[country],year:'numeric',month:'2-digit'
  }).formatToParts(time);
  const year=parts.find(p=>p.type==='year')?.value;
  const month=parts.find(p=>p.type==='month')?.value;
  if(!year||!month)throw new RangeError('Invalid local month');
  return year+'-'+month;
}

/**
 * Pure pre-ledger aggregation of already authenticated, unique audible events.
 * Reject duplicate IDs and events spanning local months. Split such events
 * upstream at local midnight, then persist each verified fragment separately.
 * Do not trust client-submitted playback duration or the /now station clock.
 */
export function aggregateVerifiedTiloMonthlyAirtime(events:readonly TiloVerifiedAirtimeEvent[]) {
  const seen=new Set<string>();
  const grouped=new Map<string,{country:string;month:string;creatorId:number;audibleMs:bigint;creatorAtoms:bigint;platformAtoms:bigint}>();
  for(const event of events){
    if(!event.eventId||event.eventId.length>200||seen.has(event.eventId))
      throw new RangeError('Missing or duplicate broadcast event ID');
    seen.add(event.eventId);
    if(!(event.country in TILO_SETTLEMENT_TIME_ZONES)||
       !Number.isSafeInteger(event.creatorId)||event.creatorId<=0||
       !Number.isSafeInteger(event.fileId)||event.fileId<=0||
       !Number.isSafeInteger(event.audibleMs)||event.audibleMs<=0)
      throw new RangeError('Invalid broadcast evidence');
    const start=new Date(event.startedAt).getTime(),end=new Date(event.endedAt).getTime();
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||
       end-start>3_600_000||event.audibleMs>end-start)
      throw new RangeError('Audible duration exceeds verified broadcast interval');
    const month=tiloLocalSettlementMonth(event.country,event.startedAt);
    // end-1ms belongs to the same month for half-open intervals.
    if(month!==tiloLocalSettlementMonth(event.country,new Date(end-1).toISOString()))
      throw new RangeError('Broadcast interval crosses local month boundary');
    const key=event.country+':'+month+':'+event.creatorId;
    const allocation=calculateCentralBroadcastAtoms(BigInt(event.audibleMs));
    const previous=grouped.get(key);
    grouped.set(key,{
      country:event.country,month,creatorId:event.creatorId,
      audibleMs:(previous?.audibleMs||0n)+BigInt(event.audibleMs),
      creatorAtoms:(previous?.creatorAtoms||0n)+allocation.creatorAtoms,
      platformAtoms:(previous?.platformAtoms||0n)+allocation.platformAtoms,
    });
  }
  return [...grouped.values()].sort((a,b)=>
    (a.country+':'+a.month+':'+a.creatorId).localeCompare(b.country+':'+b.month+':'+b.creatorId));
}
