-- =====================================================================
-- 007_rbac_permissions_down.sql — reverse 007
-- Drops the two RBAC enforcement tables. Leaves private.roles,
-- private.employee_roles, private.employees, and every other table
-- untouched. No data outside these two tables is affected.
-- =====================================================================

BEGIN;

DROP TABLE IF EXISTS private.role_permissions;
DROP TABLE IF EXISTS private.permissions;

COMMIT;
