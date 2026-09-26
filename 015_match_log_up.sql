-- =============================================================
-- 015_match_log_up.sql — property-matcher run log (AI Day, Feature 1)
-- Records ONE row every time an employee clicks "Find Matches" on a lead:
-- the parsed requirements used, the top-5 suggestions returned, and how many
-- units were skipped for incomplete data. Powers the demo story and future
-- learning (which suggestions later converted).
--
-- Additive ONLY. Creates one NEW table + two indexes. No existing
-- column/table/enum altered or dropped. The matcher itself is deterministic
-- and works fully without this table — logging is a side-effect, never on the
-- read/scoring path.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS private.match_log (
    match_log_id   uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    -- The lead the matcher ran against. SET NULL (not CASCADE) so the audit
    -- row survives even if the lead is ever removed. Leads are soft-delete
    -- only, so in normal operation this stays populated.
    lead_id        uuid REFERENCES private.leads(lead_id) ON DELETE SET NULL,
    -- Actor, stored the same way history_log stores it (employees.external_id
    -- + display name) so the log is readable without a join.
    run_by_code    text,
    run_by_name    text,
    run_at         timestamptz NOT NULL DEFAULT NOW(),
    -- Parsed inputs the scorer actually used: {budget_lakhs, bhk, location,
    -- budget_parsed:bool} plus the weights snapshot. JSONB so the shape can
    -- evolve without a migration.
    params         jsonb,
    -- Array of the top-5 suggestions: [{unit_id, property_id, title, config,
    -- price_lakhs, score, reasons:[...]}]. JSONB, append-only.
    top5           jsonb,
    -- Honesty counters — how many units were scored vs skipped for dirty data.
    total_scored   integer NOT NULL DEFAULT 0,
    skipped_count  integer NOT NULL DEFAULT 0
);

-- "show me every match run for this lead", newest first.
CREATE INDEX IF NOT EXISTS idx_match_log_lead
    ON private.match_log (lead_id, run_at DESC);

-- "recent matcher activity across the office", newest first.
CREATE INDEX IF NOT EXISTS idx_match_log_run_at
    ON private.match_log (run_at DESC);

COMMIT;
