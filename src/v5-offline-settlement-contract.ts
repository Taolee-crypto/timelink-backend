export type OfflineV5Reserved = Readonly<{ entitlementId:string; fileTlReserved:number; personalTlReserved:number; expiresAt:number }>;
export type OfflineV5Receipt = Readonly<{ id:string; sequence:number; audibleSeconds:number }>;
const safe=(n:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
/** Pure V5 settlement validation; no ledger mutations or arbitrary credit. */
export function validateOfflineV5Settlement(reservation:OfflineV5Reserved,receipts:readonly OfflineV5Receipt[],nowSeconds:number){
 if(!reservation||typeof reservation.entitlementId!=='string'||!reservation.entitlementId||
    !safe(reservation.fileTlReserved)||!safe(reservation.personalTlReserved)||
    !safe(reservation.expiresAt)||!safe(nowSeconds) || nowSeconds>reservation.expiresAt)
    throw Error('OFFLINE_V5_RESERVATION_INVALID');
 if(!Array.isArray(receipts)||receipts.length>100000)throw Error('OFFLINE_V5_RECEIPTS_INVALID');
 let used=0,sequence=0;
 const seen=new Set<string>();
 for(const r of receipts){
  if(!r||typeof r.id!=='string'||!r.id||seen.has(r.id)||!safe(r.sequence)||r.sequence!==++sequence||
     !safe(r.audibleSeconds)||r.audibleSeconds===0)throw Error('OFFLINE_V5_RECEIPT_REPLAY_OR_SEQUENCE');
  seen.add(r.id);
  if(used>Number.MAX_SAFE_INTEGER-r.audibleSeconds)throw Error('OFFLINE_V5_OVERFLOW');
  used+=r.audibleSeconds;
 }
 const total=reservation.fileTlReserved+reservation.personalTlReserved;
 if(!Number.isSafeInteger(total)||used>total)throw Error('OFFLINE_V5_RESERVATION_EXCEEDED');
 const fromFile=Math.min(used,reservation.fileTlReserved);
 return Object.freeze({entitlementId:reservation.entitlementId,spentTl:used,fileSpentTl:fromFile,
  personalSpentTl:used-fromFile,fileUnusedTl:reservation.fileTlReserved-fromFile,
  personalUnusedTl:reservation.personalTlReserved-(used-fromFile),receiptCount:seen.size});
}
