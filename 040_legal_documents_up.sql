-- 040_legal_documents_up.sql
-- PHASE 3 · A — LEGAL VAULT. Polymorphic legal documents attachable to a
-- client, builder, OR project (entity_type + entity_id). No DB-level FK on
-- entity_id (polymorphic) — the route MUST validate the entity exists live in
-- the matching table BEFORE writing any file to disk. Files live off-public in
-- storage/legal-docs/<entity_type>/<entity_id>/<random>.<ext>, gitignored,
-- served only via the gated download route (belongs-to = doc_id+entity_type+
-- entity_id, nosniff + attachment + basename guard). Soft-delete.

BEGIN;

CREATE TABLE IF NOT EXISTS private.legal_documents (
  doc_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL CHECK (entity_type IN ('client','builder','project')),
  entity_id       uuid NOT NULL,                     -- polymorphic; validated in-route
  doc_kind        text NOT NULL DEFAULT 'agreement'
                    CHECK (doc_kind IN ('agreement','mou','rera','noc','kyc')),
  party           text,
  execution_date  date,
  expiry_date     date,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','executed','expired')),
  original_name   text NOT NULL,
  disk_name       text NOT NULL UNIQUE,
  mime_type       text CHECK (mime_type IS NULL OR mime_type IN ('application/pdf','image/jpeg','image/png')),
  file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  notes           text,
  uploaded_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS ix_legal_documents_entity_live
  ON private.legal_documents (entity_type, entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_legal_documents_expiry_live
  ON private.legal_documents (expiry_date) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('040_legal_documents', 'polymorphic legal_documents (client/builder/project), off-public gated storage, expiry-aware')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
