/**
 * TILO TLC 50:50 mining integrity audit.
 * Read-only: no minting, no credits, no unlocks, no legacy reconciliation.
 * An administrator (including the founder) is an ordinary user for mining:
 * the validation compares every issuer receipt regardless of users.role.
 */
export async function readTlcIssuanceIntegrity(db:D1Database){
 const row=await db.prepare(`
 WITH verified_split AS (
   SELECT t.id, t.actor_user_id, r.minted_atoms AS gross_atoms,
     COUNT(e.id) AS entry_count,
     COALESCE(SUM(CASE WHEN a.owner_type='user'
                       AND CAST(a.owner_id AS TEXT)=CAST(t.actor_user_id AS TEXT)
                       AND a.bucket='wallet' THEN e.amount_atoms ELSE 0 END),0) AS member_atoms,
     COALESCE(SUM(CASE WHEN a.owner_type='platform'
                       AND a.owner_id='tilo-group'
                       AND a.bucket='permanent_value_reserve_locked'
                       THEN e.amount_atoms ELSE 0 END),0) AS group_atoms,
     COALESCE(SUM(CASE WHEN a.owner_type='system' AND a.bucket='issuance'
                       THEN e.amount_atoms ELSE 0 END),0) AS issuance_atoms,
     COALESCE(SUM(e.amount_atoms),0) AS conservation_atoms
   FROM v3_economy_transactions t
   LEFT JOIN v3_tlc_mining_records r ON r.idempotency_key=t.idempotency_key AND r.status='posted'
   LEFT JOIN v3_economy_entries e ON e.transaction_id=t.id AND e.asset_code='TLC'
   LEFT JOIN v3_economy_accounts a ON a.id=e.account_id
   WHERE t.transaction_type='tlc_development_mining'
     AND t.source='server_poc_v1' AND json_valid(t.metadata_json)
     AND json_extract(t.metadata_json,'$.split_policy')='tilo-group-5050-v1'
   GROUP BY t.id
 ),
 flagged AS (
   SELECT *,CASE WHEN gross_atoms IS NULL OR gross_atoms < 2
     OR entry_count<>3
     OR member_atoms<>CAST(gross_atoms/2 AS INTEGER)
     OR group_atoms<>(gross_atoms-CAST(gross_atoms/2 AS INTEGER))
     OR issuance_atoms<>(-gross_atoms)
     OR conservation_atoms<>0
    THEN 1 ELSE 0 END AS invalid
   FROM verified_split
 )
 SELECT COUNT(*) AS split_receipt_count,
   COALESCE(SUM(gross_atoms),0) AS gross_mined_atoms,
   COALESCE(SUM(member_atoms),0) AS member_mined_atoms,
   COALESCE(SUM(group_atoms),0) AS group_mined_atoms,
   COALESCE(SUM(invalid),0) AS invalid_split_count,
   (SELECT COUNT(*) FROM v3_tlc_mining_records WHERE status='posted'
    AND NOT EXISTS(SELECT 1 FROM v3_economy_transactions t
      WHERE t.idempotency_key=v3_tlc_mining_records.idempotency_key)) AS unmatched_mining_records,
   (SELECT COUNT(*) FROM v3_economy_transactions t
     JOIN v3_economy_entries e ON e.transaction_id=t.id AND e.asset_code='TLC' AND e.amount_atoms<0
     JOIN v3_economy_accounts a ON a.id=e.account_id
     WHERE a.owner_type='system' AND a.bucket='issuance'
       AND t.transaction_type<>'tlc_development_mining') AS nonmining_issuance_entries,
   (SELECT COUNT(*) FROM v3_economy_transactions t
     JOIN v3_economy_entries e ON e.transaction_id=t.id AND e.asset_code='TLC' AND e.amount_atoms>0
     JOIN v3_economy_accounts a ON a.id=e.account_id AND a.owner_type='user'
     WHERE t.transaction_type='tlc_development_mining'
       AND NOT EXISTS (SELECT 1 FROM v3_economy_transactions x
          WHERE x.id=t.id AND x.source='server_poc_v1' AND json_valid(x.metadata_json)
            AND json_extract(x.metadata_json,'$.split_policy')='tilo-group-5050-v1')) AS prepolicy_user_mining_entries,
   (SELECT COUNT(*) FROM v3_economy_transactions t
      JOIN v3_economy_entries e ON e.transaction_id=t.id AND e.asset_code='TLC' AND e.amount_atoms>0
      JOIN v3_economy_accounts a ON a.id=e.account_id AND a.owner_type='user'
      JOIN users u ON CAST(u.id AS TEXT)=a.owner_id
      WHERE t.transaction_type='tlc_development_mining' AND LOWER(u.role)='admin') AS admin_regular_mining_credits
 FROM flagged
 `).first<any>();
 const locked=await db.prepare(`SELECT COALESCE(SUM(b.held_atoms),0) AS held_atoms,
    COALESCE(SUM(b.available_atoms),0) AS available_atoms
   FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id
   WHERE a.owner_type='platform' AND a.owner_id='tilo-group'
     AND a.asset_code='TLC' AND a.bucket='permanent_value_reserve_locked'`).first<any>();
 const n=(value:unknown)=>Number(value||0);
 const gross=n(row?.gross_mined_atoms),member=n(row?.member_mined_atoms),group=n(row?.group_mined_atoms);
 const held=n(locked?.held_atoms),available=n(locked?.available_atoms);
 const invalid=n(row?.invalid_split_count),unexpected=n(row?.nonmining_issuance_entries);
 const reserveMatched=held===group&&available===0;
 return {
   ok:true,mode:'read_only_internal_tlc_audit',policy:'tilo-group-5050-v1',
   founder_personal_preallocation_allowed:false,
   founder_miners_follow_same_rules:true,
   no_fixed_max_supply:true,
   checked_split_receipts:n(row?.split_receipt_count),
   gross_mined_atoms:gross,member_mined_atoms:member,group_mined_atoms:group,
   reserve_held_atoms:held,reserve_available_atoms:available,
   invalid_split_count:invalid,
   unmatched_mining_records:n(row?.unmatched_mining_records),
   nonmining_issuance_entries:unexpected,
   prepolicy_user_mining_entries:n(row?.prepolicy_user_mining_entries),
   admin_regular_mining_credits:n(row?.admin_regular_mining_credits),
   reserve_matches_mining:reserveMatched,
   anomaly_free:invalid===0&&unexpected===0&&reserveMatched,
   // This query checks the V3 TLC ledger only; it is not an on-chain supply audit
   // and cannot prove all historical legacy grants or external-chain custody.
   scope:'v3_internal_ledger_not_external_blockchain',
   no_external_mint_attested:false
 };
}
