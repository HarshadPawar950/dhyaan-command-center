-- =============================================================
-- 024_structured_fields_up.sql — structured form fields.
--  1) property_type: text -> text[] (multi-select). All-null today, so the
--     USING cast is a no-op (NULL stays NULL). Handled like bhk_config now.
--  2) project_area_slabs: repeatable per-category unit-area slabs; smallest/
--     largest_unit_area stay auto-derived from these for compatibility.
-- status_of_property stays TEXT (radio + server validation drive the slug set).
-- Additive/low-risk.
-- =============================================================
BEGIN;

-- 1) Property Type becomes a multi-value array.
ALTER TABLE private.projects
  ALTER COLUMN property_type TYPE text[]
  USING (CASE WHEN property_type IS NULL OR property_type = '' THEN NULL ELSE ARRAY[property_type] END);

-- 2) Area slabs child table.
CREATE TABLE IF NOT EXISTS private.project_area_slabs (
    slab_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES private.projects(project_id) ON DELETE CASCADE,
    category    private.property_category NOT NULL,   -- residential | commercial
    label       text,                                 -- e.g. "2 BHK"
    area_min    numeric,
    area_max    numeric,
    sort_order  int NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_area_slabs_project ON private.project_area_slabs(project_id);

COMMIT;
