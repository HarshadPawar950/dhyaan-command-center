-- 046_statutory_rates_down.sql
BEGIN;
DROP TABLE IF EXISTS private.pt_slabs;
DROP TABLE IF EXISTS private.statutory_rates;
DELETE FROM private.schema_migrations WHERE migration = '046_statutory_rates';
COMMIT;
