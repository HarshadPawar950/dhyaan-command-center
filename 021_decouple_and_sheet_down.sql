-- =============================================================
-- 021_decouple_and_sheet_down.sql — inverse of 021 up.
-- Drops the 41 additive columns + the enum. Re-imposes project_id NOT NULL
-- ONLY if no NULLs exist (post-decouple data may have NULLs → leave nullable).
-- =============================================================
BEGIN;

-- properties: owner + category
ALTER TABLE private.properties
  DROP COLUMN IF EXISTS owner_name,
  DROP COLUMN IF EXISTS owner_phone,
  DROP COLUMN IF EXISTS owner_email,
  DROP COLUMN IF EXISTS owner_notes,
  DROP COLUMN IF EXISTS category;

-- restore project_id NOT NULL only if safe
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.properties WHERE project_id IS NULL) THEN
    ALTER TABLE private.properties ALTER COLUMN project_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'project_id left NULLABLE — NULLs present post-decouple';
  END IF;
END $$;

-- projects: the sheet columns
ALTER TABLE private.projects
  DROP COLUMN IF EXISTS micro_market, DROP COLUMN IF EXISTS locality,
  DROP COLUMN IF EXISTS pincode, DROP COLUMN IF EXISTS code_name,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS status_of_property, DROP COLUMN IF EXISTS property_structure,
  DROP COLUMN IF EXISTS property_type, DROP COLUMN IF EXISTS land_parcel,
  DROP COLUMN IF EXISTS tower_block,
  DROP COLUMN IF EXISTS smallest_unit_area, DROP COLUMN IF EXISTS largest_unit_area,
  DROP COLUMN IF EXISTS unit_condition, DROP COLUMN IF EXISTS office_configuration,
  DROP COLUMN IF EXISTS vastu,
  DROP COLUMN IF EXISTS payment_plan, DROP COLUMN IF EXISTS psf_rate,
  DROP COLUMN IF EXISTS floor_rise_price, DROP COLUMN IF EXISTS market_rate_psf,
  DROP COLUMN IF EXISTS roi_rental_note, DROP COLUMN IF EXISTS documents_received,
  DROP COLUMN IF EXISTS facilities, DROP COLUMN IF EXISTS view_note,
  DROP COLUMN IF EXISTS balcony_note, DROP COLUMN IF EXISTS lift_availability,
  DROP COLUMN IF EXISTS pantry,
  DROP COLUMN IF EXISTS connectivity, DROP COLUMN IF EXISTS nearby_infrastructure,
  DROP COLUMN IF EXISTS suitable_for, DROP COLUMN IF EXISTS project_highlights,
  DROP COLUMN IF EXISTS contact_number, DROP COLUMN IF EXISTS why_choose_this,
  DROP COLUMN IF EXISTS limited_offer, DROP COLUMN IF EXISTS creatives_note,
  DROP COLUMN IF EXISTS ad_budget, DROP COLUMN IF EXISTS targeted_keywords;

DROP TYPE IF EXISTS private.property_category;

COMMIT;
