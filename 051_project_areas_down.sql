-- 051_project_areas_down.sql
-- Reverse 051_up. Drops the two additive project-level area columns.
-- Safe: additive columns with no dependents. Any entered values are lost.
BEGIN;

ALTER TABLE private.projects
  DROP COLUMN IF EXISTS saleable_area,
  DROP COLUMN IF EXISTS carpet_area;

DELETE FROM private.schema_migrations WHERE migration = '051_project_areas';

COMMIT;
