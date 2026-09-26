-- =============================================================
-- 019_config_99acres_down.sql — exact inverse of 019 up.
-- Drops the additive columns, the amenities join+master, and the 3 enums.
-- (Additive migration => full reversal is safe; only 019-era data is lost.)
-- =============================================================
BEGIN;

-- reverse 6. media_type constraint back to the original 3 values
ALTER TABLE private.property_images DROP CONSTRAINT IF EXISTS property_images_media_type_chk;
ALTER TABLE private.property_images ADD CONSTRAINT property_images_media_type_chk
  CHECK (media_type = ANY (ARRAY['photo','video','brochure']));

-- reverse 4. PROPERTY columns
ALTER TABLE private.properties
  DROP COLUMN IF EXISTS expected_price,
  DROP COLUMN IF EXISTS price_per_sqft,
  DROP COLUMN IF EXISTS price_negotiable,
  DROP COLUMN IF EXISTS carpet_area,
  DROP COLUMN IF EXISTS builtup_area,
  DROP COLUMN IF EXISTS super_builtup_area,
  DROP COLUMN IF EXISTS area_unit,
  DROP COLUMN IF EXISTS bathrooms,
  DROP COLUMN IF EXISTS balconies,
  DROP COLUMN IF EXISTS additional_rooms,
  DROP COLUMN IF EXISTS total_floors,
  DROP COLUMN IF EXISTS facing,
  DROP COLUMN IF EXISTS overlooking,
  DROP COLUMN IF EXISTS furnishing,
  DROP COLUMN IF EXISTS furnishing_items,
  DROP COLUMN IF EXISTS property_age_years,
  DROP COLUMN IF EXISTS possession_status,
  DROP COLUMN IF EXISTS available_from,
  DROP COLUMN IF EXISTS ownership_type,
  DROP COLUMN IF EXISTS covered_parking,
  DROP COLUMN IF EXISTS open_parking,
  DROP COLUMN IF EXISTS about;

-- reverse 3. PROJECT columns
ALTER TABLE private.projects
  DROP COLUMN IF EXISTS about,
  DROP COLUMN IF EXISTS possession_date,
  DROP COLUMN IF EXISTS launch_date,
  DROP COLUMN IF EXISTS total_towers,
  DROP COLUMN IF EXISTS total_units_count,
  DROP COLUMN IF EXISTS land_area,
  DROP COLUMN IF EXISTS land_area_unit,
  DROP COLUMN IF EXISTS location_advantages,
  DROP COLUMN IF EXISTS price_list_note;

-- reverse 2. amenities (join first, then master)
DROP TABLE IF EXISTS private.project_amenities;
DROP TABLE IF EXISTS private.amenities;

-- reverse 1. enums
DROP TYPE IF EXISTS private.ownership_type;
DROP TYPE IF EXISTS private.furnishing_status;
DROP TYPE IF EXISTS private.facing_direction;

COMMIT;
