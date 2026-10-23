import { assertTLAtomScale, ensureLedgerAccount, postLedgerTransaction } from './economy-ledger';
import { validateAndCalculateBroadcastAirtime, type VerifiedBroadcastAirtime } from './central-broadcast-v5-airtime';

/**
 * INTERNAL ONLY. Never expose to listeners or public API.
 * The broadcaster must independently authenticate the event, verify rights,
 * verify audible intervals and fund the escrow before invoking this function.
 */
export async function settleVerifiedCentralBroadcast(
  db: D1Database, event: VerifiedBroadcastAirtime,
  evidence: { rightsGrantId: string; verifiedBy: string }
) {
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(evidence.rightsGrantId) ||
      !/^[a-zA-Z0-9:_-]{8,128}$/.test(evidence.verifiedBy))
    throw new Error('Missing verified broadcast rights/evidence');
  await assertTLAtomScale(db);
  // Never trust a caller-provided grant ID or creator ID alone.
  // A missing rights table/grant deliberately fails closed.
  const grant=await db.prepare(`
    SELECT g.grant_id FROM central_broadcast_rights_grants g
    JOIN tl3_v5_releases v ON v.file_id=g.file_id AND v.status='sealed'
    JOIN tl_files f ON f.id=v.file_id AND f.shared=1
      AND COALESCE(f.revenue_held,0)=0
    WHERE g.grant_id=? AND g.file_id=? AND g.creator_id=?
      AND v.user_id=? AND g.country=?
      AND g.status='active'
      AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))
    LIMIT 1
  `).bind(evidence.rightsGrantId,event.fileId,event.creatorId,
    event.creatorId,event.country).first();
  if(!grant)throw new Error('BROADCAST_RIGHTS_NOT_VERIFIED');
  const a=validateAndCalculateBroadcastAirtime(event);
  if(a.totalAtoms<=0)throw new Error('No billable broadcast airtime');
  const existing=await db.prepare(
    'SELECT id FROM v3_economy_transactions WHERE idempotency_key=?'
  ).bind(a.idempotencyKey).first<{id:string}>();
  if(existing)return {transactionId:existing.id,replayed:true,...a};
  const escrow=await ensureLedgerAccount(db,'escrow','central-broadcast','TL','broadcast_budget');
  const creator=await ensureLedgerAccount(db,'user',event.creatorId,'TL','broadcast_earnings');
  const platform=await ensureLedgerAccount(db,'platform','timelink','TL','broadcast_revenue');
  const funds=await db.prepare(
    'SELECT available_atoms FROM v3_economy_balances WHERE account_id=?'
  ).bind(escrow).first<{available_atoms:number}>();
  if(!funds || Number(funds.available_atoms)<a.totalAtoms)throw new Error('BROADCAST_BUDGET_INSUFFICIENT');
  // A trigger in the same D1 transaction prevents concurrent overdrafts.
  // RAISE(ABORT) aborts the entire D1 batch, including ledger entries.
  const debitGuard=db.prepare(`
    SELECT CASE WHEN
      (SELECT available_atoms FROM v3_economy_balances WHERE account_id=?) < ?
      THEN json_extract('invalid', '$') ELSE 1 END
  `).bind(escrow,a.totalAtoms);
  const posted=await postLedgerTransaction(db,{
    idempotencyKey:a.idempotencyKey,transactionType:'central_broadcast_settlement',
    source:'verified_central_broadcast',referenceType:'broadcast_event',referenceId:event.eventId,
    description:'V5 중앙방송 검증 송출 정산',
    metadata:{file_id:event.fileId,creator_id:event.creatorId,country:event.country,
      played_ms:a.playedMs,rights_grant_id:evidence.rightsGrantId,verified_by:evidence.verifiedBy},
    lines:[
      {accountId:escrow,assetCode:'TL',amountAtoms:-a.totalAtoms},
      {accountId:creator,assetCode:'TL',amountAtoms:a.creatorAtoms},
      {accountId:platform,assetCode:'TL',amountAtoms:a.platformAtoms}
    ],
    // Guard must precede debit, not follow it. Use issuanceStatements (prepended).
    issuanceStatements:[debitGuard]
  });
  return {transactionId:posted.id,replayed:posted.replayed,...a};
}
