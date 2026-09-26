-- =====================================================================
-- 001_roles_down.sql  —  Reverse of 001_roles_up.sql
-- Fully reverses the role system. Existing employees columns/gating untouched,
-- so this returns the schema to its exact pre-migration state.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS private.idx_employee_roles_role;
DROP TABLE IF EXISTS private.employee_roles;
DROP TABLE IF EXISTS private.roles;

COMMIT;
