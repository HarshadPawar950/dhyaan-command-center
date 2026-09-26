-- 032_contacts_person_name_up.sql
-- Adds the PRIMARY contact person's name to the super-admin Contacts directory,
-- mirroring what alt_contact_name (031) is for the alternate point-of-contact.
-- contact_person_name = the human you actually speak to at the builder/broker.
-- Nullable — existing rows stay valid, no backfill needed. Additive only;
-- mirrors the text-column convention of 030/031.

BEGIN;

ALTER TABLE private.contacts
  ADD COLUMN IF NOT EXISTS contact_person_name text;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('032_contacts_person_name', 'contacts +contact_person_name (primary person identity, nullable, additive)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
