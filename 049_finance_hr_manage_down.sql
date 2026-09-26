-- 049_finance_hr_manage_down.sql
-- Reverse ONLY what 049_up added.
--   * removes the hr_manager grant of finance.expenses.manage (leaves admin/super intact)
--   * removes finance.costsheet.manage entirely (new key + all 3 grants)
BEGIN;

DELETE FROM private.role_permissions
 WHERE (role_key = 'hr_manager' AND permission_key = 'finance.expenses.manage')
    OR permission_key = 'finance.costsheet.manage';

DELETE FROM private.permissions WHERE key = 'finance.costsheet.manage';

DELETE FROM private.schema_migrations WHERE migration = '049_finance_hr_manage';

COMMIT;
