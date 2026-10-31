import { readRewardPolicy } from './v5-reward-policy';
import { readPurchasedTlAttribution } from './v5-purchased-tl-attribution';
import { assertTLAtomScale,ensureLedgerAccount,postLedgerTransaction,tlToAtoms,atomsToTl } from './economy-ledger';
/** Purchased principal only. Creator royalties have a separate contribution-
 * based redemption policy and must not enter this listener eligibility test. */
export async function listenerCashoutEligibility(db:D1Database,userId:number){
  await assertTLAtomScale(db);
  const row=await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN t.transaction_type='payment_credit'
      THEN CAST(json_extract(t.metadata_json,'$.paid_tl') AS REAL)*10000 ELSE 0 END),0) AS purchased_atoms
    FROM v3_economy_transactions t WHERE t.actor_user_id=?`).bind(String(userId)).first<any>();
  const credits=await db.prepare(`SELECT COALESCE(SUM(e.amount_atoms),0) AS granted_atoms
    FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id
    JOIN v3_economy_transactions t ON t.id=e.transaction_id
    WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL'
      AND a.bucket IN ('wallet_paid','wallet_ad','wallet_bonus') AND e.amount_atoms>0
      AND t.transaction_type NOT IN ('track_charge','v5_early_stop','listener_cashout_return')`)
    .bind(String(userId)).first<any>();
  const reservations=await db.prepare(`SELECT COALESCE(SUM(CAST(json_extract(metadata_json,'$.amount_atoms') AS INTEGER)),0) AS atoms
    FROM v3_economy_transactions WHERE actor_user_id=? AND transaction_type='listener_cashout_request'`)
    .bind(String(userId)).first<any>();
  const purchased=Number(row?.purchased_atoms||0),granted=Number(credits?.granted_atoms||0);
  // The paid wallet can also hold creator royalties. Only verified LIVE
  // purchase lots actually remaining in wallet_paid may fund a listener cashout.
  // Unknown/test receipts, active disputes and legally reviewed expired lots
  // must not be borrowed from creator settlements or already spent purchases.
  const attribution=await readPurchasedTlAttribution(db,String(userId));
  const lotRows=await db.prepare(
    'SELECT payment_key,payment_mode,refund_dispute_pending,refund_deadline_ms,'+
    'consumer_rights_cleared,legal_review_approved FROM v5_purchased_tl_lots WHERE user_id=?'
  ).bind(String(userId)).all<{
    payment_key:string;payment_mode:string;refund_dispute_pending:number;
    refund_deadline_ms:number|null;consumer_rights_cleared:number;legal_review_approved:number;
  }>();
  const byKey=new Map((lotRows.results||[]).map(l=>[l.payment_key,l]));
  const now=Date.now();
  let livePurchasedWalletAtoms=0;
  for(const lot of attribution.lots){
    const saved=byKey.get(lot.paymentKey);
    if(!saved || saved.payment_mode!=='live' || saved.refund_dispute_pending===1)continue;
    if(saved.legal_review_approved===1 && saved.consumer_rights_cleared===1 &&
       Number.isSafeInteger(saved.refund_deadline_ms) && now>=Number(saved.refund_deadline_ms))continue;
    livePurchasedWalletAtoms+=lot.walletAtoms;
    if(!Number.isSafeInteger(livePurchasedWalletAtoms))throw Error('PURCHASED_PRINCIPAL_OVERFLOW');
  }
  const paidAccount=attribution.accounts.find(a=>a.bucket==='wallet_paid');
  if(livePurchasedWalletAtoms>Number(paidAccount?.available_atoms||0))
    throw Error('PURCHASED_PRINCIPAL_ATTRIBUTION_MISMATCH');
  return {livePurchasedWalletAtoms,paidAccountSnapshot:paidAccount||null,
    purchasedAtoms:purchased,grantedAtoms:granted,
    principalRemainingAtoms:Math.max(0,purchased-Number(reservations?.atoms||0)),
    purchaseRatio:granted>0?purchased/granted:0,eligible:granted>0&&purchased*2>=granted,
    policyVersion:'listener-purchased-history-50pct-v5',
    // Imported legacy balances require evidence reconciliation before cashout.
    legacy_purchase_history_included:false};
}
export async function requestListenerCashout(db:D1Database,input:{userId:number;amountTL:number;requestKey:string;plan:string}){
  const {userId,amountTL,requestKey}=input;
  const policy=await readRewardPolicy(db);
  if(!Number.isSafeInteger(amountTL)||amountTL<=0||!Number.isSafeInteger(tlToAtoms(amountTL))||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey))throw new Error('INVALID_CASHOUT_REQUEST');
  const prior=await db.prepare('SELECT metadata_json FROM v3_economy_transactions WHERE idempotency_key=?')
    .bind('v5-listener-cashout:'+userId+':'+requestKey).first<any>();
  if(prior){const m=JSON.parse(prior.metadata_json);if(m.amount_atoms!==tlToAtoms(amountTL))throw new Error('IDEMPOTENCY_CONFLICT');return {ok:true,replayed:true,request_id:requestKey,fee_tl:m.fee_tl,net_tl:m.net_tl};}
  if(amountTL<policy.rules.exchange_min)throw new Error('MINIMUM_CASHOUT_AMOUNT');
  const eligibility=await listenerCashoutEligibility(db,userId);
  if(!eligibility.eligible)throw new Error('PURCHASE_HISTORY_BELOW_50_PERCENT');
  const atoms=tlToAtoms(amountTL);
  if(atoms>eligibility.principalRemainingAtoms)throw new Error('PURCHASED_PRINCIPAL_LIMIT');
  if(atoms>eligibility.livePurchasedWalletAtoms)throw new Error('VERIFIED_LIVE_PURCHASE_BALANCE_REQUIRED');
  const paidSnapshot=eligibility.paidAccountSnapshot;
  if(!paidSnapshot||paidSnapshot.held_atoms!==0||paidSnapshot.available_atoms<atoms)
    throw new Error('PURCHASED_PRINCIPAL_WALLET_LOCKED');
  const feePct=input.plan==='B'?policy.rules.fee_b:policy.rules.fee_a,feeTL=Math.ceil(amountTL*feePct),netTL=amountTL-feeTL;
  const paid=await ensureLedgerAccount(db,'user',userId,'TL','wallet_paid');
  const pending=await ensureLedgerAccount(db,'escrow',userId,'TL','listener_cashout_pending');
  // Serialize principal reservations in SQLite, not a read/then-write check.
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_listener_cashout_requests(
    user_id INTEGER NOT NULL,request_key TEXT NOT NULL,amount_atoms INTEGER NOT NULL,
    principal_limit_atoms INTEGER NOT NULL,fee_tl INTEGER NOT NULL,net_tl INTEGER NOT NULL,
    state TEXT DEFAULT 'pending',created_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(user_id,request_key))`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_cashout_principal_guard BEFORE INSERT ON v5_listener_cashout_requests
    WHEN NEW.amount_atoms+(SELECT COALESCE(SUM(amount_atoms),0) FROM v5_listener_cashout_requests WHERE user_id=NEW.user_id)>NEW.principal_limit_atoms
    BEGIN SELECT RAISE(ABORT,'PURCHASED_PRINCIPAL_LIMIT'); END`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_cashout_ratio_guard BEFORE INSERT ON v5_listener_cashout_requests
    WHEN (SELECT COALESCE(SUM(CAST(json_extract(metadata_json,'$.paid_tl') AS REAL)*10000),0)*2
      FROM v3_economy_transactions WHERE actor_user_id=CAST(NEW.user_id AS TEXT) AND transaction_type='payment_credit')
    < (SELECT COALESCE(SUM(e.amount_atoms),0) FROM v3_economy_entries e
      JOIN v3_economy_accounts a ON a.id=e.account_id JOIN v3_economy_transactions t ON t.id=e.transaction_id
      WHERE a.owner_type='user' AND a.owner_id=CAST(NEW.user_id AS TEXT) AND a.asset_code='TL'
        AND a.bucket IN ('wallet_paid','wallet_ad','wallet_bonus') AND e.amount_atoms>0
        AND t.transaction_type NOT IN ('track_charge','v5_early_stop','listener_cashout_return'))
    BEGIN SELECT RAISE(ABORT,'PURCHASE_HISTORY_BELOW_50_PERCENT'); END`).run();
  const posted=await postLedgerTransaction(db,{
    idempotencyKey:'v5-listener-cashout:'+userId+':'+requestKey,transactionType:'listener_cashout_request',source:'listener_cashout',
    actorUserId:String(userId),referenceType:'cashout_request',referenceId:requestKey,
    description:'일반 회원 구매 TL 환전 신청·심사 대기 보관',
    metadata:{amount_atoms:atoms,fee_tl:feeTL,net_tl:netTL,policy_version:eligibility.policyVersion,reward_policy_version:policy.version},
    lines:[{accountId:paid,assetCode:'TL',amountAtoms:-atoms},{accountId:pending,assetCode:'TL',amountAtoms:atoms}],
    atomicStatements:[
      // The account has just been debited by this same atomic D1 batch.
      // Reject competing concurrent wallet writes instead of withdrawing royalties.
      db.prepare("SELECT CASE WHEN (SELECT version FROM v3_economy_balances WHERE account_id=?)=? "+
        "AND (SELECT available_atoms FROM v3_economy_balances WHERE account_id=?)=? "+
        "THEN 1 ELSE json_extract('invalid','
      .bind(userId,requestKey,atoms,eligibility.purchasedAtoms,feeTL,netTL),
      db.prepare("INSERT INTO tl_exchanges(user_id,tl_amount,fee_pct,fee_tl,net_tl,status) VALUES(?,?,?,?,?,'pending')").bind(userId,amountTL,feePct,feeTL,netTL)]
  });
  return {ok:true,replayed:posted.replayed,request_id:requestKey,tl_requested:amountTL,fee_tl:feeTL,net_tl:netTL,fee_pct:feePct*100,
    note:'환전 심사 대기 중입니다. 현금 지급 완료를 의미하지 않습니다.'};
}
) END")
        .bind(paidSnapshot.id,paidSnapshot.version+1,paidSnapshot.id,paidSnapshot.available_atoms-atoms),
      db.prepare(`INSERT INTO v5_listener_cashout_requests(user_id,request_key,amount_atoms,principal_limit_atoms,fee_tl,net_tl) VALUES(?,?,?,?,?,?)`)
      .bind(userId,requestKey,atoms,eligibility.purchasedAtoms,feeTL,netTL),
      db.prepare("INSERT INTO tl_exchanges(user_id,tl_amount,fee_pct,fee_tl,net_tl,status) VALUES(?,?,?,?,?,'pending')").bind(userId,amountTL,feePct,feeTL,netTL)]
  });
  return {ok:true,replayed:posted.replayed,request_id:requestKey,tl_requested:amountTL,fee_tl:feeTL,net_tl:netTL,fee_pct:feePct*100,
    note:'환전 심사 대기 중입니다. 현금 지급 완료를 의미하지 않습니다.'};
}
