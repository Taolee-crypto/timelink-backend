/**
 * V5 P2P settlement primitive.
 *
 * This is NOT an HTTP transfer endpoint. Only call it after the escrow state
 * machine has independently verified both parties' final approvals, a unique
 * TON TLC Jetton deposit, the immutable quote and the recipient's identity.
 * Never accept a browser-supplied "approved" or "paid" flag as evidence.
 */
import { assertTLAtomScale, ensureLedgerAccount, postLedgerTransaction } from './economy-ledger';

export type P2PTLSource = 'wallet_paid' | 'wallet_ad' | 'wallet_bonus';

export interface VerifiedP2PTLSettlement {
  tradeId: string;
  senderUserId: number;
  recipientUserId: number;
  amountAtoms: number;
  sourceBucket: P2PTLSource;
  // Attestation is produced by a trusted escrow settlement worker, never by the client.
  approvalsVerified: boolean;
  tonJettonDepositFinalized: boolean;
  settlementAuthorized: boolean;
}

export async function settleVerifiedP2PTL(db: D1Database, trade: VerifiedP2PTLSettlement) {
  if (!trade.approvalsVerified || !trade.tonJettonDepositFinalized || !trade.settlementAuthorized)
    throw new Error('P2P_ESCROW_NOT_READY');
  if (!Number.isSafeInteger(trade.senderUserId) || trade.senderUserId <= 0 ||
      !Number.isSafeInteger(trade.recipientUserId) || trade.recipientUserId <= 0 ||
      trade.senderUserId === trade.recipientUserId ||
      !Number.isSafeInteger(trade.amountAtoms) || trade.amountAtoms <= 0 ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(trade.tradeId) ||
      !['wallet_paid','wallet_ad','wallet_bonus'].includes(trade.sourceBucket))
    throw new Error('INVALID_P2P_SETTLEMENT');
  await assertTLAtomScale(db);
  const [sender,recipient] = await Promise.all([
    db.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0')
      .bind(trade.senderUserId).first(),
    db.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0')
      .bind(trade.recipientUserId).first()
  ]);
  if (!sender || !recipient) throw new Error('P2P_PARTICIPANT_INACTIVE');

  // Source provenance follows the transferred TL: paid stays paid, bonus stays bonus.
  const from = await ensureLedgerAccount(db,'user',trade.senderUserId,'TL',trade.sourceBucket);
  const to = await ensureLedgerAccount(db,'user',trade.recipientUserId,'TL',trade.sourceBucket);
  const result = await postLedgerTransaction(db,{
    idempotencyKey:'v5-p2p-tl-settlement:'+trade.tradeId,
    transactionType:'p2p_tl_transfer',
    source:'p2p_verified_escrow',
    referenceType:'p2p_trade',
    referenceId:trade.tradeId,
    actorUserId:String(trade.senderUserId),
    description:'P2P escrow verified TL ownership transfer',
    metadata:{
      sender_user_id:trade.senderUserId,recipient_user_id:trade.recipientUserId,
      source_bucket:trade.sourceBucket,amount_atoms:trade.amountAtoms,
      no_issuance:true
    },
    lines:[
      {accountId:from,assetCode:'TL',amountAtoms:-trade.amountAtoms},
      {accountId:to,assetCode:'TL',amountAtoms:trade.amountAtoms}
    ],
    // SQLite/D1 batch is transactional. If the sender lacks available TL,
    // this guard throws a SQL error and the entire ledger batch rolls back.
    // No client-visible transfer endpoint is exposed.
    issuanceStatements:[db.prepare(`
      SELECT CASE WHEN
        (SELECT available_atoms FROM v3_economy_balances WHERE account_id=?) >= ?
      THEN 1 ELSE json_extract('P2P_INSUFFICIENT_AVAILABLE_TL', '$.invalid') END
    `).bind(from,trade.amountAtoms)]
  });
  return { ...result, tradeId:trade.tradeId, amountAtoms:trade.amountAtoms };
}
