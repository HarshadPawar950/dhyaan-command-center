-- 034_expenses_and_counter_series_down.sql
-- Reverses 034. Drops the expenses ledger, then reverts receipt_counters
-- to PK(year). Reverting the counter is destructive to any non-DHY-RCPT
-- series rows (e.g. EXP) — they are deleted first so PK(year) stays unique.
-- The DHY-RCPT counter value is preserved intact.

BEGIN;

DROP TABLE IF EXISTS private.expenses;

DELETE FROM private.receipt_counters WHERE series <> 'DHY-RCPT';
ALTER TABLE private.receipt_counters DROP CONSTRAINT IF EXISTS receipt_counters_pkey;
ALTER TABLE private.receipt_counters ADD CONSTRAINT receipt_counters_pkey PRIMARY KEY (year);
ALTER TABLE private.receipt_counters DROP COLUMN IF EXISTS series;

DELETE FROM private.schema_migrations WHERE migration = '034_expenses_and_counter_series';

COMMIT;
