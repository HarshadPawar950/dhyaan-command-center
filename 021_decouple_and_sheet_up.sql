-- =============================================================
-- 021_decouple_and_sheet_up.sql — DECOUPLE properties from projects,
-- add category (residential/commercial) to both, and the Dhyaan project SHEET.
-- ADDITIVE. All new cols nullable so the 1 real project row survives untouched.
-- project_id is made NULLABLE (deprecated, kept for rollback) — NOT dropped.
-- Reused (NOT re-added) on projects: title(=real_name), builder_id, rera_number,
-- possession(+possession_date), total_units_count, construction_status,
-- amenities(project_amenities join), location_advantages, about, price_range,
-- bhk_config, google_maps_url + lat/long.
-- =============================================================
BEGIN;

CREATE TYPE private.property_category AS ENUM ('residential','commercial');

-- ---------- PROJECTS: the Dhyaan sheet (36 additive cols) ----------
ALTER TABLE private.projects
  -- G1 Identity & Location
  ADD COLUMN IF NOT EXISTS micro_market          text,
  ADD COLUMN IF NOT EXISTS locality              text,
  ADD COLUMN IF NOT EXISTS pincode               text,
  ADD COLUMN IF NOT EXISTS code_name             text,      -- internal
  ADD COLUMN IF NOT EXISTS category              private.property_category,
  -- G2 Structure & Status
  ADD COLUMN IF NOT EXISTS status_of_property    text,
  ADD COLUMN IF NOT EXISTS property_structure    text,
  ADD COLUMN IF NOT EXISTS property_type         text,
  ADD COLUMN IF NOT EXISTS land_parcel           text,
  ADD COLUMN IF NOT EXISTS tower_block           text,
  -- G3 Units & Config
  ADD COLUMN IF NOT EXISTS smallest_unit_area    numeric,
  ADD COLUMN IF NOT EXISTS largest_unit_area     numeric,
  ADD COLUMN IF NOT EXISTS unit_condition        text,
  ADD COLUMN IF NOT EXISTS office_configuration  text,      -- commercial
  ADD COLUMN IF NOT EXISTS vastu                 text,
  -- G4 Pricing & Docs
  ADD COLUMN IF NOT EXISTS payment_plan          text,
  ADD COLUMN IF NOT EXISTS psf_rate              numeric,
  ADD COLUMN IF NOT EXISTS floor_rise_price      numeric,
  ADD COLUMN IF NOT EXISTS market_rate_psf       numeric,
  ADD COLUMN IF NOT EXISTS roi_rental_note       text,
  ADD COLUMN IF NOT EXISTS documents_received    text,
  -- G5 Facilities & Features
  ADD COLUMN IF NOT EXISTS facilities            text,
  ADD COLUMN IF NOT EXISTS view_note             text,
  ADD COLUMN IF NOT EXISTS balcony_note          text,
  ADD COLUMN IF NOT EXISTS lift_availability     text,
  ADD COLUMN IF NOT EXISTS pantry                text,
  -- G6 Location Advantages & Marketing (PUBLIC)
  ADD COLUMN IF NOT EXISTS connectivity          text,
  ADD COLUMN IF NOT EXISTS nearby_infrastructure text,
  ADD COLUMN IF NOT EXISTS suitable_for          text,
  ADD COLUMN IF NOT EXISTS project_highlights    text,
  ADD COLUMN IF NOT EXISTS contact_number        text,
  ADD COLUMN IF NOT EXISTS why_choose_this       text,
  -- G7 INTERNAL marketing (admin/super render only)
  ADD COLUMN IF NOT EXISTS limited_offer         text,
  ADD COLUMN IF NOT EXISTS creatives_note        text,
  ADD COLUMN IF NOT EXISTS ad_budget             numeric,
  ADD COLUMN IF NOT EXISTS targeted_keywords     text;

-- ---------- PROPERTIES: owner + category; decouple ----------
ALTER TABLE private.properties
  ADD COLUMN IF NOT EXISTS owner_name  text,
  ADD COLUMN IF NOT EXISTS owner_phone text,
  ADD COLUMN IF NOT EXISTS owner_email text,
  ADD COLUMN IF NOT EXISTS owner_notes text,
  ADD COLUMN IF NOT EXISTS category    private.property_category;

-- Decouple: project_id is now optional (properties are standalone listings).
-- Column KEPT for rollback safety; app stops reading it.
ALTER TABLE private.properties ALTER COLUMN project_id DROP NOT NULL;

COMMIT;
