-- =============================================================
-- 024_structured_fields_down.sql — inverse of 024 up.
-- Drops the slab table; converts property_type back to text (first element).
-- =============================================================
BEGIN;

DROP TABLE IF EXISTS private.project_area_slabs;

ALTER TABLE private.projects
  ALTER COLUMN property_type TYPE text
  USING (CASE WHEN property_type IS NULL THEN NULL ELSE array_to_string(property_type, ', ') END);

COMMIT;
