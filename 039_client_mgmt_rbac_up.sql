-- 039_client_mgmt_rbac_up.sql
-- CUSTOMER MGMT (Phase 2) — RBAC seed (ruling §4, locked). Admin + super only;
-- employee access DEFERRED to Phase 2b (own client's goals+loan, never docs).
--   clients.documents.manage -> super_admin, admin
--   clients.finance.manage   -> super_admin, admin   (loans + goals write)
-- Idempotent. Mutations gate at the ROUTE, not the button.

BEGIN;

INSERT INTO private.permissions (key, label, category)
SELECT v.key, v.label, 'Clients'
  FROM (VALUES
    ('clients.documents.manage', 'Manage client documents (KYC/financial)'),
    ('clients.finance.manage',   'Manage client loans & investment goals')
  ) AS v(key, label)
 WHERE NOT EXISTS (SELECT 1 FROM private.permissions p WHERE p.key = v.key AND p.deleted_at IS NULL);

INSERT INTO private.role_permissions (role_key, permission_key)
SELECT g.role_key, g.permission_key
  FROM (VALUES
    ('super_admin', 'clients.documents.manage'),
    ('admin',       'clients.documents.manage'),
    ('super_admin', 'clients.finance.manage'),
    ('admin',       'clients.finance.manage')
  ) AS g(role_key, permission_key)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.role_permissions rp
     WHERE rp.role_key = g.role_key AND rp.permission_key = g.permission_key AND rp.deleted_at IS NULL);

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('039_client_mgmt_rbac', 'clients.documents.manage + clients.finance.manage keys & grants (super+admin)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
