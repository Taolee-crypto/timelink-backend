-- Guard every economy ledger debit at the database boundary, including concurrent writes.
-- No existing balances are modified by this migration.
CREATE TRIGGER IF NOT EXISTS trg_v3_economy_balances_nonnegative_update
BEFORE UPDATE OF available_atoms, held_atoms ON v3_economy_balances
FOR EACH ROW
WHEN NEW.available_atoms < 0 OR NEW.held_atoms < 0
BEGIN
  SELECT RAISE(ABORT, 'ECONOMY_NEGATIVE_BALANCE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_v3_economy_balances_nonnegative_insert
BEFORE INSERT ON v3_economy_balances
FOR EACH ROW
WHEN NEW.available_atoms < 0 OR NEW.held_atoms < 0
BEGIN
  SELECT RAISE(ABORT, 'ECONOMY_NEGATIVE_BALANCE_FORBIDDEN');
END;
