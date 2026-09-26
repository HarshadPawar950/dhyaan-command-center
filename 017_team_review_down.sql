-- =============================================================
-- 017_team_review_down.sql — reverse of 017 up. Safe to run repeatedly.
-- Drops in reverse dependency order. Additive rollback only.
-- =============================================================
BEGIN;

-- D)
ALTER TABLE private.attendance DROP COLUMN IF EXISTS deleted_at;

-- C)
ALTER TABLE private.property_images DROP CONSTRAINT IF EXISTS property_images_media_type_chk;
ALTER TABLE private.property_images
    DROP COLUMN IF EXISTS original_name,
    DROP COLUMN IF EXISTS file_size_bytes,
    DROP COLUMN IF EXISTS mime_type,
    DROP COLUMN IF EXISTS media_type;

-- B)
ALTER TABLE private.properties DROP COLUMN IF EXISTS bhk_config;

-- A)
ALTER TABLE private.properties DROP CONSTRAINT IF EXISTS properties_longitude_range;
ALTER TABLE private.properties DROP CONSTRAINT IF EXISTS properties_latitude_range;
ALTER TABLE private.properties
    DROP COLUMN IF EXISTS longitude,
    DROP COLUMN IF EXISTS latitude;

COMMIT;
