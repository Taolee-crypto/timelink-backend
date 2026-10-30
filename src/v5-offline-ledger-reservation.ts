import {assertTLAtomScale,ensureLedgerAccount,getTrackPoolBalances,postLedgerTransaction,TL_ATOMS_PER_TL} from './economy-ledger';

/**
 * Reserve *already-funded* TL into a separate escrow account. This is a real
 * balanced ledger transfer, not a local balance or automatic TL recharge.
 * Never release a content key until the reservation posting has committed.
 */
export async function reserveOfflineV5TrackTl(db:D1Database,input:{
  userId:number;shareId:string;entitlementId:string;seconds:number;
}){
  const {userId,shareId,entitlementId,seconds}=input;
  if(!Number.isSafeInteger(userId)||userId<=0||
     !/^[A-Za-z0-9_-]{1,128}$/.test(shareId)||
     !/^[A-Za-z0-9_-]{12,128}$/.test(entitlementId)||
     !Number.isSafeInteger(seconds)||seconds<=0||seconds>86400)
    throw Error('OFFLINE_V5_RESERVATION_INPUT_INVALID');
  await assertTLAtomScale(db);
  const amountAtoms=seconds*TL_ATOMS_PER_TL;
  if(!Number.isSafeInteger(amountAtoms))throw Error('OFFLINE_V5_RESERVATION_OVERFLOW');
  // A retry must not re-read already-reserved spendable balances and fail.
  // Verify the original ledger fingerprint inputs before returning it.
  const previous=await db.prepare(
    'SELECT id,transaction_type,source,reference_type,reference_id,actor_user_id,metadata_json FROM v3_economy_transactions WHERE idempotency_key=?'
  ).bind('offline-v5-reserve:'+entitlementId).first<any>();
  if(previous){
    let metadata:any;
    try{metadata=JSON.parse(String(previous.metadata_json||'{}'));}catch{throw Error('OFFLINE_V5_RESERVATION_REPLAY_CONFLICT');}
    const allocation=metadata.source_atoms;
    const total=allocation&&['paid','bonus','ad'].every(k=>Number.isSafeInteger(allocation[k])&&allocation[k]>=0)
      ?allocation.paid+allocation.bonus+allocation.ad:-1;
    if(previous.transaction_type!=='offline_v5_reserve'||
       previous.source!=='tl3_offline_reservation'||
       previous.reference_type!=='offline_entitlement'||
       String(previous.reference_id)!==entitlementId||
       String(previous.actor_user_id)!==String(userId)||
       metadata.share_id!==shareId||
       metadata.reserved_seconds!==seconds||
       metadata.amount_atoms!==amountAtoms||total!==amountAtoms)
      throw Error('OFFLINE_V5_RESERVATION_REPLAY_CONFLICT');
    const escrowId=await ensureLedgerAccount(db,'escrow',entitlementId,'TL','offline_v5_reserved');
    return {entitlementId,seconds,amountAtoms,sourceAtoms:allocation,escrowAccountId:escrowId,ledgerTransactionId:String(previous.id),replayed:true};
  }
  const balances=await getTrackPoolBalances(db,userId,shareId);
  const sources=['paid','bonus','ad'] as const;
  let remaining=amountAtoms;
  const used:{paid:number;bonus:number;ad:number}={paid:0,bonus:0,ad:0};
  for(const source of sources){
    const available=Number(balances[source]||0);
    if(!Number.isSafeInteger(available)||available<0)throw Error('OFFLINE_V5_BAD_POOL_BALANCE');
    used[source]=Math.min(remaining,available);
    remaining-=used[source];
  }
  if(remaining!==0)throw Error('OFFLINE_V5_INSUFFICIENT_TRACK_TL');
  const escrow=await ensureLedgerAccount(db,'escrow',entitlementId,'TL','offline_v5_reserved');
  const lines:{accountId:string;assetCode:'TL';amountAtoms:number}[]=[];
  for(const source of sources){
    if(!used[source])continue;
    const sourceAccount=await ensureLedgerAccount(db,'user',userId,'TL','track_pool:'+shareId+':'+source);
    lines.push({accountId:sourceAccount,assetCode:'TL',amountAtoms:-used[source]});
  }
  lines.push({accountId:escrow,assetCode:'TL',amountAtoms});
  const posted=await postLedgerTransaction(db,{
    idempotencyKey:'offline-v5-reserve:'+entitlementId,
    transactionType:'offline_v5_reserve',source:'tl3_offline_reservation',
    referenceType:'offline_entitlement',referenceId:entitlementId,
    actorUserId:String(userId),description:'V5 오프라인 청취 예약 — 곡별 기보유 TL만 에스크로 이동',
    metadata:{share_id:shareId,reserved_seconds:seconds,amount_atoms:amountAtoms,source_atoms:used},
    lines
  });
  return {entitlementId,seconds,amountAtoms,sourceAtoms:used,escrowAccountId:escrow,ledgerTransactionId:posted.id,replayed:posted.replayed};
}
