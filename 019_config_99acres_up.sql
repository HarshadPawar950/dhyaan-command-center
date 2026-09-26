-- =============================================================
-- 019_config_99acres_up.sql — 99acres-grade project & property config (2026-07-24)
-- ADDITIVE ONLY. No renames, no drops, no data movement. Reversible via _down.
--   PROJECT (development) gets overview/possession/scale/land/amenities/location fields.
--   PROPERTY (unit) gets price/area/floor/facing/furnishing/ownership/parking fields.
--   Amenities are multi-valued -> structured master + join table (seeded).
-- Reused (NOT re-added): projects.rera_number, builder_id, google_maps_url,
--   latitude/longitude, construction_status(=project_status); properties.config
--   (=bhk_type), floor_number. Config-summary strip is derived at query time.
-- Floor-plans ride the existing free-text property_images.media_type ('floor_plan').
-- =============================================================
BEGIN;

-- ---------- 1. ENUMS ----------
CREATE TYPE private.facing_direction AS ENUM
  ('north','south','east','west','north_east','north_west','south_east','south_west');
CREATE TYPE private.furnishing_status AS ENUM
  ('unfurnished','semi_furnished','furnished');
CREATE TYPE private.ownership_type AS ENUM
  ('freehold','leasehold','co_operative_society','power_of_attorney');

-- ---------- 2. AMENITIES (multi-valued -> structured) ----------
CREATE TABLE private.amenities (
  amenity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  icon_key   text,
  category   text,                        -- security | recreation | convenience | utility
  sort_order int  DEFAULT 0,
  active     boolean DEFAULT true
);
CREATE TABLE private.project_amenities (
  project_id uuid NOT NULL REFERENCES private.projects(project_id),
  amenity_id uuid NOT NULL REFERENCES private.amenities(amenity_id),
  PRIMARY KEY (project_id, amenity_id)
);

-- ---------- 3. PROJECT-level additive columns ----------
ALTER TABLE private.projects
  ADD COLUMN IF NOT EXISTS about               text,
  ADD COLUMN IF NOT EXISTS possession_date     date,
  ADD COLUMN IF NOT EXISTS launch_date         date,
  ADD COLUMN IF NOT EXISTS total_towers        integer,
  ADD COLUMN IF NOT EXISTS total_units_count   integer,
  ADD COLUMN IF NOT EXISTS land_area           numeric,
  ADD COLUMN IF NOT EXISTS land_area_unit      text DEFAULT 'acres',
  ADD COLUMN IF NOT EXISTS location_advantages text[],
  ADD COLUMN IF NOT EXISTS price_list_note     text;

-- ---------- 4. PROPERTY-level additive columns ----------
ALTER TABLE private.properties
  ADD COLUMN IF NOT EXISTS expected_price      numeric,
  ADD COLUMN IF NOT EXISTS price_per_sqft      numeric,      -- auto = expected_price / carpet_area
  ADD COLUMN IF NOT EXISTS price_negotiable    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS carpet_area         numeric,
  ADD COLUMN IF NOT EXISTS builtup_area        numeric,
  ADD COLUMN IF NOT EXISTS super_builtup_area  numeric,
  ADD COLUMN IF NOT EXISTS area_unit           text DEFAULT 'sqft',
  ADD COLUMN IF NOT EXISTS bathrooms           integer,
  ADD COLUMN IF NOT EXISTS balconies           integer,
  ADD COLUMN IF NOT EXISTS additional_rooms    text[],
  ADD COLUMN IF NOT EXISTS total_floors        integer,
  ADD COLUMN IF NOT EXISTS facing              private.facing_direction,
  ADD COLUMN IF NOT EXISTS overlooking         text[],
  ADD COLUMN IF NOT EXISTS furnishing          private.furnishing_status,
  ADD COLUMN IF NOT EXISTS furnishing_items    text,
  ADD COLUMN IF NOT EXISTS property_age_years  integer,
  ADD COLUMN IF NOT EXISTS possession_status   private.property_status,
  ADD COLUMN IF NOT EXISTS available_from      date,
  ADD COLUMN IF NOT EXISTS ownership_type      private.ownership_type,
  ADD COLUMN IF NOT EXISTS covered_parking     integer,
  ADD COLUMN IF NOT EXISTS open_parking        integer,
  ADD COLUMN IF NOT EXISTS about               text;

-- ---------- 5. SEED amenities master (extendable) ----------
INSERT INTO private.amenities (name, icon_key, category, sort_order) VALUES
  ('Lift','lift','convenience',10),
  ('24x7 Security','security','security',20),
  ('Gymnasium','gym','recreation',30),
  ('Swimming Pool','pool','recreation',40),
  ('Clubhouse','clubhouse','recreation',50),
  ('Landscaped Garden','garden','recreation',60),
  ('Power Backup','power','utility',70),
  ('Piped Gas','gas','utility',80),
  ('Children''s Play Area','play','recreation',90),
  ('Covered Parking','parking','convenience',100),
  ('CCTV Surveillance','cctv','security',110),
  ('Intercom','intercom','convenience',120),
  ('Jogging Track','jogging','recreation',130),
  ('Rainwater Harvesting','rainwater','utility',140),
  ('Fire Safety','fire','security',150),
  ('Visitor Parking','visitor_parking','convenience',160)
ON CONFLICT (name) DO NOTHING;

-- ---------- 6. WIDEN media_type to allow 'floor_plan' (99acres floor-plans tab) ----------
ALTER TABLE private.property_images DROP CONSTRAINT IF EXISTS property_images_media_type_chk;
ALTER TABLE private.property_images ADD CONSTRAINT property_images_media_type_chk
  CHECK (media_type = ANY (ARRAY['photo','video','brochure','floor_plan']));

COMMIT;
