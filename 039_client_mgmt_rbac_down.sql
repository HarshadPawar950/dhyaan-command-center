-- 039_client_mgmt_rbac_down.sql
-- Reverses 039: removes the two client-mgmt permission keys and their grants.

BEGIN;

DELETE FROM private.role_permissions
 WHERE permission_key IN ('clients.documents.manage','clients.finance.manage');

DELETE FROM private.permissions
 WHERE key IN ('clients.documents.manage','clients.finance.manage');

DELETE FROM private.schema_migrations WHERE migration = '039_client_mgmt_rbac';

COMMIT;
