-- 035_finance_rbac_down.sql
-- Reverses 035: removes the finance grants and permission keys (seed rows
-- we added). Hard-delete is correct here — these are our own seed rows.

BEGIN;

DELETE FROM private.role_permissions
 WHERE permission_key IN ('finance.view','finance.expenses.manage','finance.expenses.view');

DELETE FROM private.permissions
 WHERE key IN ('finance.view','finance.expenses.manage','finance.expenses.view');

DELETE FROM private.schema_migrations WHERE migration = '035_finance_rbac';

COMMIT;
