import {assertTLAtomScale,atomsToTl,tlToAtoms,ensureLedgerAccount,postLedgerTransaction} from './economy-ledger';
export const CERTIFICATE_ISSUE_FEE=5000;
export const CERTIFICATE_DOWNLOAD_FEE=1000;
export class ServiceFeeError extends Error {
 constructor(public code:string,public required:number,public balance:number){super(code);}
}
async function feeWallet(db:D1Database,userId:number){
 await assertTLAtomScale(db);
 const user=await db.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(userId).first();
 if(!user)throw new ServiceFeeError('USER_INACTIVE',0,0);
 return(await db.prepare(`SELECT a.id,a.bucket,b.available_atoms,b.version FROM v3_economy_accounts a
 JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL'
 AND a.status='active' AND a.bucket IN ('wallet_ad','wallet_bonus','wallet_paid')`).bind(String(userId))
 .all<{id:string;bucket:string;available_atoms:number;version:number}>()).results||[];
}
export async function certificateFeeQuote(db:D1Database,userId:number){
 const rows=await feeWallet(db,userId);
 const value=(bucket:string)=>rows.filter(r=>r.bucket===bucket).reduce((n,r)=>n+Number(r.available_atoms),0);
 const total=value('wallet_ad')+value('wallet_bonus')+value('wallet_paid');
 return{ok:true,ledger_version:'V5',fee_tl:CERTIFICATE_ISSUE_FEE,download_fee_tl:CERTIFICATE_DOWNLOAD_FEE,
 wallet:{tl_a:atomsToTl(value('wallet_ad')),tl_b:atomsToTl(value('wallet_bonus')),tl_p:atomsToTl(value('wallet_paid')),tl_total:atomsToTl(total)},
 balance_after_tl:atomsToTl(total-tlToAtoms(CERTIFICATE_ISSUE_FEE)),can_afford:total>=tlToAtoms(CERTIFICATE_ISSUE_FEE)};
}
/** Fee debit, service result and event are committed in one atomic ledger batch. */
export async function chargeCertificateFee(db:D1Database,input:{
 userId:number;feeTl:number;kind:'issue'|'download';reference:string;idempotencyKey:string;
 atomicStatements:D1PreparedStatement[];guards?:D1PreparedStatement[];
}){
 const rows=await feeWallet(db,input.userId),amount=tlToAtoms(input.feeTl);
 if(amount<=0)throw Error('INVALID_CERTIFICATE_FEE');
 const total=rows.reduce((n,r)=>n+Number(r.available_atoms),0);
 if(total<amount)throw new ServiceFeeError('TL_INSUFFICIENT',input.feeTl,atomsToTl(total));
 let remaining=amount;
 const lines:{accountId:string;assetCode:'TL';amountAtoms:number}[]=[],guards:D1PreparedStatement[]=[...(input.guards||[])];
 const used={tl_a:0,tl_b:0,tl_p:0};
 for(const [bucket,key]of [['wallet_ad','tl_a'],['wallet_bonus','tl_b'],['wallet_paid','tl_p']] as const){
  const row=rows.find(r=>r.bucket===bucket);if(!row||remaining<=0)continue;
  const take=Math.min(remaining,Number(row.available_atoms));if(take<=0)continue;
  remaining-=take;used[key]=atomsToTl(take);
  lines.push({accountId:row.id,assetCode:'TL',amountAtoms:-take});
  guards.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM v3_economy_balances b JOIN v3_economy_accounts a ON a.id=b.account_id
   WHERE b.account_id=? AND b.available_atoms>=? AND b.version=? AND a.status='active') THEN 1 ELSE json_extract('invalid','$') END`).bind(row.id,take,row.version));
 }
 const revenue=await ensureLedgerAccount(db,'platform','timelink','TL',input.kind==='issue'?'certificate_issue_revenue':'certificate_download_revenue');
 lines.push({accountId:revenue,assetCode:'TL',amountAtoms:amount});
 const result=await postLedgerTransaction(db,{idempotencyKey:input.idempotencyKey,transactionType:'certificate_'+input.kind+'_fee',
  source:'v5_certificate_service',referenceType:input.kind==='issue'?'asset_certificate':'certificate_download',referenceId:input.reference,
  actorUserId:String(input.userId),description:input.kind==='issue'?'창작권 증명서 발행 수수료':'창작권 증명서 다운로드 수수료',
  metadata:{fee_atoms:amount,fee_tl:input.feeTl,fee_breakdown:used},lines,issuanceStatements:guards,atomicStatements:input.atomicStatements});
 const quote=await certificateFeeQuote(db,input.userId);
 return{transaction_id:result.id,fee_paid:input.feeTl,fee_breakdown:used,
  balance:{tl_a:quote.wallet.tl_a,tl_b:quote.wallet.tl_b,tl_p:quote.wallet.tl_p,total:quote.wallet.tl_total}};
}
