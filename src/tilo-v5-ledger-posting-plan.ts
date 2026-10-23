/**
 * V5 TILO ledger posting plan. Pure accounting instructions ONLY.
 * Do not treat this as authorization to issue TL: callers must independently
 * verify broadcast evidence, rights, funding, local-midnight cutoff, admin
 * policy approval and D1 transaction idempotency before posting.
 */
import { calculateTiloCreatorContributionDelta } from './central-broadcast-v5-settlement';

export type TiloPostingPlan = {
  policyVersion: string;
  grossCreatorAtoms: bigint;
  creatorNetAtoms: bigint;
  developmentContributionAtoms: bigint;
  platformRevenueAtoms: bigint;
  platformFundingAtoms: bigint;
  /** Signed amounts; balanced to zero. */
  entries: readonly { role: 'platform_funding'|'creator_reward'|'platform_revenue'|'development_contribution'; amountAtoms: bigint }[];
};

export function planTiloV5LedgerPosting(
  previousMonthlyCreatorGrossAtoms: bigint,
  newCreatorGrossAtoms: bigint,
  newPlatformShareAtoms: bigint,
): TiloPostingPlan {
  if ([previousMonthlyCreatorGrossAtoms,newCreatorGrossAtoms,newPlatformShareAtoms].some(x=>x<0n))
    throw new RangeError('Negative settlement amount');
  const delta=calculateTiloCreatorContributionDelta(previousMonthlyCreatorGrossAtoms,newCreatorGrossAtoms);
  const funding=newCreatorGrossAtoms+newPlatformShareAtoms;
  const entries=[
    {role:'platform_funding' as const,amountAtoms:-funding},
    {role:'creator_reward' as const,amountAtoms:delta.newlySettledNetAtoms},
    {role:'platform_revenue' as const,amountAtoms:newPlatformShareAtoms},
    {role:'development_contribution' as const,amountAtoms:delta.additionalContributionAtoms},
  ];
  if(entries.reduce((sum,e)=>sum+e.amountAtoms,0n)!==0n)
    throw new Error('UNBALANCED_TILO_SETTLEMENT');
  if(entries.some(e=>e.amountAtoms>BigInt(Number.MAX_SAFE_INTEGER)||e.amountAtoms< -BigInt(Number.MAX_SAFE_INTEGER)))
    throw new RangeError('Settlement exceeds safe ledger atom range');
  return {
    policyVersion:delta.policyVersion,
    grossCreatorAtoms:newCreatorGrossAtoms,
    creatorNetAtoms:delta.newlySettledNetAtoms,
    developmentContributionAtoms:delta.additionalContributionAtoms,
    platformRevenueAtoms:newPlatformShareAtoms,
    platformFundingAtoms:funding,
    entries,
  };
}
