-- TimeLink development reset: generated SQL should be reviewed and run only after a fresh D1 backup.
-- This script produces a table-by-table cleanup inventory. It DOES NOT delete data.
-- Keep schema, indexes, migrations, and runtime configuration intact.
-- R2 objects are managed separately and have already been cleared by the operator.
SELECT name AS table_name,
       CASE
         WHEN name LIKE 'sqlite_%' OR name IN ('d1_migrations') THEN 'KEEP_SYSTEM'
         WHEN name LIKE 'v3_economy_%' THEN 'RESET_ECONOMY_AFTER_MIGRATION_REVIEW'
         WHEN name LIKE 'tl3_%' THEN 'RESET_V5_AND_PLAYBACK'
         WHEN name IN ('users','tl_files','tl_shares','tl_user_files','tl_assets',
                       'transactions','tl_ledger','tl_payments','tl_exchanges') THEN 'RESET'
         ELSE 'REVIEW_DEPENDENCIES'
       END AS action
FROM sqlite_master
WHERE type='table'
ORDER BY action, name;
