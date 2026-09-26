-- =============================================================
-- 010_lead_intake_up.sql — Lead intake automation (C-series)
-- Schema for three approved C0 features:
--   1. DEDUP        — leads.normalized_phone (generated, last-10-digits) + a
--                     PARTIAL index on ACTIVE leads (dedup checks active only).
--   2. ROUND-ROBIN  — assignment_pointer singleton table (rotation cursor).
--   3. SLA          — sla_config table (config-driven first-touch window, no
--                     hardcoding), seeded first_touch_hours = 24.
-- Additive ONLY. No existing column altered/dropped; every leads row stays
-- valid (normalized_phone is GENERATED, computed from the existing phone).
-- Approval engine / receipts / receivables / commissions untouched.
-- =============================================================

BEGIN;

-- 1. DEDUP --------------------------------------------------------------
-- Last 10 digits of the phone (strip all non-digits, take rightmost 10),
-- NULL when empty/blank so blank phones never collide. STORED + immutable
-- so it can be indexed. Matching is done in the intake route (block panel);
-- this is a lookup index, NOT a unique constraint (admin override allowed).
ALTER TABLE private.leads
    ADD COLUMN IF NOT EXISTS normalized_phone text
    GENERATED ALWAYS AS (
        NULLIF(right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10), '')
    ) STORED;

-- Partial index: dedup compares against ACTIVE leads only, so a soft-deleted
-- old lead never blocks a genuine re-enquiry.
CREATE INDEX IF NOT EXISTS idx_leads_normalized_phone
    ON private.leads (normalized_phone)
    WHERE deleted_at IS NULL AND normalized_phone IS NOT NULL;

-- 2. ROUND-ROBIN POINTER ------------------------------------------------
-- Singleton row (id can only ever be TRUE) holding the last-assigned exec.
-- The intake route reads it, picks the NEXT eligible exec in order, assigns,
-- and advances the cursor. Manual assignment bypasses this entirely.
CREATE TABLE IF NOT EXISTS private.assignment_pointer (
    id               boolean PRIMARY KEY DEFAULT true CHECK (id = true),
    last_employee_id uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    updated_at       timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO private.assignment_pointer (id, last_employee_id)
VALUES (true, NULL)
ON CONFLICT (id) DO NOTHING;

-- 3. SLA CONFIG ---------------------------------------------------------
-- Config-driven SLA windows (hours). Seeded with the approved 24h first-touch.
-- Values are read live by the SLA badge / overdue tile — nothing hardcoded.
CREATE TABLE IF NOT EXISTS private.sla_config (
    config_key  text PRIMARY KEY,
    hours       integer NOT NULL CHECK (hours > 0),
    description text,
    updated_at  timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO private.sla_config (config_key, hours, description)
VALUES ('first_touch_hours', 24, 'Hours allowed for the first follow-up on an assigned lead')
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
