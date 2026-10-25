import {assertTLAtomScale} from './economy-ledger';

/** Read-only PG receipt report. TL issuance and internal transfers are never KRW sales. */
export async function readAdminFinance(db:D1Database){
 await assertTLAtomScale(db);
 const columns=(await db.prepare('PRAGMA table_info(tl_payments)').all<{name:string}>()).results||[];
 for(const name of ['id','user_id','method','pg_id','amount_krw','tl_granted','bonus_tl','status','created_at']){
  if(!columns.some(c=>c.name===name))throw Error('PAYMENT_SCHEMA_INCOMPLETE:'+name);
 }
 const base=`WITH receipts AS (
 SELECT p.*,CASE WHEN json_valid(t.metadata_json) AND json_extract(t.metadata_json,'$.payment_mode') IN ('live','test') THEN json_extract(t.metadata_json,'$.payment_mode') ELSE 'unknown' END payment_mode
 FROM tl_payments p LEFT JOIN v3_economy_transactions t
 ON t.idempotency_key='v5-payment:'||p.method||':'||p.pg_id AND t.transaction_type='payment_credit' AND t.status='posted'
 WHERE p.method IN ('toss','portone','stripe') AND p.status='success' AND p.amount_krw>0
 ), sales AS (SELECT * FROM receipts WHERE payment_mode<>'test') `;
 const queries=[
 base+`SELECT COALESCE(SUM(amount_krw),0) total_krw,COUNT(*) pay_count,
 COALESCE(SUM(CASE WHEN date(created_at,'+9 hours')=date('now','+9 hours') THEN amount_krw ELSE 0 END),0) today_krw,
 COALESCE(SUM(CASE WHEN strftime('%Y-%m',created_at,'+9 hours')=strftime('%Y-%m','now','+9 hours') THEN amount_krw ELSE 0 END),0) month_krw,
 COALESCE(SUM(CASE WHEN date(created_at,'+9 hours')>=date('now','+9 hours','weekday 0','-6 days') THEN amount_krw ELSE 0 END),0) week_krw,
 COALESCE(SUM(tl_granted-COALESCE(bonus_tl,0)),0) total_tl_sold,COALESCE(SUM(bonus_tl),0) bonus_tl,
 COALESCE(SUM(CASE WHEN payment_mode='unknown' THEN amount_krw ELSE 0 END),0) unclassified_krw,
 COALESCE(SUM(CASE WHEN payment_mode='live' THEN amount_krw ELSE 0 END),0) confirmed_live_krw FROM sales`,
 base+`SELECT id,user_id,method,amount_krw,tl_granted,bonus_tl,status,created_at,payment_mode FROM sales ORDER BY created_at DESC,id DESC LIMIT 50`,
 base+`SELECT date(created_at,'+9 hours') day,SUM(amount_krw) krw FROM sales WHERE date(created_at,'+9 hours')>=date('now','+9 hours','-29 days') GROUP BY day ORDER BY day DESC`,
 base+`SELECT COALESCE(SUM(amount_krw),0) krw,COUNT(*) count FROM receipts WHERE payment_mode='test'`,
 `SELECT COUNT(*) count,COALESCE(SUM(amount_krw),0) krw FROM tl_payments WHERE method='virtual' AND status='success'`,
 `SELECT COUNT(*) count FROM tl_payments WHERE status IN ('refunded','cancelled','canceled','partial_refunded')`,
 `SELECT COALESCE(SUM(e.amount_atoms),0) atoms FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id JOIN v3_economy_transactions t ON t.id=e.transaction_id WHERE e.asset_code='TL' AND a.owner_type='platform' AND t.status='posted' AND t.transaction_type IN ('track_playback_settlement','central_broadcast_settlement','tilo_v5_broadcast_settlement','certificate_issue_fee','certificate_download_fee') AND (a.bucket LIKE 'playback_revenue_%' OR a.bucket IN ('broadcast_revenue','tilo_broadcast_revenue','certificate_issue_revenue','certificate_download_revenue')) AND NOT EXISTS(SELECT 1 FROM v3_economy_entries bad WHERE bad.transaction_id=t.id GROUP BY bad.asset_code HAVING SUM(bad.amount_atoms)<>0)`
 ];
 const results=await db.batch(queries.map(sql=>db.prepare(sql)));
 const revenue:any=results[0].results?.[0]||{};
 for(const key of Object.keys(revenue))revenue[key]=Number(revenue[key]);
 return{ok:true,ledger_version:'V5',as_of:new Date().toISOString(),timezone:'Asia/Seoul',read_only:true,
  revenue:{...revenue,refund_krw:null,net_cash_krw:null,platform_revenue_tl:Number((Number((results[6].results?.[0] as any)?.atoms||0)/10000).toFixed(4))},
  recent_payments:results[1].results||[],daily_revenue:results[2].results||[],
  excluded:{test:results[3].results?.[0],virtual:results[4].results?.[0]},
  refund_status_records:Number((results[5].results?.[0] as any)?.count||0),
  verification:{receipt_totals_verified:true,bank_settlement_verified:false,refund_totals_verified:false},
  note:'PG 성공 영수증 기준 충전 결제액이며, 회계상 매출·은행 입금액과 구분합니다. 테스트·가상 충전은 제외하며, 과거 결제 환경 미분류 금액은 별도 표시합니다. 환불 누계·PG 수수료·실제 입금액은 미연결이므로 순유입액과 순이익은 확정하지 않습니다.'};
}
