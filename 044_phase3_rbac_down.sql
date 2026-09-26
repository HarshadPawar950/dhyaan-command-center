-- 044_phase3_rbac_down.sql
-- Reverses 044: removes the two Phase-3 permission keys and their grants.

BEGIN;

DELETE FROM private.role_permissions
 WHERE permission_key IN ('legal.manage','builder.pricing.manage');

DELETE FROM private.permissions
 WHERE key IN ('legal.manage','builder.pricing.manage');

DELETE FROM private.schema_migrations WHERE migration = '044_phase3_rbac';

COMMIT;
