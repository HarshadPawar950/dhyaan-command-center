-- =============================================================
-- 016_property_showcase_down.sql — reverse 016 (property showcase)
-- Drops the property_images table + its index and the google_maps_url column.
-- Safe to run repeatedly (IF EXISTS guards). Uploaded image ROWS are lost on
-- drop (the files on disk under public/uploads/properties/ are not touched).
-- =============================================================

BEGIN;

DROP INDEX IF EXISTS private.idx_property_images_prop;
DROP TABLE IF EXISTS private.property_images;
ALTER TABLE private.properties DROP COLUMN IF EXISTS google_maps_url;

COMMIT;
