/**
 * TLC daily mining is gross, not a user entitlement.
 * One atomic V3 ledger transaction splits its issuance into:
 * - 50% to the verified member's TLC wallet
 * - 50% to TILO Group's locked long-term reserve.
 *
 * Never create additional TLC; group share comes out of the preexisting gross.
 * No backwards rebalance for previously posted mining receipts.
 */
export const TLC_ATOMS_PER_UNIT=1000000000;
export const TLC_RESERVE_OWNER='tilo-group';
export const TLC_RESERVE_BUCKET='permanent_value_reserve_locked';
export const TLC_SPLIT_POLICY='tilo-group-5050-v1';

export function splitMinedTlcAtoms(gross:number){
 if(!Number.isSafeInteger(gross)||gross<2)throw Error('INVALID_GROSS_TLC_ATOMS');
 const memberAtoms=Math.floor(gross/2);
 const groupAtoms=gross-memberAtoms; // deterministic indivisible atom to reserve
 return {grossAtoms:gross,memberAtoms,groupAtoms,
  memberTlc:memberAtoms/TLC_ATOMS_PER_UNIT,
  groupTlc:groupAtoms/TLC_ATOMS_PER_UNIT,
  grossTlc:gross/TLC_ATOMS_PER_UNIT,
  policy:TLC_SPLIT_POLICY};
}
export function assertTlcAssetScaleRead(decimals:unknown){
 if(Number(decimals)!==9)throw Error('V3_TLC_ATOM_SCALE_NOT_READY');
}
export async function assertTlcAssetScale(db:D1Database){
 const row=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TLC'").first<any>();
 assertTlcAssetScaleRead(row?.decimals);
}
export async function readGroupTlcReserve(db:D1Database){
 await assertTlcAssetScale(db);
 const row=await db.prepare(`SELECT b.available_atoms,b.held_atoms
   FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id
   WHERE a.owner_type='platform' AND a.owner_id=? AND a.asset_code='TLC' AND a.bucket=? AND a.status='active'`)
  .bind(TLC_RESERVE_OWNER,TLC_RESERVE_BUCKET).first<any>();
 return {group:'TILO Group',locked_tlc:Number(row?.held_atoms||0)/TLC_ATOMS_PER_UNIT,
   available_tlc:Number(row?.available_atoms||0)/TLC_ATOMS_PER_UNIT,
   custodian:'platform_internal_dev_ledger',transfer_allowed:false,
   gold_conversion_enabled:false,external_chain_minted:false};
}
