-- =============================================================
-- 011_hr_incentive_up.sql — HR Core + Incentive Engine
-- Adds: leave_status + incentive_status enums; leave_types, leave_requests,
--       incentive_slabs, incentive_entries. Seeds leave types + slabs.
-- Additive ONLY. No existing table/column altered or dropped. commission_ledger,
-- commission_receivables, receipts, approval engine, cost-sheet all untouched.
-- The auto-accrual / payable-promotion logic lives in the app transactions
-- (bookings Slice 5 + receipt-math), NOT in this migration.
-- =============================================================

BEGIN;

-- Enums (CREATE TYPE has no IF NOT EXISTS — guard).
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                    WHERE t.typname='leave_status' AND n.nspname='private') THEN
        CREATE TYPE private.leave_status AS ENUM ('pending','approved','rejected');
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                    WHERE t.typname='incentive_status' AND n.nspname='private') THEN
        CREATE TYPE private.incentive_status AS ENUM ('accrued','payable','paid');
    END IF;
END $$;

-- a) leave_types --------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.leave_types (
    leave_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    annual_quota  integer NOT NULL DEFAULT 0 CHECK (annual_quota >= 0),
    created_at    timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    timestamp without time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_types_name
    ON private.leave_types (lower(name)) WHERE deleted_at IS NULL;

-- b) leave_requests -----------------------------------------------------
CREATE TABLE IF NOT EXISTS private.leave_requests (
    request_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES private.employees(employee_id) ON DELETE CASCADE,
    leave_type_id uuid NOT NULL REFERENCES private.leave_types(leave_type_id),
    from_date     date NOT NULL,
    to_date       date NOT NULL,
    days          integer NOT NULL CHECK (days > 0),
    reason        text,
    status        private.leave_status NOT NULL DEFAULT 'pending',
    decided_by    uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    decided_at    timestamp without time zone,
    created_at    timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    timestamp without time zone,
    CONSTRAINT leave_dates_ok CHECK (to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_emp
    ON private.leave_requests (employee_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leave_requests_status
    ON private.leave_requests (status) WHERE deleted_at IS NULL;

-- c) incentive_slabs (bands on employee_share) --------------------------
CREATE TABLE IF NOT EXISTS private.incentive_slabs (
    slab_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    min_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
    max_amount   numeric(14,2),                              -- NULL = open top
    rate_percent numeric(5,2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   timestamp without time zone,
    CONSTRAINT slab_range_ok CHECK (max_amount IS NULL OR max_amount > min_amount)
);

-- d) incentive_entries (1:1 with a commission, live-unique) -------------
CREATE TABLE IF NOT EXISTS private.incentive_entries (
    entry_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id      uuid NOT NULL REFERENCES private.employees(employee_id) ON DELETE CASCADE,
    commission_id    uuid NOT NULL REFERENCES private.commission_ledger(commission_id) ON DELETE CASCADE,
    base_amount      numeric(14,2) NOT NULL,                 -- employee_share snapshot
    slab_rate        numeric(5,2) NOT NULL,
    incentive_amount numeric(14,2) NOT NULL,
    status           private.incentive_status NOT NULL DEFAULT 'accrued',
    payable_at       timestamp without time zone,
    paid_at          timestamp without time zone,
    paid_by          uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    notes            text,
    created_at       timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at       timestamp without time zone
);
-- 1:1 with the commission + the ON CONFLICT inference target for auto-accrual.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_commission_live
    ON private.incentive_entries (commission_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incentive_entries_emp
    ON private.incentive_entries (employee_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incentive_entries_status
    ON private.incentive_entries (status) WHERE deleted_at IS NULL;

-- Seeds (approved at GATE #1) -------------------------------------------
INSERT INTO private.leave_types (name, annual_quota)
SELECT v.name, v.q FROM (VALUES ('Casual',12),('Sick',8),('Earned',15)) AS v(name,q)
WHERE NOT EXISTS (SELECT 1 FROM private.leave_types lt
                   WHERE lower(lt.name)=lower(v.name) AND lt.deleted_at IS NULL);

INSERT INTO private.incentive_slabs (min_amount, max_amount, rate_percent)
SELECT v.mn, v.mx, v.r FROM (VALUES
        (0::numeric, 50000::numeric, 2.00::numeric),
        (50000::numeric, 200000::numeric, 3.00::numeric),
        (200000::numeric, NULL::numeric, 5.00::numeric)) AS v(mn,mx,r)
WHERE NOT EXISTS (SELECT 1 FROM private.incentive_slabs s WHERE s.deleted_at IS NULL);

COMMIT;
