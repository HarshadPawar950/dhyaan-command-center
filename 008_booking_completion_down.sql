-- =============================================================
-- 008_booking_completion_down.sql — reverse 008.
-- Drops token_receipts, receipt_counters, the booking-stage columns on
-- payments, and the booking_stage enum. All IF EXISTS / guarded so it is
-- safe to run even on a partially-applied migration. payment_status and
-- every other table are untouched.
-- WARNING: dropping token_receipts destroys issued receipt records.
-- =============================================================

BEGIN;

DROP TABLE IF EXISTS private.token_receipts;
DROP TABLE IF EXISTS private.receipt_counters;

ALTER TABLE private.payments
    DROP COLUMN IF EXISTS stage_updated_by,
    DROP COLUMN IF EXISTS allotted_at,
    DROP COLUMN IF EXISTS builder_confirmed_at,
    DROP COLUMN IF EXISTS booking_stage;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'booking_stage' AND n.nspname = 'private'
    ) THEN
        DROP TYPE private.booking_stage;
    END IF;
END $$;

COMMIT;
