-- 056_project_code_sequence_down.sql
-- Reverse 056. Drops the sequence. Does NOT restore the broken string-concat
-- generator — the code fix stands on its own; reverting this migration only
-- means nextval() would fail until the sequence is recreated.

BEGIN;

DROP SEQUENCE IF EXISTS private.project_code_seq;

DELETE FROM private.schema_migrations WHERE migration = '056_project_code_sequence';

COMMIT;
