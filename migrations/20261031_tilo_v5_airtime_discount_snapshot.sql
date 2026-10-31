-- Preserve the effective administrator discount used for each verified TILO interval.
-- Existing rows are intentionally NULL: their historical coefficient is unknown;
-- do not rewrite past creator/platform financial amounts from the current policy.
ALTER TABLE tilo_v5_verified_airtime
  ADD COLUMN discount_coefficient_bps INTEGER
  CHECK(discount_coefficient_bps BETWEEN 0 AND 10000);
ALTER TABLE tilo_v5_verified_airtime
  ADD COLUMN discount_revision INTEGER
  CHECK(discount_revision >= 0);
