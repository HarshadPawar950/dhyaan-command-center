-- 051_project_areas_up.sql
-- Change D (Munish): two project-level area fields on private.projects.
--   * saleable_area — total saleable area in sq ft (nullable)
--   * carpet_area   — carpet area in sq ft (nullable)
-- Additive + nullable + no default → existing rows read NULL (unknown). The
-- sheet form, save, SELECT and read-only display all wire automatically via
-- lib/projectSheet.js (shared Group 2 'num' fields).
-- NOTE: private.properties (units) already has its OWN carpet_area column —
-- this is the project-level twin on a DIFFERENT table, not a rename/move.
BEGIN;

ALTER TABLE private.projects
  ADD COLUMN IF NOT EXISTS saleable_area numeric,
  ADD COLUMN IF NOT EXISTS carpet_area   numeric;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('051_project_areas', 'projects +saleable_area +carpet_area (numeric, nullable, sq ft); project-level twin of properties.carpet_area')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
