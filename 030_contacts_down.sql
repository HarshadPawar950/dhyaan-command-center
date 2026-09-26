-- 030_contacts_down.sql
-- Reverses 030: drops the Contacts directory table.

BEGIN;

DROP TABLE IF EXISTS private.contacts;

DELETE FROM private.schema_migrations WHERE migration = '030_contacts';

COMMIT;
