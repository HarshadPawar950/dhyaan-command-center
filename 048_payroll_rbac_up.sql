-- 048_payroll_rbac_up.sql
-- PHASE 4 · PAYROLL — RBAC seed (ruling §5).
--   payroll.run      -> super_admin + hr_manager  (structures, compute draft, generate payslips)
--   payroll.approve  -> super_admin ONLY          (approve run before paid; edit statutory rates)
--                       two-hands on salary: hr_manager (Drishti) can RUN but can NEVER
--                       self-approve her own run to paid.
--   payslip.view_own -> super_admin, admin, employee tiers (covers everyone; hr_manager is
--                       employee-tier + fine role, so the employee grant applies). Ownership
--                       is enforced in-route (sealed + employee_id match) — this key only
--                       says "may view a payslip"; WHICH payslip is the ownership check.
-- Idempotent.

BEGIN;

INSERT INTO private.permissions (key, label, category)
SELECT v.key, v.label, 'Payroll'
  FROM (VALUES
    ('payroll.run',      'Run payroll (structures, compute, payslips)'),
    ('payroll.approve',  'Approve payroll run & edit statutory rates'),
    ('payslip.view_own', 'View own payslips')
  ) AS v(key, label)
 WHERE NOT EXISTS (SELECT 1 FROM private.permissions p WHERE p.key = v.key AND p.deleted_at IS NULL);

INSERT INTO private.role_permissions (role_key, permission_key)
SELECT g.role_key, g.permission_key
  FROM (VALUES
    ('super_admin', 'payroll.run'),
    ('hr_manager',  'payroll.run'),
    ('super_admin', 'payroll.approve'),
    ('super_admin', 'payslip.view_own'),
    ('admin',       'payslip.view_own'),
    ('employee',    'payslip.view_own')
  ) AS g(role_key, permission_key)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.role_permissions rp
     WHERE rp.role_key = g.role_key AND rp.permission_key = g.permission_key AND rp.deleted_at IS NULL);

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('048_payroll_rbac', 'payroll.run (super+hr_manager) + payroll.approve (super only) + payslip.view_own (all)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
