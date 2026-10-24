import { assertTLAtomScale, atomsToTl, getLedgerWallet } from './economy-ledger';

/** All wallet-facing APIs use these same ledger buckets. Never infer cashout
 * eligibility from a display balance or import a legacy balance on a read. */
export async function readV5Wallet(db:D1Database,userId:number) {
  await assertTLAtomScale(db);
  const rows=await getLedgerWallet(db,userId) as any[];
  const sum=(asset:string,bucket:string,field='available_atoms')=>rows
    .filter(r=>r.asset_code===asset&&r.bucket===bucket)
    .reduce((n,r)=>n+Number(r[field]||0),0);
  const tl_p=atomsToTl(sum('TL','wallet_paid'));
  const tl_a=atomsToTl(sum('TL','wallet_ad'));
  const tl_b=atomsToTl(sum('TL','wallet_bonus'));
  const held=rows.filter(r=>r.asset_code==='TL').reduce((n,r)=>n+Number(r.held_atoms||0),0);
  return {tl_p,tl_a,tl_b,tl_balance:tl_p+tl_a+tl_b,tl_total:tl_p+tl_a+tl_b,
    tl_locked:atomsToTl(held),ledger_version:'V5',
    // TLC mining is still legacy; expose its provenance rather than relabel it.
    tlc_ledger_balance:rows.filter(r=>r.asset_code==='TLC').reduce((n,r)=>n+Number(r.available_atoms||0),0)/1e9};
}
