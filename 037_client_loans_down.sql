-- 037_client_loans_down.sql
-- Reverses 037.

BEGIN;

DROP TABLE IF EXISTS private.client_loans;

DELETE FROM private.schema_migrations WHERE migration = '037_client_loans';

COMMIT;
