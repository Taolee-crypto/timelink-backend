import {assertTLAtomScale,ensureLedgerAccount,postLedgerTransaction} from './economy-ledger';
type SelfPlayRelease={account_id:string;owner_id:string;bucket:string;file_id:number;amount_atoms:number;watermark:number};
/** Reclassifies already funded creator shares. No issuance, deletion or alteration of old ledger facts. */
export async function releaseHistoricalSelfPlayIncome(db:D1Database,apply=false){
 await assertTLAtomScale(db);
 const rows=(await db.prepare(`SELECT a.id AS account_id,a.owner_id,a.bucket,
  CAST(json_extract(t.metadata_json,'$.file_id') AS INTEGER) AS file_id,
  SUM(e.amount_atoms) AS amount_atoms,MAX(e.id) AS watermark
  FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id
  JOIN v3_economy_transactions t ON t.id=e.transaction_id
  WHERE a.owner_type='escrow' AND a.asset_code='TL' AND a.status='active'
   AND a.bucket IN ('self_play_creator_share_paid','self_play_creator_share_ad','self_play_creator_share_bonus')
   AND e.asset_code='TL' AND t.status='posted'
   AND ((t.transaction_type='track_playback_settlement' AND t.source='tl3_actual_playback')
     OR(t.transaction_type='self_play_income_release' AND t.source='self_play_policy_v1'))
   AND NOT EXISTS(SELECT 1 FROM v3_economy_entries x WHERE x.transaction_id=t.id GROUP BY x.asset_code HAVING SUM(x.amount_atoms)<>0)
  GROUP BY a.id,a.owner_id,a.bucket,file_id HAVING SUM(e.amount_atoms)>0
  ORDER BY a.id,file_id`).all<SelfPlayRelease>()).results||[];
 const totals=new Map<string,number>();
 for(const row of rows){
  const owner=Number(row.owner_id);
  if(!Number.isSafeInteger(owner)||owner<=0||String(owner)!==row.owner_id||
    !Number.isSafeInteger(row.file_id)||row.file_id<=0||!Number.isSafeInteger(row.amount_atoms)||row.amount_atoms<=0)
    throw Error('SELF_PLAY_RELEASE_SOURCE_INVALID');
  const split=await db.prepare('SELECT 1 AS found FROM v5_creator_split_heads WHERE file_id=?').bind(row.file_id).first()
   .catch((error:unknown)=>{if(/no such table.*v5_creator_split_heads/i.test(String(error)))return null;throw error;});
  if(split)throw Error('SELF_PLAY_RELEASE_TRACK_SPLIT_REVIEW_REQUIRED');
  totals.set(row.account_id,(totals.get(row.account_id)||0)+row.amount_atoms);
 }
 for(const [account,total]of totals){
  const balance=await db.prepare('SELECT available_atoms,held_atoms FROM v3_economy_balances WHERE account_id=?').bind(account).first<{available_atoms:number;held_atoms:number}>();
  if(!balance||Number(balance.available_atoms)!==total||Number(balance.held_atoms)!==0)throw Error('SELF_PLAY_RELEASE_BALANCE_MISMATCH');
 }
 const totalAtoms=rows.reduce((n,r)=>n+r.amount_atoms,0);
 if(!apply)return {applied:false,posted:0,total_atoms:totalAtoms,plans:rows};
 let posted=0;
 for(const row of rows){
  const bucket=row.bucket.endsWith('_paid')?'wallet_paid':'wallet_ad';
  const target=await ensureLedgerAccount(db,'user',row.owner_id,'TL',bucket);
  const idempotencyKey='self-play-income-v1:'+row.account_id+':'+row.file_id+':'+row.watermark;
  const result=await postLedgerTransaction(db,{
   idempotencyKey,transactionType:'self_play_income_release',source:'self_play_policy_v1',
   referenceType:'track',referenceId:String(row.file_id),actorUserId:row.owner_id,
   description:'본인 TL 사용에 따른 창작자 몫 보관분을 개인 창작 수익으로 전환',
   metadata:{file_id:row.file_id,creator_id:Number(row.owner_id),original_escrow_account:row.account_id,
    amount_atoms:row.amount_atoms,policy:'self_play_is_creator_income_v1',source_entry_watermark:row.watermark},
   lines:[{accountId:row.account_id,assetCode:'TL',amountAtoms:-row.amount_atoms},
    {accountId:target,assetCode:'TL',amountAtoms:row.amount_atoms}],
   issuanceStatements:[db.prepare(`SELECT CASE WHEN (SELECT available_atoms FROM v3_economy_balances WHERE account_id=?)>=?
    THEN 1 ELSE json_extract('invalid','$') END`).bind(row.account_id,row.amount_atoms)]
  });
  if(!result.replayed)posted++;
 }
 return {applied:true,posted,total_atoms:totalAtoms,plans:rows};
}
