-- 058_project_property_type_other_down.sql
-- Reverse 058: drop the per-category Property Type "Other" free-text columns.
-- Destructive to any typed values, but they are display-only companions and were
-- never part of property_type[].
BEGIN;

ALTER TABLE private.projects
  DROP COLUMN IF EXISTS property_type_other_res,
  DROP COLUMN IF EXISTS property_type_other_com;

DELETE FROM private.schema_migrations WHERE migration = '058_project_property_type_other';

COMMIT;
