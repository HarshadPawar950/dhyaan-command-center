-- =============================================================
-- 005_pricing_down.sql — rollback for 005_pricing_up.sql
-- WARNING: drops cost_sheets (and its audit rows) and pricing_config.
-- Only run if rolling back the entire pricing feature.
-- =============================================================

BEGIN;

DROP TABLE IF EXISTS private.cost_sheets;
DROP TABLE IF EXISTS private.pricing_config;

ALTER TABLE private.properties
    DROP COLUMN IF EXISTS rera_number;

ALTER TABLE private.property_units
    DROP COLUMN IF EXISTS floor_number,
    DROP COLUMN IF EXISTS floor_rise_per_sqft,
    DROP COLUMN IF EXISTS plc_amount;

COMMIT;
