-- 043_possession_down.sql
-- Reverses 043: drops the two possession columns from payments.

BEGIN;

ALTER TABLE private.payments
  DROP COLUMN IF EXISTS possession_date,
  DROP COLUMN IF EXISTS possession_status;

DELETE FROM private.schema_migrations WHERE migration = '043_possession';

COMMIT;
