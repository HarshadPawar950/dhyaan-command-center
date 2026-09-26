-- 041_project_price_updates_down.sql
-- Reverses 041.

BEGIN;

DROP TABLE IF EXISTS private.project_price_updates;

DELETE FROM private.schema_migrations WHERE migration = '041_project_price_updates';

COMMIT;
