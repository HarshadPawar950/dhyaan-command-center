-- 035_finance_rbac_up.sql
-- FINANCE MODULE (Phase 1) — RBAC seed (ruling §3, locked).
-- Three permission keys + tier grants, following the mig-007 convention
-- (permissions.key/label/category + role_permissions.role_key/permission_key).
--   finance.view            -> super_admin, admin   (P&L / GST / Cash-Flow)
--   finance.expenses.manage -> super_admin, admin   (expenses+categories CRUD, approve)
--   finance.expenses.view   -> super_admin, admin, hr_manager (read-only)
-- Idempotent (WHERE NOT EXISTS on live rows). Mutation routes gate on
-- finance.expenses.manage at the ROUTE, not the button.

BEGIN;

INSERT INTO private.permissions (key, label, category)
SELECT v.key, v.label, 'Finance'
  FROM (VALUES
    ('finance.view',            'View finance (P&L, GST, cash flow)'),
    ('finance.expenses.manage', 'Manage expenses & categories'),
    ('finance.expenses.view',   'View expenses & collections')
  ) AS v(key, label)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.permissions p WHERE p.key = v.key AND p.deleted_at IS NULL
 );

INSERT INTO private.role_permissions (role_key, permission_key)
SELECT g.role_key, g.permission_key
  FROM (VALUES
    ('super_admin', 'finance.view'),
    ('admin',       'finance.view'),
    ('super_admin', 'finance.expenses.manage'),
    ('admin',       'finance.expenses.manage'),
    ('super_admin', 'finance.expenses.view'),
    ('admin',       'finance.expenses.view'),
    ('hr_manager',  'finance.expenses.view')
  ) AS g(role_key, permission_key)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.role_permissions rp
     WHERE rp.role_key = g.role_key AND rp.permission_key = g.permission_key
       AND rp.deleted_at IS NULL
 );

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('035_finance_rbac', 'finance.view + finance.expenses.manage + finance.expenses.view keys & tier grants')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
