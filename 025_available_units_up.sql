-- =============================================================
-- 025_available_units_up.sql — repurpose the G3 repeater.
-- The area-range slab table becomes the AVAILABLE-UNITS inventory: the actual
-- units currently available (Unit No / Area / Floor), per category.
-- project_area_slabs had only E2E test rows (all owning projects soft-deleted;
-- 0 rows on any live project) -> dropped. smallest/largest_unit_area revert to
-- direct sheet fields (no schema change; they simply stop being derived).
-- Any existing single res_/com_ unit values migrate into one row each (all null
-- today -> no-op, but kept for correctness).
-- =============================================================
BEGIN;

DROP TABLE IF EXISTS private.project_area_slabs;

CREATE TABLE IF NOT EXISTS private.project_available_units (
    unit_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES private.projects(project_id) ON DELETE CASCADE,
    category    private.property_category NOT NULL,   -- residential | commercial
    unit_no     text,
    unit_area   text,
    floor_no    text,
    sort_order  int NOT NULL DEFAULT 0,
    deleted_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avail_units_project ON private.project_available_units(project_id);

-- Migrate existing single unit values into one row each (no-op today).
INSERT INTO private.project_available_units (project_id, category, unit_no, unit_area, floor_no, sort_order)
SELECT project_id, 'residential', res_unit_no, res_unit_area_available, res_floor_number, 0
  FROM private.projects
 WHERE res_unit_no IS NOT NULL OR res_unit_area_available IS NOT NULL OR res_floor_number IS NOT NULL;
INSERT INTO private.project_available_units (project_id, category, unit_no, unit_area, floor_no, sort_order)
SELECT project_id, 'commercial', com_unit_no, com_unit_area_available, com_floor_number, 0
  FROM private.projects
 WHERE com_unit_no IS NOT NULL OR com_unit_area_available IS NOT NULL OR com_floor_number IS NOT NULL;

COMMIT;
