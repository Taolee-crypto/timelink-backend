import {ensureContributionSchema,contributionEventStatement} from './v5-contribution-store';
import { assertTLAtomScale, ensureLedgerAccount, postLedgerTransaction, tlToAtoms } from './economy-ledger';

/** Called only after provider verification. The payment receipt and wallet
 * posting either both commit or both roll back. Package bonuses stay TL_B. */
export async function creditVerifiedPayment(db:D1Database,input:{userId:string;method:string;
  paymentId:string;orderId:string;paidTL:number;bonusTL:number;paymentMode?:'live'|'test'|'unknown';atomicStatements?:D1PreparedStatement[]}) {
  await assertTLAtomScale(db);
  const {userId,method,paymentId,orderId,paidTL,bonusTL}=input;
  if(!Number.isSafeInteger(paidTL)||paidTL<=0||!Number.isSafeInteger(bonusTL)||bonusTL<0)
    throw new Error('INVALID_PAYMENT_AMOUNT');
  if(method==='toss'||method==='portone'){
    await db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_payment_order_guard BEFORE INSERT ON tl_payments
      WHEN NEW.method IN ('toss','portone') AND NOT EXISTS(
        SELECT 1 FROM tl_toss_orders o WHERE o.order_id=NEW.merchant_uid
          AND o.user_id=NEW.user_id AND o.amount_krw=NEW.amount_krw AND o.status='ready')
      BEGIN SELECT RAISE(ABORT,'PAYMENT_ORDER_ALREADY_USED_OR_MISMATCHED'); END`).run();
    if(!input.atomicStatements?.length)throw new Error('PAYMENT_ORDER_TRANSITION_REQUIRED');
  }
  // Only verified LIVE receipts enter the renewal PoC record. Test/unknown
  // payments remain excluded; this does not activate new mining.
  if(input.paymentMode==='live')await ensureContributionSchema(db);
  const contributionStatements=input.paymentMode==='live'?[contributionEventStatement(db,{
    eventKey:'payment:'+method+':'+paymentId,userId,activity:'paid_topup',quantity:paidTL,
    occurredAtMs:Date.now(),evidenceRef:'payment:'+method+':'+paymentId,
    economicKey:'payment:'+method+':'+paymentId,counterpartyId:null,verified:true,revoked:false
  })]:[];
  const source=await ensureLedgerAccount(db,'system','pg:'+method,'TL','verified_payment_issuance');
  const paid=await ensureLedgerAccount(db,'user',userId,'TL','wallet_paid');
  const lines:any[]=[{accountId:source,assetCode:'TL',amountAtoms:-tlToAtoms(paidTL+bonusTL)},
    {accountId:paid,assetCode:'TL',amountAtoms:tlToAtoms(paidTL)}];
  if(bonusTL)lines.push({accountId:await ensureLedgerAccount(db,'user',userId,'TL','wallet_bonus'),
    assetCode:'TL',amountAtoms:tlToAtoms(bonusTL)});
  return postLedgerTransaction(db,{
    idempotencyKey:'v5-payment:'+method+':'+paymentId,transactionType:'payment_credit',source:'pg:'+method,
    referenceType:'payment',referenceId:paymentId,actorUserId:userId,
    description:'검증된 결제 TL_P 및 프로모션 TL_B 충전',
    metadata:{user_id:userId,order_id:orderId,paid_tl:paidTL,bonus_tl:bonusTL,payment_mode:input.paymentMode||'unknown'},lines,
    issuanceStatements:[db.prepare('UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1 WHERE account_id=?')
      .bind(tlToAtoms(paidTL+bonusTL),source)],
    atomicStatements:[
      ...contributionStatements,
      db.prepare(`INSERT INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,bonus_tl,status)
        VALUES (?,?,?,?,?,?,?,'success')`).bind(userId,method,paymentId,orderId,paidTL,paidTL+bonusTL,bonusTL),
      db.prepare('UPDATE users SET tl_p_lifetime=COALESCE(tl_p_lifetime,0)+? WHERE id=?').bind(paidTL,userId),
      ...(input.atomicStatements||[])]
  });
}
