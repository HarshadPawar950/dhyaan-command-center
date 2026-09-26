-- =============================================================
-- 017_team_review_up.sql — Team Review batch (2026-07-23)
-- Additive ONLY. No existing column/table/enum is altered or dropped.
--   A) properties.latitude/longitude   — map coords (alt to google_maps_url)  [Δ4]
--   B) properties.bhk_config text[]     — multi-select unit configs           [Δ2]
--   C) property_images media extension  — media_type/mime/size/original_name  [Δ3]
--   D) attendance.deleted_at            — HR soft-delete (parity w/ leave)     [Δ9]
-- =============================================================
BEGIN;

-- A) Map coordinates (either coords OR the paste-link works)
ALTER TABLE private.properties
    ADD COLUMN IF NOT EXISTS latitude  numeric(9,6),
    ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='properties_latitude_range') THEN
    ALTER TABLE private.properties ADD CONSTRAINT properties_latitude_range
      CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='properties_longitude_range') THEN
    ALTER TABLE private.properties ADD CONSTRAINT properties_longitude_range
      CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180));
  END IF;
END $$;

-- B) BHK / unit-config checklist (canonical codes: 1BHK,2BHK,3BHK,4BHK+,Shop,Office)
ALTER TABLE private.properties
    ADD COLUMN IF NOT EXISTS bhk_config text[];

-- C) Extend the (already generic) property_images media table
ALTER TABLE private.property_images
    ADD COLUMN IF NOT EXISTS media_type      text NOT NULL DEFAULT 'photo',
    ADD COLUMN IF NOT EXISTS mime_type       text,
    ADD COLUMN IF NOT EXISTS file_size_bytes bigint,
    ADD COLUMN IF NOT EXISTS original_name   text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='property_images_media_type_chk') THEN
    ALTER TABLE private.property_images ADD CONSTRAINT property_images_media_type_chk
      CHECK (media_type IN ('photo','video','brochure'));
  END IF;
END $$;

-- D) Soft-delete on attendance (HR edit/remove)
ALTER TABLE private.attendance
    ADD COLUMN IF NOT EXISTS deleted_at timestamp without time zone;

COMMIT;
