-- 049_finance_hr_manage_up.sql
-- Grant HR (hr_manager fine-role) FULL MANAGE of Expenses AND Cost Sheets.
--
--   finance.expenses.manage  -> ADD hr_manager (already: super_admin + admin).
--                               Lets HR add/edit/delete expenses + SUBMIT a
--                               >Rs.50,000 expense. Submitting only raises a
--                               FROZEN expense_create ticket — APPROVING it stays
--                               super_admin-only (/admin/approvals decide =
--                               ensureSuperAdmin). This migration does NOT touch
--                               that separation.
--
--   finance.costsheet.manage -> NEW catalog key (Finance). Granted to
--                               super_admin + admin + hr_manager. admin/super are
--                               seeded TOO so that when the paired code commit adds
--                               ensurePermission('finance.costsheet.manage') to the
--                               (today ensureAdmin-only) cost-sheet routes, nobody
--                               who can reach cost sheets now is locked out.
--
-- The route-gate swaps (ensureAdmin -> ensureAdminOrRole('hr_manager')) live in a
-- paired CODE commit; this migration is the DATA half. Idempotent.

BEGIN;

-- 1) New permission in the catalog (cost sheets). The expenses key already exists.
INSERT INTO private.permissions (key, label, category)
SELECT v.key, v.label, 'Finance'
  FROM (VALUES
    ('finance.costsheet.manage', 'Manage cost sheets (pricing generator)')
  ) AS v(key, label)
 WHERE NOT EXISTS (SELECT 1 FROM private.permissions p WHERE p.key = v.key AND p.deleted_at IS NULL);

-- 2) Grants.
INSERT INTO private.role_permissions (role_key, permission_key)
SELECT g.role_key, g.permission_key
  FROM (VALUES
    ('hr_manager',  'finance.expenses.manage'),
    ('super_admin', 'finance.costsheet.manage'),
    ('admin',       'finance.costsheet.manage'),
    ('hr_manager',  'finance.costsheet.manage')
  ) AS g(role_key, permission_key)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.role_permissions rp
     WHERE rp.role_key = g.role_key AND rp.permission_key = g.permission_key AND rp.deleted_at IS NULL);

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('049_finance_hr_manage', 'hr_manager +finance.expenses.manage; NEW finance.costsheet.manage -> super+admin+hr_manager (approval >50k stays super_admin)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
