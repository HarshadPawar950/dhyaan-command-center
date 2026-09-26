-- 030_contacts_up.sql
-- Super-admin private Contacts directory (Munish's builder/broker rolodex).
-- Full CRUD with soft-delete. NOT gated through the approval engine (not a
-- protected table) — super-admin direct soft-delete, mirroring builders.

BEGIN;

CREATE TABLE IF NOT EXISTS private.contacts (
  contact_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_name   text NOT NULL,
  area           text,
  project_name   text,
  contact_number text,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz            -- soft-delete only
);

CREATE INDEX IF NOT EXISTS idx_contacts_live ON private.contacts (deleted_at)
  WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('030_contacts', 'super-admin Contacts directory (builder/area/project/phone/email, soft-delete)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
