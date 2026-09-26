-- =============================================================
-- 005_pricing_up.sql — Pricing / Cost-Sheet Generator
-- Adds: pricing_config (rates), unit pricing columns,
--       properties.rera_number, cost_sheets audit table.
-- No existing columns altered or dropped. Approval engine untouched.
-- =============================================================

BEGIN;

-- 1. Rates live in the DB, never inline in code.
--    Percentages stored as fractions (0.06 = 6%), absolutes in rupees.
CREATE TABLE IF NOT EXISTS private.pricing_config (
    key         text PRIMARY KEY,
    value       numeric(14,4) NOT NULL,
    label       text NOT NULL,
    updated_at  timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at  timestamp without time zone
);

INSERT INTO private.pricing_config (key, value, label) VALUES
    ('gst_affordable',        0.0100,    'GST - affordable housing (under-construction only)'),
    ('gst_standard',          0.0500,    'GST - standard (under-construction only)'),
    ('stamp_duty',            0.0600,    'Stamp duty - Navi Mumbai incl. 1% metro cess'),
    ('stamp_duty_women',      0.0500,    'Stamp duty - women buyer (1% concession applied)'),
    ('registration_rate',     0.0100,    'Registration fee rate'),
    ('registration_cap',      30000,     'Registration fee cap (INR)'),
    ('affordable_value_cap',  4500000,   'Affordable housing value cap (INR) - form hint only'),
    ('affordable_carpet_sqm', 60,        'Affordable carpet area cap (sq m) - form hint only')
ON CONFLICT (key) DO NOTHING;

-- 2. Editable pricing inputs on the unit. NULL = not known; the
--    cost-sheet form treats NULL floor data as 0 rise.
ALTER TABLE private.property_units
    ADD COLUMN IF NOT EXISTS floor_number        integer,
    ADD COLUMN IF NOT EXISTS floor_rise_per_sqft numeric(10,2),
    ADD COLUMN IF NOT EXISTS plc_amount          numeric(12,2);

-- 3. Maharashtra RERA registration is per-project.
--    builders.rera_number stays as-is.
ALTER TABLE private.properties
    ADD COLUMN IF NOT EXISTS rera_number text;

-- 4. Every generated sheet is auditable: full numeric snapshot frozen
--    as JSONB so later rate changes never rewrite history.
CREATE TABLE IF NOT EXISTS private.cost_sheets (
    cost_sheet_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id       uuid NOT NULL REFERENCES private.property_units(unit_id),
    lead_id       uuid REFERENCES private.leads(lead_id),
    generated_by  uuid NOT NULL REFERENCES private.employees(employee_id),
    snapshot      jsonb NOT NULL,
    pdf_path      text,
    created_at    timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    timestamp without time zone
);

CREATE INDEX IF NOT EXISTS idx_cost_sheets_unit ON private.cost_sheets(unit_id);
CREATE INDEX IF NOT EXISTS idx_cost_sheets_lead ON private.cost_sheets(lead_id);

COMMIT;
