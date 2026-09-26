-- =============================================================
-- 026_property_sheet_down.sql — reverse 026. Drops only the columns 026 added.
-- Safe: all were nullable/additive. property_images.property_id removed last.
-- =============================================================
BEGIN;

DROP INDEX IF EXISTS private.idx_property_images_property;
ALTER TABLE private.property_images DROP COLUMN IF EXISTS property_id;

ALTER TABLE private.properties
  DROP COLUMN IF EXISTS micro_market,
  DROP COLUMN IF EXISTS locality,
  DROP COLUMN IF EXISTS pincode,
  DROP COLUMN IF EXISTS status_of_property,
  DROP COLUMN IF EXISTS possession,
  DROP COLUMN IF EXISTS property_structure,
  DROP COLUMN IF EXISTS property_type,
  DROP COLUMN IF EXISTS unit_no,
  DROP COLUMN IF EXISTS unit_condition,
  DROP COLUMN IF EXISTS vastu,
  DROP COLUMN IF EXISTS pantry,
  DROP COLUMN IF EXISTS payment_plan,
  DROP COLUMN IF EXISTS documents_received,
  DROP COLUMN IF EXISTS rera_number,
  DROP COLUMN IF EXISTS amenities,
  DROP COLUMN IF EXISTS view_note,
  DROP COLUMN IF EXISTS lift_availability,
  DROP COLUMN IF EXISTS connectivity,
  DROP COLUMN IF EXISTS nearby_infrastructure,
  DROP COLUMN IF EXISTS suitable_for,
  DROP COLUMN IF EXISTS highlights,
  DROP COLUMN IF EXISTS why_choose_this,
  DROP COLUMN IF EXISTS google_maps_url,
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude;

COMMIT;
