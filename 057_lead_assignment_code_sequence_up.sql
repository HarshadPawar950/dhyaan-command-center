-- 057_lead_assignment_code_sequence_up.sql
-- Fix the lead-code AND assignment-code generators — same defect projects had
-- (migration 056), now applied to leads + assignments.
--
-- The old nextLeadCode() / nextAssignmentCode() / leads-import startCode() all ran
--   MAX(digits of external_id)::bigint + 1  in JS.
-- node-postgres returns bigint as a STRING, so `(max || 0) + 1` CONCATENATED
-- instead of adding — every create appended a '1', growing a repunit code until
-- the value overflowed bigint and blocked all creation. On top of that, prod
-- leads carried a bad row where a PHONE NUMBER (8826949899) was entered as the
-- external_id, and the string-concat defect had already mutated it into
-- L88269498991 — so MAX(digits)::bigint was reading an 11-digit phone-derived
-- number as the "highest lead code".
--
-- Replace both generators with dedicated, atomic, collision-proof SEQUENCES.
-- Each is seeded at 2000 — the repunit-free corridor between 1111 (R4) and
-- 11111 (R5), matching 056:
--   * lead_code_seq       -> L2000, L2001, ...  clears both poison rows
--     (8826949899 has no 'L' prefix so an L#### code can never string-equal it;
--      L88269498991 would only be reproduced at 88 billion creates, and the
--      existence-check retry skips it if it ever were). No normal lead codes
--      exist to preserve continuity with.
--   * assignment_code_seq -> A2000, A2001, ...  clears the lone existing A0001.
-- The two bad lead rows are DELIBERATELY left untouched (real data someone
-- entered) — the generators simply stop reading from external_id entirely.
--
-- UNIQUE indexes (leads_external_id_key, assignments_external_id_key) are
-- confirmed present in prod, so the app-side existence-check retry has a hard
-- backstop.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS private.lead_code_seq
    AS bigint
    START WITH 2000
    INCREMENT BY 1
    MINVALUE 2000
    NO MAXVALUE
    NO CYCLE;

CREATE SEQUENCE IF NOT EXISTS private.assignment_code_seq
    AS bigint
    START WITH 2000
    INCREMENT BY 1
    MINVALUE 2000
    NO MAXVALUE
    NO CYCLE;

-- Idempotent on re-run: never let either sequence sit below the 2000 floor,
-- but don't rewind if it has legitimately advanced past 2000.
SELECT setval('private.lead_code_seq',
              GREATEST(2000, (SELECT last_value FROM private.lead_code_seq)),
              (SELECT is_called FROM private.lead_code_seq));

SELECT setval('private.assignment_code_seq',
              GREATEST(2000, (SELECT last_value FROM private.assignment_code_seq)),
              (SELECT is_called FROM private.assignment_code_seq));

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('057_lead_assignment_code_sequence', 'lead_code_seq + assignment_code_seq (each START 2000) replace MAX(external_id)::bigint+1 which string-concatenated bigint-as-string into overflowing repunit codes (and read a phone-number poison row on leads); atomic + collision-proof; the two bad lead rows left untouched')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
