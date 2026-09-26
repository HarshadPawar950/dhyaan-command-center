-- =============================================================
-- 018_hierarchy_rename_up.sql — Builder → Project → Property hierarchy (2026-07-23)
-- RENAME-ONLY. No rows move; data travels in place. Reversible via _down.
--   Today's `properties` (42 live) ARE developments  -> become `projects`
--   Today's `property_units` (170 live) ARE inventory -> become `properties`
--   Downstream FK columns re-pointed semantically (they referenced developments
--   = now projects; cost_sheets referenced a unit = now a property).
-- Constraint/index NAMES are intentionally left stale-but-functional (cosmetic;
-- renaming them adds risk for zero behavioural gain).
-- =============================================================
BEGIN;

-- LAYER 1: developments -> PROJECTS
ALTER TABLE private.properties RENAME TO projects;
ALTER TABLE private.projects   RENAME COLUMN property_id TO project_id;

-- LAYER 2: units -> PROPERTIES (the saleable inventory)
-- Rename the parent-FK column FIRST (property_id -> project_id) so it doesn't
-- clash with the PK rename that follows.
ALTER TABLE private.property_units RENAME COLUMN property_id TO project_id;
ALTER TABLE private.property_units RENAME COLUMN unit_id     TO property_id;
ALTER TABLE private.property_units RENAME TO properties;

-- DOWNSTREAM: columns that referenced a development now name it project_id.
ALTER TABLE private.property_images RENAME COLUMN property_id TO project_id;  -- media is project-level
ALTER TABLE private.site_visits     RENAME COLUMN property_id TO project_id;
ALTER TABLE private.payments        RENAME COLUMN property_id TO project_id;
ALTER TABLE private.feedback        RENAME COLUMN property_id TO project_id;
ALTER TABLE private.payments_archive RENAME COLUMN property_id TO project_id;  -- archive mirrors payments
-- cost_sheets referenced a unit (= inventory) -> now a property.
ALTER TABLE private.cost_sheets     RENAME COLUMN unit_id TO property_id;
-- campaigns.project_id already references developments (= projects) — unchanged.

-- RULING #3: bookings (= payments rows) get soft-delete, mirroring leads/projects.
ALTER TABLE private.payments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMIT;
