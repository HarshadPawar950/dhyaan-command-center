-- =============================================================
-- 018_hierarchy_rename_down.sql — reverse of 018 up. Exact inverse.
-- Renames only; data travels in place.
-- =============================================================
BEGIN;

-- reverse ruling #3 bookings soft-delete
ALTER TABLE private.payments DROP COLUMN IF EXISTS deleted_at;

-- reverse downstream
ALTER TABLE private.cost_sheets     RENAME COLUMN property_id TO unit_id;
ALTER TABLE private.feedback        RENAME COLUMN project_id TO property_id;
ALTER TABLE private.payments_archive RENAME COLUMN project_id TO property_id;
ALTER TABLE private.payments        RENAME COLUMN project_id TO property_id;
ALTER TABLE private.site_visits     RENAME COLUMN project_id TO property_id;
ALTER TABLE private.property_images RENAME COLUMN project_id TO property_id;

-- reverse LAYER 2: properties(inventory) -> property_units (frees the name first)
ALTER TABLE private.properties     RENAME TO property_units;
ALTER TABLE private.property_units RENAME COLUMN property_id TO unit_id;
ALTER TABLE private.property_units RENAME COLUMN project_id  TO property_id;

-- reverse LAYER 1: projects -> properties
ALTER TABLE private.projects RENAME COLUMN project_id TO property_id;
ALTER TABLE private.projects RENAME TO properties;

COMMIT;
