/** Integer TL payouts with exact carry in 1/10,000 TL atoms.
 * Each beneficiary and funding source must have its own persisted carry key.
 * Persist returned carry and payout atomically with the corresponding ledger posting.
 */
export const TL_ATOMS_PER_UNIT=10000n;
export type CarrySettlement={wholeTl:bigint;carryAtoms:bigint};
export function accumulateWholeTl(previousCarryAtoms:bigint,earnedAtoms:bigint):CarrySettlement{
  if(previousCarryAtoms<0n||previousCarryAtoms>=TL_ATOMS_PER_UNIT)throw Error('INVALID_TL_CARRY');
  if(earnedAtoms<0n)throw Error('INVALID_TL_EARNING');
  const sum=previousCarryAtoms+earnedAtoms;
  return {wholeTl:sum/TL_ATOMS_PER_UNIT,carryAtoms:sum%TL_ATOMS_PER_UNIT};
}
/** Divide exact source atoms; the platform remainder remains platform-owned. */
export function splitCreatorPlatformAtoms(totalAtoms:bigint):{creatorAtoms:bigint;platformAtoms:bigint}{
  if(totalAtoms<0n)throw Error('INVALID_TL_EARNING');
  const creatorAtoms=totalAtoms*70n/100n;
  return {creatorAtoms,platformAtoms:totalAtoms-creatorAtoms};
}
