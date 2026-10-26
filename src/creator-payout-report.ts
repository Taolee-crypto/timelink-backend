/** Read-only creator report. Storage retains its historical v3_* names; all amounts use V5 TL atoms. */
export const CREATOR_REPORT_CTE = `
WITH valid_settlements AS (
 SELECT t.id,t.transaction_type FROM v3_economy_transactions t
 WHERE t.status='posted' AND (
  (t.transaction_type='track_playback_settlement' AND t.source='tl3_actual_playback') OR
  (t.transaction_type='daily_free_overage' AND t.source='verified_subscription_playback') OR
  (t.transaction_type='self_play_income_release' AND t.source='self_play_policy_v1') OR
  (t.transaction_type='central_broadcast_settlement' AND t.source='verified_central_broadcast') OR
  (t.transaction_type='tilo_v5_broadcast_settlement' AND t.source='tilo_verified_airtime'))
 AND EXISTS(SELECT 1 FROM v3_economy_entries e WHERE e.transaction_id=t.id AND e.asset_code='TL')
 AND NOT EXISTS(SELECT 1 FROM v3_economy_entries e WHERE e.transaction_id=t.id GROUP BY e.asset_code HAVING SUM(e.amount_atoms)<>0)
), reporting_entries AS (
 SELECT e.transaction_id,e.account_id,e.asset_code,e.amount_atoms
 FROM v3_economy_entries e JOIN valid_settlements v ON v.id=e.transaction_id
 WHERE v.transaction_type<>'daily_free_overage'
 UNION ALL
 SELECT tx.id,json_extract(j.value,'$.account_id'),'TL',json_extract(j.value,'$.amount_atoms')
 FROM v3_economy_transactions tx JOIN valid_settlements v ON v.id=tx.id,
 json_each(CASE WHEN json_valid(tx.metadata_json) THEN tx.metadata_json ELSE '{}' END,'$.creator_credits') j
 WHERE v.transaction_type='daily_free_overage' AND json_extract(j.value,'$.amount_atoms')>0
), earnings AS (
 SELECT a.owner_id AS user_id,SUM(e.amount_atoms) AS earned_atoms,
 SUM(CASE WHEN a.bucket='wallet_paid' THEN e.amount_atoms ELSE 0 END) AS cash_source_atoms,
 SUM(CASE WHEN a.bucket IN ('wallet_ad','wallet_bonus') THEN e.amount_atoms ELSE 0 END) AS non_cash_atoms,
 SUM(CASE WHEN t.transaction_type IN ('track_playback_settlement','self_play_income_release','daily_free_overage') THEN e.amount_atoms ELSE 0 END) AS playback_atoms,
 SUM(CASE WHEN t.transaction_type NOT IN ('track_playback_settlement','self_play_income_release','daily_free_overage') THEN e.amount_atoms ELSE 0 END) AS broadcast_atoms
 FROM reporting_entries e JOIN v3_economy_accounts a ON a.id=e.account_id AND a.asset_code=e.asset_code
 JOIN valid_settlements t ON t.id=e.transaction_id
 WHERE a.owner_type='user' AND e.asset_code='TL'
 AND ((t.transaction_type IN ('track_playback_settlement','self_play_income_release','daily_free_overage') AND a.bucket IN ('wallet_paid','wallet_ad','wallet_bonus'))
  OR(t.transaction_type='central_broadcast_settlement' AND a.bucket='broadcast_earnings')
  OR(t.transaction_type='tilo_v5_broadcast_settlement' AND a.bucket='tilo_creator_reward'))
 GROUP BY a.owner_id
), tracks AS (
 SELECT CAST(user_id AS TEXT) AS user_id,COUNT(*) AS track_count FROM tl3_v5_releases WHERE status='sealed' GROUP BY user_id
), wallets AS (
 SELECT a.owner_id AS user_id,SUM(b.available_atoms) AS wallet_atoms
 FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id
 WHERE a.owner_type='user' AND a.asset_code='TL' AND a.status='active'
 AND a.bucket IN ('wallet_paid','wallet_ad','wallet_bonus') GROUP BY a.owner_id
), self_held AS (
 SELECT a.owner_id AS user_id,SUM(b.available_atoms+b.held_atoms) AS self_held_atoms
 FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id
 WHERE a.owner_type='escrow' AND a.asset_code='TL' AND a.bucket LIKE 'self_play_creator_share_%' GROUP BY a.owner_id
)
SELECT u.id,u.username,u.email,u.role,COALESCE(t.track_count,0) AS track_count,
 COALESCE(e.earned_atoms,0) AS earned_atoms,COALESCE(e.cash_source_atoms,0) AS cash_source_atoms,COALESCE(e.non_cash_atoms,0) AS non_cash_atoms,COALESCE(e.playback_atoms,0) AS playback_atoms,
 COALESCE(e.broadcast_atoms,0) AS broadcast_atoms,COALESCE(w.wallet_atoms,0) AS wallet_atoms,
 COALESCE(h.self_held_atoms,0) AS self_held_atoms
 FROM users u LEFT JOIN tracks t ON t.user_id=CAST(u.id AS TEXT)
 LEFT JOIN earnings e ON e.user_id=CAST(u.id AS TEXT)
 LEFT JOIN wallets w ON w.user_id=CAST(u.id AS TEXT)
 LEFT JOIN self_held h ON h.user_id=CAST(u.id AS TEXT)
 WHERE (t.user_id IS NOT NULL OR e.user_id IS NOT NULL OR h.user_id IS NOT NULL)
 ORDER BY earned_atoms DESC,u.id
`;

export const CREATOR_TRACK_SQL=CREATOR_REPORT_CTE.slice(0,CREATOR_REPORT_CTE.indexOf('), earnings AS'))+`),
 credits AS (
 SELECT CAST(a.owner_id AS INTEGER) AS user_id,
  CAST(CASE WHEN json_valid(tx.metadata_json) THEN json_extract(tx.metadata_json,'$.file_id') END AS INTEGER) AS file_id,
  SUM(e.amount_atoms) AS earned_atoms,MAX(tx.created_at) AS last_earned_at
 FROM reporting_entries e JOIN v3_economy_accounts a ON a.id=e.account_id AND a.asset_code=e.asset_code
 JOIN valid_settlements v ON v.id=e.transaction_id JOIN v3_economy_transactions tx ON tx.id=v.id
 WHERE a.owner_type='user' AND e.asset_code='TL' AND
 ((v.transaction_type IN ('track_playback_settlement','self_play_income_release','daily_free_overage') AND a.bucket IN ('wallet_paid','wallet_ad','wallet_bonus')) OR
  (v.transaction_type='central_broadcast_settlement' AND a.bucket='broadcast_earnings') OR
  (v.transaction_type='tilo_v5_broadcast_settlement' AND a.bucket='tilo_creator_reward'))
 GROUP BY a.owner_id,file_id
 ), identities AS(
 SELECT user_id,file_id FROM tl3_v5_releases WHERE status='sealed'
 UNION SELECT user_id,file_id FROM credits
 )
 SELECT i.user_id,i.file_id,COALESCE(f.title,'방송 통합 정산') AS title,COALESCE(f.artist,'') AS artist,
 COALESCE(f.cover_image,'') AS cover_url,COALESCE(c.earned_atoms,0) AS earned_atoms,c.last_earned_at
 FROM identities i LEFT JOIN credits c ON c.user_id=i.user_id AND (c.file_id=i.file_id OR(c.file_id IS NULL AND i.file_id IS NULL))
 LEFT JOIN tl_files f ON f.id=i.file_id
`;

function tl(atoms:unknown):number{
 const n=Number(atoms||0);if(!Number.isSafeInteger(n))throw Error('CREATOR_REPORT_INVALID_ATOMS');
 return Number((n/10000).toFixed(4));
}
export async function readCreatorPayoutReport(db:D1Database,userId?:number){
 const precision=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<{decimals:number}>();
 if(Number(precision?.decimals)!==4)throw Error('CREATOR_REPORT_TL_PRECISION_NOT_READY');
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='creator_payouts'").first();
 const cq=db.prepare(CREATOR_REPORT_CTE.replace(' ORDER BY earned_atoms DESC,u.id',userId?' AND u.id=? ORDER BY earned_atoms DESC,u.id':' ORDER BY earned_atoms DESC,u.id'));
 const tq=db.prepare(CREATOR_TRACK_SQL+(userId?' WHERE i.user_id=?':'')+' ORDER BY earned_atoms DESC,i.file_id DESC');
 const pq=exists?db.prepare('SELECT p.id,p.user_id,u.username,p.amount_tl,p.amount_krw,p.status,p.note,p.created_at,p.processed_at FROM creator_payouts p LEFT JOIN users u ON u.id=p.user_id '+(userId?'WHERE p.user_id=? ':'')+'ORDER BY p.created_at DESC,p.id DESC'):db.prepare('SELECT NULL AS id WHERE 0');
 const companySql=CREATOR_REPORT_CTE.slice(0,CREATOR_REPORT_CTE.indexOf('), earnings AS'))+`)
   SELECT COALESCE(SUM(e.amount_atoms),0) AS atoms FROM v3_economy_entries e
   JOIN v3_economy_accounts a ON a.id=e.account_id AND a.asset_code=e.asset_code
   JOIN valid_settlements t ON t.id=e.transaction_id
   WHERE a.owner_type='platform' AND e.asset_code='TL'
    AND((t.transaction_type IN ('track_playback_settlement','daily_free_overage') AND a.bucket LIKE 'playback_revenue_%') OR
     (t.transaction_type='central_broadcast_settlement' AND a.bucket='broadcast_revenue') OR
     (t.transaction_type='tilo_v5_broadcast_settlement' AND a.bucket='tilo_broadcast_revenue'))`;
 const results=await db.batch([
  userId?cq.bind(userId):cq,
  db.prepare(`SELECT t.transaction_type,COUNT(*) AS count FROM v3_economy_transactions t WHERE
   EXISTS(SELECT 1 FROM v3_economy_entries e WHERE e.transaction_id=t.id GROUP BY e.asset_code HAVING SUM(e.amount_atoms)<>0)
   GROUP BY t.transaction_type`),
  exists&&userId?pq.bind(userId):pq,userId?tq.bind(userId):tq,
  db.prepare(userId?'SELECT 0 AS atoms':companySql)
 ]);
 const rows=(results[0].results||[]) as any[],imbalanced=(results[1].results||[]) as any[],requests=(results[2].results||[]) as any[];
 const trackDetails=(results[3].results||[]).map((r:any)=>({user_id:Number(r.user_id),file_id:r.file_id==null?null:Number(r.file_id),
  title:String(r.title),artist:String(r.artist),cover_url:String(r.cover_url),earned_tl:tl(r.earned_atoms),last_earned_at:r.last_earned_at||null}));
 const warnings:string[]=[];
 if(!userId&&imbalanced.length)warnings.push('복식 원장 합계가 불일치하는 거래 '+imbalanced.reduce((n,r)=>n+Number(r.count),0)+'건은 창작 수익 집계에서 제외했습니다.');
 if(!exists)warnings.push('기존 지급 요청 저장소가 없어 요청 내역을 확인할 수 없습니다.');
 const paidByUser=new Map<number,number>();
 for(const r of requests)if(r.status==='completed')paidByUser.set(Number(r.user_id),(paidByUser.get(Number(r.user_id))||0)+Number(r.amount_tl||0));
 if(paidByUser.size)warnings.push('기존 지급 완료 기록은 V5 원장 거래 연결이 없어 지급 검증이 필요합니다.');
 const creators=rows.map(r=>({
  id:Number(r.id),username:String(r.username||''),email:String(r.email||''),track_count:Number(r.track_count),
  total_earned:tl(r.earned_atoms),cash_funded_playback_tl:tl(r.cash_source_atoms),non_cash_playback_tl:tl(r.non_cash_atoms),personal_display_tl:tl(Number(r.earned_atoms)+(!userId&&String(r.role||'').toLowerCase()==='admin'?Number(r.self_held_atoms):0)),playback_earned_tl:tl(r.playback_atoms),broadcast_earned_tl:tl(r.broadcast_atoms),
  self_play_held_tl:tl(r.self_held_atoms),tl_balance:tl(r.wallet_atoms),
  total_exchanged:paidByUser.has(Number(r.id))?null:0,reported_paid_tl:paidByUser.get(Number(r.id))||0,
  payout_verified:!paidByUser.has(Number(r.id)),cash_redeemable_tl:null,tracks:trackDetails.filter(t=>t.user_id===Number(r.id))
 }));
 const earned=rows.reduce((n,r)=>n+Number(r.earned_atoms),0),held=rows.reduce((n,r)=>n+Number(r.self_held_atoms),0);
 return {ok:true,ledger_version:'V5',read_only:true,as_of:new Date().toISOString(),creators,
  requests:requests.map(r=>({...r,verification_status:'legacy_record_not_ledger_verified'})),
  platform:userId?undefined:{music_revenue_tl:tl((results[4].results?.[0] as any)?.atoms)},tracks:trackDetails,
  summary:{creator_count:creators.length,earned_tl:tl(earned),cash_funded_playback_tl:tl(rows.reduce((n,r)=>n+Number(r.cash_source_atoms),0)),non_cash_playback_tl:tl(rows.reduce((n,r)=>n+Number(r.non_cash_atoms),0)),playback_earned_tl:tl(rows.reduce((n,r)=>n+Number(r.playback_atoms),0)),broadcast_earned_tl:tl(rows.reduce((n,r)=>n+Number(r.broadcast_atoms),0)),personal_display_tl:creators.reduce((n,r)=>Number((n+r.personal_display_tl).toFixed(4)),0),self_play_held_tl:tl(held),
   pending_request_count:requests.filter(r=>r.status==='pending').length,request_count:requests.length,
   unpaid_tl:null,cash_redeemable_tl:null},warnings,basis:'posted_balanced_v5_creator_credit_entries',
  note:'창작 수익은 실제 수취인의 V5 원장 입금액입니다. 충전·가입 보너스 자체는 수익이 아니며 실제 TL 사용으로 정산된 창작자 몫을 수익으로 집계합니다. 유료 재원 창작 정산과 비환금성 보상을 구분하며, 현금 지급 가능액은 별도 정산 확인 후 확정합니다.'};
}
