-- 042_offers_down.sql
-- Reverses 042.

BEGIN;

DROP TABLE IF EXISTS private.offers;

DELETE FROM private.schema_migrations WHERE migration = '042_offers';

COMMIT;
