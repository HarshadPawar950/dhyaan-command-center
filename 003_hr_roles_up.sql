-- =====================================================================
-- 003_hr_roles_up.sql  —  HR roles (Batch 4)
-- Additive & reversible. Seeds the 4 HR roles into private.roles.
-- HR Head > HR Manager > HR Executive form an inheritance chain;
-- Payroll Officer is a standalone function.
-- Down-migration: 003_hr_roles_down.sql
-- =====================================================================

BEGIN;

-- insert base-of-chain first so the inherits FK resolves
INSERT INTO private.roles (role_key, name, category, sort_order, inherits, permissions, description) VALUES
 ('hr_executive','HR Executive','hr',26,NULL,
   '["attendance.manage","leave.manage","documents.collect"]',
   'Attendance, leave, document collection.'),

 ('hr_manager','HR Manager','hr',25,'hr_executive',
   '["recruitment.manage","onboarding.manage","exits.manage","grievance.handle"]',
   'Recruitment, onboarding, exits, grievance handling.'),

 ('hr_head','HR Head','hr',24,'hr_manager',
   '["hr.policy","hiring.approve","employees.view.all"]',
   'Policy, hiring approvals, access to all employee data.'),

 ('payroll_officer','Payroll Officer','hr',27,NULL,
   '["payroll.process","statutory.pf","statutory.esi","statutory.pt","statutory.tds"]',
   'Salary processing, statutory filings (PF, ESI, PT, TDS).')
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
