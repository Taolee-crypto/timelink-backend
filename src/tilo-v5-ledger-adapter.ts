/**
 * Internal TILO V5 ledger adapter.
 * NOT an API endpoint. Caller must first enforce trusted broadcaster evidence,
 * rights, country-local midnight, approved policy, budget and settlement lock.
 * Never invoke from a public or browser-supplied request.
 */
import { assertTLAtomScale, ensureLedgerAccount, postLedgerTransaction } from './economy-ledger';
import { planTiloV5LedgerPosting } from './tilo-v5-ledger-posting-plan';

export type TiloApprovedSettlement = {
  /** Durable unique settlement ID assigned by the trusted approval workflow. */
  settlementId: string;
  country: 'KR'|'JP'|'US'|'CN'|'TH'|'VN';
  localDate: string;
  creatorId: number;
  previousMonthlyCreatorGrossAtoms: bigint;
  newCreatorGrossAtoms: bigint;
  newPlatformShareAtoms: bigint;
};

export async function postApprovedTiloSettlement(
  db: D1Database,
  settlement: TiloApprovedSettlement,
): Promise<{ transactionId: string; replayed: boolean }> {
  if (!/^[a-zA-Z0-9:_-]{12,160}$/.test(settlement.settlementId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(settlement.localDate) ||
      !['KR','JP','US','CN','TH','VN'].includes(settlement.country) ||
      !Number.isSafeInteger(settlement.creatorId) || settlement.creatorId <= 0)
    throw new RangeError('INVALID_TILO_SETTLEMENT_IDENTITY');
  await assertTLAtomScale(db);
  const plan=planTiloV5LedgerPosting(
    settlement.previousMonthlyCreatorGrossAtoms,
    settlement.newCreatorGrossAtoms,
    settlement.newPlatformShareAtoms,
  );
  if(plan.platformFundingAtoms<=0n) throw new RangeError('EMPTY_TILO_SETTLEMENT');
  const fundingAccount=await ensureLedgerAccount(db,'platform','timelink','TL','tilo_broadcast_funding');
  const fundingBalance=await db.prepare(
    'SELECT available_atoms FROM v3_economy_balances WHERE account_id=?'
  ).bind(fundingAccount).first<{available_atoms:number}>();
  if(!Number.isSafeInteger(Number(fundingBalance?.available_atoms)) ||
     BigInt(fundingBalance!.available_atoms)<plan.platformFundingAtoms)
    throw new Error('INSUFFICIENT_TILO_PLATFORM_FUNDING');
  const accountByRole={
    platform_funding: fundingAccount,
    creator_reward: await ensureLedgerAccount(db,'user',settlement.creatorId,'TL','tilo_creator_reward'),
    platform_revenue: await ensureLedgerAccount(db,'platform','timelink','TL','tilo_broadcast_revenue'),
    development_contribution: await ensureLedgerAccount(db,'platform','timelink','TL','tilo_development_contribution'),
  };
  const lines=plan.entries.filter(e=>e.amountAtoms!==0n).map(e=>({
    accountId:accountByRole[e.role],
    assetCode:'TL' as const,
    amountAtoms:Number(e.amountAtoms),
  }));
  const result=await postLedgerTransaction(db,{
    idempotencyKey:'tilo-v5:'+settlement.settlementId,
    transactionType:'tilo_v5_broadcast_settlement',
    source:'tilo_verified_airtime',
    referenceType:'tilo_settlement',
    referenceId:settlement.settlementId,
    description:'TILO 국가별 검증 방송 창작자 정산',
    metadata:{
      country:settlement.country,local_date:settlement.localDate,
      creator_id:settlement.creatorId,policy_version:plan.policyVersion,
      gross_creator_atoms:Number(plan.grossCreatorAtoms),
      net_creator_atoms:Number(plan.creatorNetAtoms),
      platform_revenue_atoms:Number(plan.platformRevenueAtoms),
      development_contribution_atoms:Number(plan.developmentContributionAtoms),
      platform_funding_atoms:Number(plan.platformFundingAtoms),
    },
    lines,
  });
  return {transactionId:result.id,replayed:result.replayed};
}
