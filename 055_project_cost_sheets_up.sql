-- 055_project_cost_sheets_up.sql
-- PROJECT COST SHEETS — internal builder cost-sheet attachments (Excel/PDF).
-- The builder's cost sheet is INTERNAL-ONLY working data (base price, floor-rise,
-- PLC, charges) — never customer-facing. Same off-public security model as
-- client_documents (036): files live on disk OUTSIDE public/ at
-- storage/project-cost-sheets/<project_id>/<random>.<ext>, never statically
-- served, streamed only via a gated route (properties.manage) with
-- Content-Disposition: attachment + X-Content-Type-Options: nosniff.
--   * disk_name  — synthesized on-disk filename (never client input), UNIQUE.
--   * original_name — display only.
--   * mime_type  — CANONICAL, resolved from the file extension at upload
--     (browsers send .xlsx as application/octet-stream or application/zip, so the
--     browser-supplied MIME is never trusted; the extension is the source of truth).
-- Whitelist: xlsx / xls / pdf / csv. Soft-delete via deleted_at (file stays on
-- disk, recoverable). NOT the finance commission "cost sheet" (that is a
-- separate module keyed by finance.costsheet.manage) — this is per-PROJECT.

BEGIN;

CREATE TABLE IF NOT EXISTS private.project_cost_sheets (
  sheet_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES private.projects(project_id),
  original_name   text NOT NULL,
  disk_name       text NOT NULL UNIQUE,
  mime_type       text CHECK (mime_type IS NULL OR mime_type IN (
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'application/vnd.ms-excel',
                    'application/pdf',
                    'text/csv')),
  file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  uploaded_by     uuid,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS ix_project_cost_sheets_project_live
  ON private.project_cost_sheets (project_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('055_project_cost_sheets', 'project_cost_sheets (internal builder cost sheets; off-public storage, gated download properties.manage, xlsx/xls/pdf/csv canonical-mime-from-extension, soft-delete)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
