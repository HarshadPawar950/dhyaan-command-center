-- 056_project_code_sequence_up.sql
-- Fix the project-code generator.
--
-- The old nextPropertyCode() ran  MAX(digits of external_id)::bigint + 1  in JS.
-- But node-postgres returns bigint as a STRING, so `(max || 0) + 1` CONCATENATED
-- instead of adding — every create appended a '1', producing an all-1s "repunit"
-- code: PROJ001, PROJ011, PROJ111, PROJ1111 ... up to PROJ<twenty 1s>. The 20th
-- value (1.1e19) OVERFLOWS bigint, so the next MAX(...)::bigint threw
-- "out of range for type bigint" and blocked ALL new project creation.
--
-- Replace that generator with a dedicated, atomic, collision-proof SEQUENCE.
-- Seeded at 2000 — the repunit-free corridor between 1111 (R4) and 11111 (R5):
-- codes PROJ2000..PROJ11110 are 9,111 guaranteed-unique values, and the app keeps
-- an existence-check retry as a backstop beyond that. The existing 20 project
-- codes are NOT renamed — other rows reference them.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS private.project_code_seq
    AS bigint
    START WITH 2000
    INCREMENT BY 1
    MINVALUE 2000
    NO MAXVALUE
    NO CYCLE;

-- Idempotent on re-run: never let the sequence sit below the 2000 floor,
-- but don't rewind it if it has legitimately advanced past 2000.
SELECT setval('private.project_code_seq',
              GREATEST(2000, (SELECT last_value FROM private.project_code_seq)),
              (SELECT is_called FROM private.project_code_seq));

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('056_project_code_sequence', 'project_code_seq (START 2000) replaces MAX(external_id)::bigint+1 which string-concatenated bigint-as-string into overflowing repunit codes; atomic + collision-proof; existing codes untouched')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
