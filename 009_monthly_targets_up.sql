-- =============================================================
-- 009_monthly_targets_up.sql — KPI targets layer
-- Adds: monthly_targets (per-employee, per-month sales targets used by
--       the KPI page /admin/kpi + targets editor /admin/kpi/targets).
-- Additive ONLY. No existing table/column altered or dropped. Every
-- existing row in every table stays valid. Approval engine, cost-sheet,
-- commissions AR, receipts/receivables all untouched.
--
-- month is always the first-of-month (CHECK-enforced). One live target
-- row per (employee, month) — enforced by a PARTIAL unique index so a
-- soft-deleted row never blocks a fresh one. That same index is the
-- ON CONFLICT inference target for the editor's bulk upsert.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS private.monthly_targets (
    target_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     uuid NOT NULL REFERENCES private.employees(employee_id) ON DELETE CASCADE,
    month           date NOT NULL,                                   -- always first-of-month
    target_calls    integer       NOT NULL DEFAULT 0 CHECK (target_calls    >= 0),
    target_visits   integer       NOT NULL DEFAULT 0 CHECK (target_visits   >= 0),
    target_bookings integer       NOT NULL DEFAULT 0 CHECK (target_bookings >= 0),
    target_revenue  numeric(14,2) NOT NULL DEFAULT 0 CHECK (target_revenue  >= 0),
    created_by      uuid REFERENCES private.employees(employee_id) ON DELETE SET NULL,
    created_at      timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      timestamp without time zone,
    deleted_at      timestamp without time zone,
    CONSTRAINT monthly_targets_month_is_first
        CHECK (month = date_trunc('month', month)::date)
);

-- Live-uniqueness + upsert conflict target. Partial so soft-deleted rows
-- don't collide. The editor upserts with:
--   INSERT ... ON CONFLICT (employee_id, month) WHERE deleted_at IS NULL DO UPDATE ...
CREATE UNIQUE INDEX IF NOT EXISTS uq_monthly_targets_emp_month
    ON private.monthly_targets (employee_id, month)
    WHERE deleted_at IS NULL;

-- Month-range scans for the KPI page / leaderboard.
CREATE INDEX IF NOT EXISTS idx_monthly_targets_month
    ON private.monthly_targets (month);

COMMIT;
