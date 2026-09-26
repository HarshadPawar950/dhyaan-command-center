-- =============================================================
-- 006_commission_receivables_up.sql — Commission Receivable lifecycle
-- Adds: commission_recv_status enum,
--       commission_receivables (builder-owed AR, one per earned commission),
--       commission_receipts (append-only partial payments).
-- Migrates every existing commission_ledger row -> a receivable at
-- status 'accrued', accrued_at = the ledger row's earned_at,
-- expected_amount = the ledger row's commission_amount.
-- No existing table/column altered or dropped. Approval engine untouched.
-- Cost-sheet module untouched. Soft-delete (deleted_at) on both new tables.
-- =============================================================

BEGIN;

-- 1. Receivable lifecycle enum (idempotent guard — CREATE TYPE has no IF NOT EXISTS).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'commission_recv_status' AND n.nspname = 'private'
    ) THEN
        CREATE TYPE private.commission_recv_status AS ENUM (
            'accrued',
            'builder_confirmed',
            'invoice_raised',
            'partially_received',
            'fully_received'
        );
    END IF;
END $$;

-- 2. Receivables — the money a builder owes us for an earned commission.
--    received total is ALWAYS SUM(receipts); never stored here.
--    outstanding = expected_amount - (SUM(receipts) + tds_deducted).
CREATE TABLE IF NOT EXISTS private.commission_receivables (
    receivable_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id     text UNIQUE,
    commission_id   uuid REFERENCES private.commission_ledger(commission_id) ON DELETE SET NULL,
    booking_ref     text,                                  -- = payments.external_id (BKG-...)
    builder_id      uuid REFERENCES private.builders(builder_id),
    status          private.commission_recv_status NOT NULL DEFAULT 'accrued',
    expected_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (expected_amount >= 0),  -- base commission, no tax
    invoice_number  text,
    invoice_date    date,
    tds_deducted    numeric(14,2) NOT NULL DEFAULT 0 CHECK (tds_deducted   >= 0),   -- counts as received (Q1)
    gst_on_invoice  numeric(14,2) NOT NULL DEFAULT 0 CHECK (gst_on_invoice >= 0),   -- info only (Q2)
    accrued_at      timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP, -- ageing clock
    notes           text,
    created_by      uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    created_at      timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at      timestamp without time zone
);

-- one live receivable per earned commission (idempotency for the atomic
-- commission+receivable create in the booking flow).
CREATE UNIQUE INDEX IF NOT EXISTS uq_recv_commission_live
    ON private.commission_receivables(commission_id)
    WHERE commission_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recv_builder  ON private.commission_receivables(builder_id);
CREATE INDEX IF NOT EXISTS idx_recv_status   ON private.commission_receivables(status);
CREATE INDEX IF NOT EXISTS idx_recv_accrued  ON private.commission_receivables(accrued_at);
CREATE INDEX IF NOT EXISTS idx_recv_booking  ON private.commission_receivables(booking_ref);

-- 3. Receipts — append-only partial payments against a receivable.
--    Soft-delete only, and only with a logged reason (enforced in app).
CREATE TABLE IF NOT EXISTS private.commission_receipts (
    receipt_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receivable_id   uuid NOT NULL REFERENCES private.commission_receivables(receivable_id),
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    received_on     date NOT NULL DEFAULT CURRENT_DATE,
    mode            text,                                  -- cheque / neft / rtgs / cash / upi ...
    reference       text,                                  -- UTR / cheque no.
    notes           text,
    created_by      uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    created_at      timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at      timestamp without time zone
);

CREATE INDEX IF NOT EXISTS idx_receipts_receivable ON private.commission_receipts(receivable_id);

-- 4. Migrate existing ledger row(s) -> receivable at 'accrued'.
--    Builder resolved via the booking's property. Idempotent (WHERE NOT EXISTS).
INSERT INTO private.commission_receivables
    (external_id, commission_id, booking_ref, builder_id, status, expected_amount, accrued_at, notes)
SELECT
    'RCV-' || COALESCE(NULLIF(regexp_replace(cl.external_id, '^COM-', ''), ''),
                       substr(cl.commission_id::text, 1, 8)),
    cl.commission_id,
    cl.deal_id,
    (SELECT pr.builder_id
       FROM private.payments pay
       JOIN private.properties pr ON pr.property_id = pay.property_id
      WHERE pay.external_id = cl.deal_id
      ORDER BY pay.paid_at DESC
      LIMIT 1),
    'accrued',
    cl.commission_amount,
    cl.earned_at,
    'Migrated from commission_ledger by migration 006'
FROM private.commission_ledger cl
WHERE NOT EXISTS (
    SELECT 1 FROM private.commission_receivables r
     WHERE r.commission_id = cl.commission_id AND r.deleted_at IS NULL
);

COMMIT;
