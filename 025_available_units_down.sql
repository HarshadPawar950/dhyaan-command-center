-- =============================================================
-- 025_available_units_down.sql — inverse of 025 up.
-- Drops the available-units table; recreates the 024 slab table (structure only).
-- =============================================================
BEGIN;

DROP TABLE IF EXISTS private.project_available_units;

CREATE TABLE IF NOT EXISTS private.project_area_slabs (
    slab_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES private.projects(project_id) ON DELETE CASCADE,
    category    private.property_category NOT NULL,
    label       text,
    area_min    numeric,
    area_max    numeric,
    sort_order  int NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_area_slabs_project ON private.project_area_slabs(project_id);

COMMIT;
