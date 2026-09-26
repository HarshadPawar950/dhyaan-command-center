-- =============================================================
-- 026_property_sheet_up.sql — SINGULAR sheet-style Properties.
-- Mirror the project SHEET onto the standalone LISTING (private.properties),
-- but singular: one unit, one owner, ONE area, single-select type.
-- Column names parallel private.projects (021) so the two tables read alike.
-- ADDITIVE. Every new column is nullable. 1 live property row survives untouched.
-- No smallest/largest cols exist on properties (they are project-only), so
-- nothing is dropped — the form simply renders ONE area (existing carpet_area).
-- =============================================================
BEGIN;

ALTER TABLE private.properties
  -- G1 Basic & Location  (title, owner_* already exist from 021)
  ADD COLUMN IF NOT EXISTS micro_market          text,
  ADD COLUMN IF NOT EXISTS locality              text,
  ADD COLUMN IF NOT EXISTS pincode               text,
  -- G2 Status & Structure  (possession_status enum + available_from stay legacy)
  ADD COLUMN IF NOT EXISTS status_of_property    text,   -- radio slug (mirrors projects 024)
  ADD COLUMN IF NOT EXISTS possession            text,   -- free-text possession timeline
  ADD COLUMN IF NOT EXISTS property_structure    text,
  ADD COLUMN IF NOT EXISTS property_type         text,   -- SINGLE-select (scalar, not array)
  -- G3 Unit Details (SINGULAR)  (config=Office Config, carpet_area, floor_number,
  --                              total_floors, facing, furnishing already exist)
  ADD COLUMN IF NOT EXISTS unit_no               text,
  ADD COLUMN IF NOT EXISTS unit_condition        text,
  ADD COLUMN IF NOT EXISTS vastu                 text,
  ADD COLUMN IF NOT EXISTS pantry                text,   -- commercial
  -- G4 Pricing & Legal  (expected_price, price_per_sqft, price_negotiable,
  --                       ownership_type already exist)
  ADD COLUMN IF NOT EXISTS payment_plan          text,
  ADD COLUMN IF NOT EXISTS documents_received    text,
  ADD COLUMN IF NOT EXISTS rera_number           text,
  -- G5 Amenities & Lifestyle  (balconies=Balcony, covered/open_parking=Parking exist)
  ADD COLUMN IF NOT EXISTS amenities             text[], -- selected amenity names (singular listing)
  ADD COLUMN IF NOT EXISTS view_note             text,
  ADD COLUMN IF NOT EXISTS lift_availability     text,
  -- G6 Connectivity & About  (about already exists)
  ADD COLUMN IF NOT EXISTS connectivity          text,
  ADD COLUMN IF NOT EXISTS nearby_infrastructure text,
  ADD COLUMN IF NOT EXISTS suitable_for          text,
  ADD COLUMN IF NOT EXISTS highlights            text,
  ADD COLUMN IF NOT EXISTS why_choose_this       text,
  ADD COLUMN IF NOT EXISTS google_maps_url       text,
  ADD COLUMN IF NOT EXISTS latitude              numeric,
  ADD COLUMN IF NOT EXISTS longitude             numeric;

-- Media for a STANDALONE property: property_images has only project_id today.
-- Add a nullable property_id so photos/videos/floor-plans attach to a listing.
-- Existing project media (property_id NULL) is untouched.
ALTER TABLE private.property_images
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES private.properties(property_id);
CREATE INDEX IF NOT EXISTS idx_property_images_property ON private.property_images(property_id);

COMMIT;
