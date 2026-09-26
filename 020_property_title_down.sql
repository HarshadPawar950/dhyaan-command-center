-- =============================================================
-- 020_property_title_down.sql — exact inverse of 020 up.
-- =============================================================
BEGIN;
ALTER TABLE private.properties DROP COLUMN IF EXISTS title;
COMMIT;
