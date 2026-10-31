import {accumulateWholeTl} from './v5-tl-carry';

export type CarryBeneficiary='creator'|'platform'|'user'|'escrow';
export interface CarryAccrual {
  eventKey:string;carryKey:string;beneficiaryType:CarryBeneficiary;
  beneficiaryId:string;fundingSource:string;policyCode:string;earnedAtoms:number;
}
/**
 * Writes the carry event and new remainder in one D1 batch. Caller must
 * include the whole-TL payout as ledger entries in the SAME batch before
 * enabling this for live rewards. This function records accrual only.
 */
export async function recordFractionalTlAccrual(db:D1Database,input:CarryAccrual){
  if(!/^[A-Za-z0-9:_-]{1,200}$/.test(input.eventKey)||!/^[A-Za-z0-9:_-]{1,200}$/.test(input.carryKey))throw Error('INVALID_CARRY_KEY');
  if(!['creator','platform','user','escrow'].includes(input.beneficiaryType)||!input.beneficiaryId||!input.fundingSource||!input.policyCode)throw Error('INVALID_CARRY_OWNER');
  if(!Number.isSafeInteger(input.earnedAtoms)||input.earnedAtoms<0)throw Error('INVALID_CARRY_EARNING');
  const prior=await db.prepare('SELECT carry_key,earned_atoms FROM v5_tl_fractional_carry_events WHERE event_key=?').bind(input.eventKey).first<any>();
  if(prior){
    if(prior.carry_key!==input.carryKey||Number(prior.earned_atoms)!==input.earnedAtoms)throw Error('CARRY_EVENT_CONFLICT');
    return {replayed:true};
  }
  await db.prepare('INSERT OR IGNORE INTO v5_tl_fractional_carry(carry_key,beneficiary_type,beneficiary_id,funding_source,policy_code) VALUES (?,?,?,?,?)').bind(input.carryKey,input.beneficiaryType,input.beneficiaryId,input.fundingSource,input.policyCode).run();
  const row=await db.prepare('SELECT * FROM v5_tl_fractional_carry WHERE carry_key=?').bind(input.carryKey).first<any>();
  if(!row||row.beneficiary_type!==input.beneficiaryType||row.beneficiary_id!==input.beneficiaryId||row.funding_source!==input.fundingSource||row.policy_code!==input.policyCode)throw Error('CARRY_OWNER_CONFLICT');
  const before=Number(row.carry_atoms),version=Number(row.version);
  const result=accumulateWholeTl(BigInt(before),BigInt(input.earnedAtoms));
  const paid=Number(result.wholeTl),after=Number(result.carryAtoms);
  if(!Number.isSafeInteger(paid))throw Error('CARRY_PAYOUT_OVERFLOW');
  // Do not post positive payouts without corresponding balanced TL ledger entries.
  if(paid>0)throw Error('CARRY_PAYOUT_LEDGER_REQUIRED');
  const results=await db.batch([
    db.prepare('UPDATE v5_tl_fractional_carry SET carry_atoms=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE carry_key=? AND version=?').bind(after,input.carryKey,version),
    db.prepare('INSERT INTO v5_tl_fractional_carry_events(event_key,carry_key,earned_atoms,paid_whole_tl,carry_before_atoms,carry_after_atoms) VALUES (?,?,?,?,?,?)').bind(input.eventKey,input.carryKey,input.earnedAtoms,paid,before,after)
  ]);
  if(Number(results[0]?.meta?.changes)!==1)throw Error('CARRY_VERSION_CONFLICT');
  return {replayed:false,paidWholeTl:paid,carryAtoms:after};
}
