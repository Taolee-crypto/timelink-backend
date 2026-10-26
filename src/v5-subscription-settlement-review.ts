import {ensureMusicOrderSchema} from './v5-music-subscription-orders';
import {ensureSubscriptionPlaybackSchema} from './v5-subscription-playback';
/** Review only. KRW budgets are never treated as TL, and this module cannot pay. */
export function allocateMusicBudget(budgetKrw:number,weights:readonly {id:string;includedMs:number}[]){
 if(!Number.isSafeInteger(budgetKrw)||budgetKrw<0||weights.some(w=>!w.id||!Number.isSafeInteger(w.includedMs)||w.includedMs<=0)||new Set(weights.map(w=>w.id)).size!==weights.length)throw Error('INVALID_MUSIC_BUDGET_WEIGHTS');
 const total=weights.reduce((n,w)=>n+BigInt(w.includedMs),0n);if(total===0n)return [];
 const result=weights.map(w=>{const scaled=BigInt(budgetKrw)*BigInt(w.includedMs);return {...w,budgetKrw:Number(scaled/total),remainder:scaled%total};});
 const order=[...result].sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.id<b.id?-1:1);
 let left=budgetKrw-result.reduce((n,w)=>n+w.budgetKrw,0);for(let i=0;i<left;i++)order[i].budgetKrw++;
 return result.map(({remainder,...w})=>w);
}
export async function listMusicSettlementReceipts(db:D1Database,limit=25,offset=0){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw Error('INVALID_MUSIC_REVIEW_PAGE');
 await ensureMusicOrderSchema(db);
 const rows=await db.prepare(`SELECT r.order_id,r.user_id,r.amount_krw,r.rights_budget_krw,r.platform_budget_krw,r.approved_at_ms,r.entitlement_id,e.starts_at_ms,e.ends_at_ms,e.status AS entitlement_status
 FROM v5_music_receipts r JOIN v5_music_entitlements e ON e.id=r.entitlement_id
 WHERE r.payment_mode='live' AND e.payment_mode='live' ORDER BY r.approved_at_ms DESC,r.order_id LIMIT ? OFFSET ?`).bind(limit,offset).all();
 return {ok:true,readOnly:true,payoutEnabled:false,proposedBasis:'per_receipt_included_listening_ms',limit,offset,receipts:rows.results||[]};
}
function recipients(snapshot:string):{id:string;shareBps:number;userId:number}[]|null{
 try{
  const s=JSON.parse(snapshot);if(s.ready!==true||!Number.isSafeInteger(s.version)||s.version<1||!Array.isArray(s.members)||!s.members.length)return null;
  const rows=s.members.map((m:any)=>({id:m.id,shareBps:m.share_bps,userId:m.recipient_user_id,accepted:m.consent==='accepted'&&m.active_recipient===1}));
  if(rows.some((m:any)=>typeof m.id!=='string'||!m.id||!m.accepted||!Number.isSafeInteger(m.shareBps)||m.shareBps<0||m.shareBps>10000||!Number.isSafeInteger(m.userId)||m.userId<1)||new Set(rows.map((r:any)=>r.id)).size!==rows.length||rows.reduce((n:number,r:any)=>n+r.shareBps,0)!==10000)return null;
  return rows;
 }catch{return null;}
}
export async function reviewMusicSettlement(db:D1Database,orderId:string,nowMs=Date.now()){
 if(!/^v5music_[a-f0-9]{32}$/.test(orderId)||!Number.isSafeInteger(nowMs)||nowMs<0)throw Error('INVALID_MUSIC_REVIEW_ORDER');
 await ensureMusicOrderSchema(db);await ensureSubscriptionPlaybackSchema(db);
 const r=await db.prepare(`SELECT r.order_id,r.user_id,r.amount_krw,r.rights_budget_krw,r.platform_budget_krw,r.entitlement_id,e.starts_at_ms,e.ends_at_ms,e.status AS entitlement_status
 FROM v5_music_receipts r JOIN v5_music_entitlements e ON e.id=r.entitlement_id WHERE r.order_id=? AND r.payment_mode='live' AND e.payment_mode='live'`).bind(orderId).first<any>();
 if(!r)return null;
 const rows=(await db.prepare(`SELECT u.file_id,w.creator_id,w.split_version,w.split_snapshot,w.settlement_status,SUM(u.included_ms) AS included_ms,MIN(u.starts_at_ms) AS first_ms,MAX(u.ends_at_ms) AS last_ms
 FROM v5_music_usage_events u LEFT JOIN v5_music_usage_rights w ON w.usage_key=u.usage_key
 WHERE u.entitlement_id=? AND u.user_id=? AND u.included_ms>0
 GROUP BY u.file_id,w.creator_id,w.split_version,w.split_snapshot,w.settlement_status ORDER BY u.file_id,w.split_version,w.split_snapshot`).bind(r.entitlement_id,r.user_id).all<any>()).results||[];
 const weights=rows.map((u:any,i:number)=>({id:String(i),includedMs:Number(u.included_ms)}));
 const allocations=allocateMusicBudget(Number(r.rights_budget_krw),weights);
 const blocks=new Set(['PAYMENT_AND_REFUND_RECONCILIATION_REQUIRED','REFUND_ALLOCATION_POLICY_REQUIRED','KRW_TO_TL_SETTLEMENT_POLICY_REQUIRED','ADMIN_APPROVAL_REQUIRED']);
 if(nowMs<r.ends_at_ms)blocks.add('BILLING_PERIOD_NOT_FINISHED');
 if(r.entitlement_status!=='active')blocks.add('CANCELLED_ENTITLEMENT_REVIEW_REQUIRED');
 if(!rows.length)blocks.add('NO_INCLUDED_LISTENING_BUDGET_HELD');
 let proposedRecipientKrw=0,heldKrw=rows.length?0:Number(r.rights_budget_krw);
 const tracks=rows.map((u:any,i:number)=>{
  const budget=allocations[i].budgetKrw;
  const validPeriod=u.first_ms>=r.starts_at_ms&&u.last_ms<=r.ends_at_ms;
  const members=u.split_snapshot?recipients(u.split_snapshot):null;
  const validSnapshot=members&&JSON.parse(u.split_snapshot).version===u.split_version;
  const ready=!!validPeriod&&!!validSnapshot&&u.settlement_status==='unsettled';
  if(!ready){heldKrw+=budget;blocks.add(!validPeriod?'USAGE_OUTSIDE_BILLING_PERIOD':u.settlement_status&&u.settlement_status!=='unsettled'?'PREVIOUS_SETTLEMENT_REQUIRES_RECONCILIATION':'RIGHTS_VERIFICATION_REQUIRED');}
  const parts=ready?allocateMusicBudget(budget,members!.filter(m=>m.shareBps>0).map(m=>({id:m.id,includedMs:m.shareBps}))).map(p=>({userId:members!.find(m=>m.id===p.id)!.userId,budgetKrw:p.budgetKrw})):[];
  if(ready)proposedRecipientKrw+=budget;
  return {fileId:u.file_id,splitVersion:u.split_version,includedMs:Number(u.included_ms),budgetKrw:budget,rightsReady:ready,proposedRecipients:parts,heldKrw:ready?0:budget};
 });
 if(!Number.isSafeInteger(r.amount_krw)||r.rights_budget_krw+r.platform_budget_krw!==r.amount_krw||proposedRecipientKrw+heldKrw!==r.rights_budget_krw)throw Error('MUSIC_REVIEW_BUDGET_INVARIANT');
 return {ok:true,readOnly:true,payoutEnabled:false,policyStatus:'proposal_not_approved',basis:'per_receipt_included_listening_ms',currency:'KRW',receipt:r,tracks,
  summary:{includedMs:weights.reduce((n,w)=>n+w.includedMs,0),rightsBudgetKrw:r.rights_budget_krw,platformBudgetKrw:r.platform_budget_krw,proposedRecipientKrw,heldKrw},blockingReasons:[...blocks],
  note:'포함 청취시간 비례 배분의 검토안입니다. 금액은 원화 예산이며 TL 잔액이나 현금 지급 가능액이 아닙니다. 초과 TL 과금은 이미 별도 정산되어 이 배분에서 제외합니다.'};
}
