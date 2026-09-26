-- =============================================================
-- 014_team_layer_up.sql — manager mapping (reports_to) for the Team Layer
-- Adds a single nullable self-referencing column to private.employees so a
-- real employee can point at their manager.
--
-- DEPTH-1 TEAMS ONLY (v1): team of X = active E00[0-8] employees whose
-- reports_to = X. The application resolves EXACTLY ONE level — a manager who
-- themselves reports upward does NOT cascade their sub-team upward. No
-- recursive chains are walked anywhere.
--
-- Additive ONLY. No existing column/table/enum altered or dropped. This
-- migration grants NO permission — view_team enforcement is decoupled and
-- flows through the RBAC layer (permissions / role_permissions), not this.
-- =============================================================

BEGIN;

-- Self-referencing manager pointer. NULL = no manager mapped.
ALTER TABLE private.employees
    ADD COLUMN IF NOT EXISTS reports_to uuid
        REFERENCES private.employees(employee_id);

-- No employee may report to themselves — blocked at the DB, idempotently.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'employees_reports_to_not_self'
          AND conrelid = 'private.employees'::regclass
    ) THEN
        ALTER TABLE private.employees
            ADD CONSTRAINT employees_reports_to_not_self
            CHECK (reports_to IS NULL OR reports_to <> employee_id);
    END IF;
END $$;

-- Fast "who reports to X" team lookups.
CREATE INDEX IF NOT EXISTS idx_employees_reports_to
    ON private.employees (reports_to) WHERE reports_to IS NOT NULL;

COMMIT;
