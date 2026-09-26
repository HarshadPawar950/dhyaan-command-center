-- 032_contacts_person_name_down.sql
-- Reverses 032: drops the added column and the ledger row.

BEGIN;

ALTER TABLE private.contacts
  DROP COLUMN IF EXISTS contact_person_name;

DELETE FROM private.schema_migrations WHERE migration = '032_contacts_person_name';

COMMIT;
