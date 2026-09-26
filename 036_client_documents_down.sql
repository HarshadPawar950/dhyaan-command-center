-- 036_client_documents_down.sql
-- Reverses 036. Drops the table (on-disk files are not touched by this migration).

BEGIN;

DROP TABLE IF EXISTS private.client_documents;

DELETE FROM private.schema_migrations WHERE migration = '036_client_documents';

COMMIT;
