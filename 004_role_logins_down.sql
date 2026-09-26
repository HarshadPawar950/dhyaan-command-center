-- =====================================================================
-- 004_role_logins_down.sql  —  Reverse of 004_role_logins_up.sql
-- Removes the 25 role-login accounts + all role mappings created in 004.
-- Real employees (Boss, Mukul, sales execs, etc.) are NOT deleted —
-- only their super_admin / it_admin role mappings added by 004 are removed.
-- =====================================================================

BEGIN;

-- mappings for the 25 generated accounts
DELETE FROM private.employee_roles
 WHERE employee_id IN (SELECT employee_id FROM private.employees WHERE external_id LIKE 'ROLE-LOGIN-%');

-- mappings added for existing people
DELETE FROM private.employee_roles
 WHERE role_key = 'super_admin'
   AND employee_id = (SELECT employee_id FROM private.employees WHERE name = 'Boss');
DELETE FROM private.employee_roles
 WHERE role_key = 'it_admin'
   AND employee_id = (SELECT employee_id FROM private.employees WHERE name = 'Mukul');

-- the generated accounts themselves
DELETE FROM private.employees WHERE external_id LIKE 'ROLE-LOGIN-%';

COMMIT;
