-- =============================================================
-- 008_booking_completion_up.sql — Booking completion loop
-- Adds: booking_stage enum, booking-stage columns on payments,
--       receipt_counters (gapless per-year counter, row-lock via
--       ON CONFLICT DO UPDATE in the app), token_receipts
--       (snapshot-frozen, soft-delete, multiple receipts per booking).
-- Additive ONLY. No existing table/column altered destructively or
-- dropped. payment_status enum untouched. Approval engine, cost-sheet,
-- commissions AR untouched. Every existing payments row stays valid
-- (booking_stage defaults to 'pending').
-- =============================================================

BEGIN;

-- 1. Booking lifecycle enum — distinct from payment_status (money state).
--    CREATE TYPE has no IF NOT EXISTS; guard it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'booking_stage' AND n.nspname = 'private'
    ) THEN
        CREATE TYPE private.booking_stage AS ENUM (
            'pending',
            'builder_confirmed',
            'allotted'
        );
    END IF;
END $$;

-- 2. Booking-stage columns on payments (additive; default keeps every
--    existing row valid). stage_updated_by = who last advanced the stage.
ALTER TABLE private.payments
    ADD COLUMN IF NOT EXISTS booking_stage        private.booking_stage NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS builder_confirmed_at timestamp without time zone,
    ADD COLUMN IF NOT EXISTS allotted_at          timestamp without time zone,
    ADD COLUMN IF NOT EXISTS stage_updated_by     uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL;

-- 3. Gapless receipt counter — one row per year. The app increments with
--    INSERT ... ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
--    RETURNING last_seq, which takes a row lock so concurrent requests
--    serialize (strict order, no duplicates). NOT max()+1.
CREATE TABLE IF NOT EXISTS private.receipt_counters (
    year     int PRIMARY KEY,
    last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
);

-- 4. Token receipts — snapshot-frozen money-received records for a booking.
--    receipt_no is human-facing (DHY-RCPT-2026-0001); (seq_year, seq) is the
--    machine-unique pair. snapshot holds lead/property/amount/dates context
--    so a printed receipt is reproducible forever. Soft-delete only.
--    Multiple receipts per payment allowed (staged token payments).
CREATE TABLE IF NOT EXISTS private.token_receipts (
    receipt_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_no  text UNIQUE NOT NULL,                 -- DHY-RCPT-2026-0001
    seq         bigint NOT NULL,
    seq_year    int    NOT NULL,
    payment_id  uuid REFERENCES private.payments(payment_id) ON DELETE SET NULL,
    amount      numeric(14,2) NOT NULL CHECK (amount >= 0),
    method      text,
    snapshot    jsonb NOT NULL,
    pdf_path    text,
    created_by  uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    created_at  timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at  timestamp without time zone,
    UNIQUE (seq_year, seq)
);

CREATE INDEX IF NOT EXISTS idx_token_receipts_payment ON private.token_receipts(payment_id);
CREATE INDEX IF NOT EXISTS idx_token_receipts_created ON private.token_receipts(created_at);

COMMIT;
