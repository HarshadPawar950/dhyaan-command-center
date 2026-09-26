-- 031_contacts_extend_down.sql
-- Reverses 031: drops the 4 added contact columns and the ledger row.

BEGIN;

ALTER TABLE private.contacts
  DROP COLUMN IF EXISTS designation,
  DROP COLUMN IF EXISTS alt_phone,
  DROP COLUMN IF EXISTS alt_contact_name,
  DROP COLUMN IF EXISTS alt_contact_phone;

DELETE FROM private.schema_migrations WHERE migration = '031_contacts_extend';

COMMIT;
