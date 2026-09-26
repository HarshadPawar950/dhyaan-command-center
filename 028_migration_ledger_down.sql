-- 028_migration_ledger_down.sql
-- Reverses 028: drops the migration ledger table.

BEGIN;

DROP TABLE IF EXISTS private.schema_migrations;

COMMIT;
