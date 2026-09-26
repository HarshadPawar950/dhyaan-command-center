-- 047_payroll_runs_down.sql
BEGIN;
DROP TABLE IF EXISTS private.payslips;
DROP TABLE IF EXISTS private.payroll_runs;
DELETE FROM private.schema_migrations WHERE migration = '047_payroll_runs';
COMMIT;
