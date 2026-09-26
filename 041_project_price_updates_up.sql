-- 041_project_price_updates_up.sql
-- PHASE 3 · B — dated price revisions per PROJECT. Read surface on the project
-- detail view (current = latest effective_date; history below). Additive;
-- complements projects.price/price_range (not replaced). Soft-delete.

BEGIN;

CREATE TABLE IF NOT EXISTS private.project_price_updates (
  price_update_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES private.projects(project_id),
  effective_date  date NOT NULL,
  price_note      text,                 -- per-sqft figure or free-form note
  source          text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS ix_price_updates_project_live
  ON private.project_price_updates (project_id, effective_date DESC) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('041_project_price_updates', 'project_price_updates (dated revisions per project, read on project detail)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
