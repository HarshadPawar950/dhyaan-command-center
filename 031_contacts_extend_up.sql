-- 031_contacts_extend_up.sql
-- Extends the super-admin Contacts directory (030) with 4 optional fields:
-- designation (contact's job title), alt_phone (alternative number), and an
-- alternative point-of-contact (alt_contact_name = person, alt_contact_phone =
-- their number). All nullable — existing rows stay valid, no backfill needed.
-- Additive only; mirrors the text-column convention of 030_contacts.

BEGIN;

ALTER TABLE private.contacts
  ADD COLUMN IF NOT EXISTS designation       text,
  ADD COLUMN IF NOT EXISTS alt_phone         text,
  ADD COLUMN IF NOT EXISTS alt_contact_name  text,
  ADD COLUMN IF NOT EXISTS alt_contact_phone text;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('031_contacts_extend', 'contacts +designation +alt_phone +alt_contact_name +alt_contact_phone (all nullable, additive)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
