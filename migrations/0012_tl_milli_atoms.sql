-- TL ledger precision upgrade.
-- One TL = 10,000 integer atoms (0.0001 TL per atom).
-- This preserves existing whole-TL balances while allowing millisecond playback settlement
-- at 0.001 TL increments and exact 70:30 splits.
DROP TRIGGER IF EXISTS trg_v3_economy_entries_no_update;

UPDATE v3_economy_entries
SET amount_atoms = amount_atoms * 10000
WHERE asset_code='TL';

UPDATE v3_economy_balances
SET available_atoms = available_atoms * 10000,
    held_atoms = held_atoms * 10000,
    version = version + 1,
    updated_at = datetime('now')
WHERE account_id IN (
  SELECT id FROM v3_economy_accounts WHERE asset_code='TL'
);

UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';

CREATE TABLE IF NOT EXISTS tl3_assertion_guard (ok INTEGER NOT NULL CHECK(ok=1));

UPDATE v3_economy_legacy_imports
SET imported_atoms = imported_atoms * 10000
WHERE target_account_id IN (
  SELECT id FROM v3_economy_accounts WHERE asset_code='TL'
) AND imported_atoms IS NOT NULL;

CREATE TRIGGER trg_v3_economy_entries_no_update
BEFORE UPDATE ON v3_economy_entries
BEGIN
  SELECT RAISE(ABORT, 'V3 economy entries are immutable');
END;
