-- =============================================================
-- 022_mixeduse_down.sql — inverse of 022 up.
-- Drops the CHECK, the 17 per-category (res_/com_) columns, and the 2 flags.
-- Leaves the deprecated single `category` enum column in place (021 owns it).
-- =============================================================
BEGIN;

ALTER TABLE private.projects DROP CONSTRAINT IF EXISTS projects_has_one_category;

ALTER TABLE private.projects
  DROP COLUMN IF EXISTS res_smallest_unit_area, DROP COLUMN IF EXISTS com_smallest_unit_area,
  DROP COLUMN IF EXISTS res_largest_unit_area,  DROP COLUMN IF EXISTS com_largest_unit_area,
  DROP COLUMN IF EXISTS res_unit_condition,     DROP COLUMN IF EXISTS com_unit_condition,
  DROP COLUMN IF EXISTS res_config,             DROP COLUMN IF EXISTS com_config,
  DROP COLUMN IF EXISTS res_vastu,
  DROP COLUMN IF EXISTS res_psf_rate,           DROP COLUMN IF EXISTS com_psf_rate,
  DROP COLUMN IF EXISTS res_floor_rise_price,   DROP COLUMN IF EXISTS com_floor_rise_price,
  DROP COLUMN IF EXISTS res_market_rate_psf,    DROP COLUMN IF EXISTS com_market_rate_psf,
  DROP COLUMN IF EXISTS res_roi_rental_note,    DROP COLUMN IF EXISTS com_roi_rental_note,
  DROP COLUMN IF EXISTS has_residential,        DROP COLUMN IF EXISTS has_commercial;

COMMIT;
