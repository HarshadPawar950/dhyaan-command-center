-- 038_client_goals_referral_down.sql
-- Reverses 038. Drops the referral columns and the client_goals table.

BEGIN;

ALTER TABLE private.clients
  DROP COLUMN IF EXISTS referred_by_client_id,
  DROP COLUMN IF EXISTS referred_by_name,
  DROP COLUMN IF EXISTS referral_notes;

DROP TABLE IF EXISTS private.client_goals;

DELETE FROM private.schema_migrations WHERE migration = '038_client_goals_referral';

COMMIT;
