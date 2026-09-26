-- 042_offers_up.sql
-- PHASE 3 · C — active promotions per builder AND/OR project. A row may carry
-- BOTH (a builder-wide offer scoped to one project is legitimate) but never
-- neither. Expired offers auto-hide query-side (no cron): active list filters
-- status='active' AND (valid_to IS NULL OR valid_to >= CURRENT_DATE).
-- Surfaces on builder detail + project detail. Soft-delete.

BEGIN;

CREATE TABLE IF NOT EXISTS private.offers (
  offer_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id  uuid REFERENCES private.builders(builder_id),
  project_id  uuid REFERENCES private.projects(project_id),
  offer_text  text NOT NULL,
  valid_from  date,
  valid_to    date,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT offers_scope_ck CHECK (builder_id IS NOT NULL OR project_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_offers_builder_live ON private.offers (builder_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_offers_project_live ON private.offers (project_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('042_offers', 'offers (builder and/or project, scope CHECK, expired auto-hide query-side)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
