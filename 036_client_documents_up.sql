-- 036_client_documents_up.sql
-- CUSTOMER MGMT (Phase 2) · Capability A — client document attachments.
-- Files live on disk OUTSIDE public/ (storage/client-docs/<client_id>/<random>.<ext>),
-- never statically served; served only via a gated streaming route. disk_name is
-- the synthesized on-disk filename (never client input); original_name is display.
-- Whitelist: pdf/jpg/png. Soft-delete via deleted_at (file stays on disk, recoverable).

BEGIN;

CREATE TABLE IF NOT EXISTS private.client_documents (
  doc_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES private.clients(client_id),
  doc_type        text NOT NULL DEFAULT 'other' CHECK (doc_type IN ('kyc','agreement','loan','other')),
  original_name   text NOT NULL,
  disk_name       text NOT NULL UNIQUE,
  mime_type       text CHECK (mime_type IS NULL OR mime_type IN ('application/pdf','image/jpeg','image/png')),
  file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  uploaded_by     uuid,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS ix_client_documents_client_live
  ON private.client_documents (client_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('036_client_documents', 'client_documents (off-public storage, gated download, pdf/jpg/png, soft-delete)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
