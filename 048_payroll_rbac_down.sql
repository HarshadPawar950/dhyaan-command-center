-- 048_payroll_rbac_down.sql
BEGIN;
DELETE FROM private.role_permissions WHERE permission_key IN ('payroll.run','payroll.approve','payslip.view_own');
DELETE FROM private.permissions WHERE key IN ('payroll.run','payroll.approve','payslip.view_own');
DELETE FROM private.schema_migrations WHERE migration = '048_payroll_rbac';
COMMIT;
