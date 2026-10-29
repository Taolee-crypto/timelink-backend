/**
 * Purchased TL_P lifecycle — separate from creator cash-source royalties.
 *
 * TL_P bought with money is eligible for TL_B conversion only after the
 * legally validated refund eligibility ends. The ordinary 7-day withdrawal
 * period is NOT necessarily the end of all prepaid-balance refund rights.
 * Never infer a conversion deadline from the payment date alone.
 *
 * This module persists purchase provenance; it does not convert balances.
 * Full attribution of spent vs unused amounts and verified jurisdiction/
 * consumer rights are required before any automated conversion is enabled.
 */
export type PurchasedTlConversionDecision =
  | 'TEST_OR_UNVERIFIED_PAYMENT'
  | 'LEGAL_RIGHTS_REVIEW_REQUIRED'
  | 'PURCHASE_ATTRIBUTION_REQUIRED'
  | 'REFUND_DISPUTE_PENDING'
  | 'REFUND_PERIOD_OPEN'
  | 'NO_REMAINING_PURCHASED_TL'
  | 'ELIGIBLE_FOR_CONTROLLED_CONVERSION';

export function purchasedTlConversionDecision(input:{
  paymentMode:'live'|'test'|'unknown';
  legalReviewApproved:boolean;
  consumerRefundRightsCleared:boolean;
  refundDeadlineMs:number|null;
  remainingPurchasedAtoms:number|null;
  refundDisputePending:boolean;
  nowMs:number;
}):PurchasedTlConversionDecision {
  if(input.paymentMode!=='live')return 'TEST_OR_UNVERIFIED_PAYMENT';
  if(!input.legalReviewApproved||!input.consumerRefundRightsCleared||
    !Number.isSafeInteger(input.refundDeadlineMs)||Number(input.refundDeadlineMs)<=0)
    return 'LEGAL_RIGHTS_REVIEW_REQUIRED';
  if(input.refundDisputePending)return 'REFUND_DISPUTE_PENDING';
  if(!Number.isSafeInteger(input.remainingPurchasedAtoms)||Number(input.remainingPurchasedAtoms)<0)
    return 'PURCHASE_ATTRIBUTION_REQUIRED';
  if(input.remainingPurchasedAtoms===0)return 'NO_REMAINING_PURCHASED_TL';
  if(!Number.isFinite(input.nowMs)||input.nowMs<Number(input.refundDeadlineMs))
    return 'REFUND_PERIOD_OPEN';
  return 'ELIGIBLE_FOR_CONTROLLED_CONVERSION';
}

export async function ensurePurchasedTlLotSchema(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_purchased_tl_lots (
    payment_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    method TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    paid_atoms INTEGER NOT NULL CHECK(paid_atoms>0),
    bonus_atoms INTEGER NOT NULL DEFAULT 0 CHECK(bonus_atoms>=0),
    payment_mode TEXT NOT NULL CHECK(payment_mode IN ('live','test','unknown')),
    recorded_at_ms INTEGER NOT NULL,
    refund_deadline_ms INTEGER,
    remaining_purchased_atoms INTEGER,
    consumer_rights_cleared INTEGER NOT NULL DEFAULT 0 CHECK(consumer_rights_cleared IN (0,1)),
    legal_review_approved INTEGER NOT NULL DEFAULT 0 CHECK(legal_review_approved IN (0,1)),
    refund_dispute_pending INTEGER NOT NULL DEFAULT 0 CHECK(refund_dispute_pending IN (0,1)),
    converted_atoms INTEGER NOT NULL DEFAULT 0 CHECK(converted_atoms>=0),
    conversion_status TEXT NOT NULL DEFAULT 'pending_legal_review',
    UNIQUE(method,payment_id)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_v5_purchased_tl_lots_user ON v5_purchased_tl_lots(user_id,recorded_at_ms)').run();
}

export function purchasedTlLotStatement(db:D1Database,input:{
  paymentKey:string;userId:string;method:string;paymentId:string;orderId:string;
  paidAtoms:number;bonusAtoms:number;paymentMode:'live'|'test'|'unknown';
  recordedAtMs:number;
}):D1PreparedStatement {
  if(!Number.isSafeInteger(input.paidAtoms)||input.paidAtoms<=0||
    !Number.isSafeInteger(input.bonusAtoms)||input.bonusAtoms<0||
    !Number.isSafeInteger(input.recordedAtMs)||input.recordedAtMs<=0)
    throw Error('INVALID_PURCHASED_TL_LOT');
  return db.prepare(`INSERT INTO v5_purchased_tl_lots
    (payment_key,user_id,method,payment_id,order_id,paid_atoms,bonus_atoms,payment_mode,recorded_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    input.paymentKey,input.userId,input.method,input.paymentId,input.orderId,
    input.paidAtoms,input.bonusAtoms,input.paymentMode,input.recordedAtMs
  );
}
