-- 040_legal_documents_down.sql
-- Reverses 040. On-disk files are not touched by this migration.

BEGIN;

DROP TABLE IF EXISTS private.legal_documents;

DELETE FROM private.schema_migrations WHERE migration = '040_legal_documents';

COMMIT;
