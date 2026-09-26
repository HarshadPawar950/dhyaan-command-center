-- =====================================================================
-- 003_hr_roles_down.sql  —  Reverse of 003_hr_roles_up.sql
-- Removes the 4 HR roles. Delete children before parents (inherits FK).
-- =====================================================================

BEGIN;

DELETE FROM private.employee_roles WHERE role_key IN
  ('hr_head','hr_manager','hr_executive','payroll_officer');

-- order respects inherits FK: hr_head -> hr_manager -> hr_executive
DELETE FROM private.roles WHERE role_key = 'hr_head';
DELETE FROM private.roles WHERE role_key = 'hr_manager';
DELETE FROM private.roles WHERE role_key = 'hr_executive';
DELETE FROM private.roles WHERE role_key = 'payroll_officer';

COMMIT;
