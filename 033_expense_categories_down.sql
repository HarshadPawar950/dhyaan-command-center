-- 033_expense_categories_down.sql
-- Reverses 033. Safe only if no expenses reference these categories
-- (034 down drops expenses first).

BEGIN;

DROP INDEX IF EXISTS private.uq_expense_categories_name_live;
DROP TABLE IF EXISTS private.expense_categories;

DELETE FROM private.schema_migrations WHERE migration = '033_expense_categories';

COMMIT;
