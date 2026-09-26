-- =============================================================
-- Migration 027 DOWN — reverse the property + leads client-profile additions.
-- Drops only the columns 027 added (legacy covered_parking/open_parking and the
-- pre-existing carpet_area are left intact). Sellable-area backfill is not
-- un-done column-wise; dropping sellable_area discards it (the source carpet_area
-- values remain).
-- =============================================================
BEGIN;

ALTER TABLE private.properties
  DROP COLUMN IF EXISTS sellable_area,
  DROP COLUMN IF EXISTS address_details,
  DROP COLUMN IF EXISTS roi_rental_note,
  DROP COLUMN IF EXISTS listing_sale,
  DROP COLUMN IF EXISTS listing_rent,
  DROP COLUMN IF EXISTS parking_available,
  DROP COLUMN IF EXISTS parking_type,
  DROP COLUMN IF EXISTS parking_count;

ALTER TABLE private.leads
  DROP COLUMN IF EXISTS cp_configuration,
  DROP COLUMN IF EXISTS cp_use,
  DROP COLUMN IF EXISTS cp_possession_pref,
  DROP COLUMN IF EXISTS cp_funding,
  DROP COLUMN IF EXISTS cp_down_payment,
  DROP COLUMN IF EXISTS cp_budget_tag,
  DROP COLUMN IF EXISTS cp_amenities,
  DROP COLUMN IF EXISTS cp_visit_pref,
  DROP COLUMN IF EXISTS cp_urgency_note;

COMMIT;
