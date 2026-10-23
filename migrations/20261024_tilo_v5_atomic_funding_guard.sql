-- Fail closed inside the SAME SQLite transaction as a TILO funding debit.
-- Protect only the dedicated TILO funding bucket, leaving unrelated V5 accounts unchanged.
-- D1 batch is transactional: RAISE(ABORT) rolls back the ledger posting.
CREATE TRIGGER IF NOT EXISTS tilo_v5_funding_nonnegative_update
BEFORE UPDATE OF available_atoms ON v3_economy_balances
FOR EACH ROW
WHEN NEW.available_atoms < 0 AND EXISTS (
  SELECT 1 FROM v3_economy_accounts a
  WHERE a.id=NEW.account_id AND a.owner_type='platform'
    AND a.owner_id='timelink' AND a.asset_code='TL'
    AND a.bucket='tilo_broadcast_funding'
)
BEGIN
  SELECT RAISE(ABORT,'INSUFFICIENT_TILO_PLATFORM_FUNDING_ATOMIC');
END;

CREATE TRIGGER IF NOT EXISTS tilo_v5_funding_nonnegative_insert
BEFORE INSERT ON v3_economy_balances
FOR EACH ROW
WHEN NEW.available_atoms < 0 AND EXISTS (
  SELECT 1 FROM v3_economy_accounts a
  WHERE a.id=NEW.account_id AND a.owner_type='platform'
    AND a.owner_id='timelink' AND a.asset_code='TL'
    AND a.bucket='tilo_broadcast_funding'
)
BEGIN
  SELECT RAISE(ABORT,'INSUFFICIENT_TILO_PLATFORM_FUNDING_ATOMIC');
END;
