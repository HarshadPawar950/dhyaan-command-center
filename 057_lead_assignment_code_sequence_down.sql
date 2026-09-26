-- 057_lead_assignment_code_sequence_down.sql
-- Reverse 057. Drops both sequences. Does NOT restore the broken string-concat
-- generators — the code fix stands on its own; reverting this migration only
-- means nextval() would fail until the sequences are recreated.

BEGIN;

DROP SEQUENCE IF EXISTS private.lead_code_seq;
DROP SEQUENCE IF EXISTS private.assignment_code_seq;

DELETE FROM private.schema_migrations WHERE migration = '057_lead_assignment_code_sequence';

COMMIT;
