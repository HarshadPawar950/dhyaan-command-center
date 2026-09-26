-- 044_phase3_rbac_up.sql
-- PHASE 3 — RBAC seed (ruling §5). super_admin + admin only; no employee access.
--   legal.manage            -> legal vault upload/download/delete
--   builder.pricing.manage  -> write price-updates + offers
-- Possession rides the existing bookings.manage grant (no new key).
-- Idempotent. Mutations gate at the ROUTE.

BEGIN;

INSERT INTO private.permissions (key, label, category)
SELECT v.key, v.label, v.cat
  FROM (VALUES
    ('legal.manage',           'Manage legal vault (agreements, RERA, NOCs)', 'Legal'),
    ('builder.pricing.manage', 'Manage builder price updates & offers',       'Builders')
  ) AS v(key, label, cat)
 WHERE NOT EXISTS (SELECT 1 FROM private.permissions p WHERE p.key = v.key AND p.deleted_at IS NULL);

INSERT INTO private.role_permissions (role_key, permission_key)
SELECT g.role_key, g.permission_key
  FROM (VALUES
    ('super_admin', 'legal.manage'),
    ('admin',       'legal.manage'),
    ('super_admin', 'builder.pricing.manage'),
    ('admin',       'builder.pricing.manage')
  ) AS g(role_key, permission_key)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.role_permissions rp
     WHERE rp.role_key = g.role_key AND rp.permission_key = g.permission_key AND rp.deleted_at IS NULL);

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('044_phase3_rbac', 'legal.manage + builder.pricing.manage keys & grants (super+admin)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
