-- =============================================================
-- 012_daily_reports_up.sql — Evening Reporting discipline layer
-- Adds: daily_reports (one self-report per employee per day). Additive ONLY.
-- No existing table/column altered. Site-visits, approval engine, commissions,
-- receipts all untouched. Calendar + conversion stats need NO schema (they read
-- site_visits.scheduled_at + payments.paid_at).
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS private.daily_reports (
    report_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL REFERENCES private.employees(employee_id) ON DELETE CASCADE,
    report_date    date NOT NULL,
    calls_made     integer NOT NULL DEFAULT 0 CHECK (calls_made     >= 0),
    followups_done integer NOT NULL DEFAULT 0 CHECK (followups_done >= 0),
    visits_done    integer NOT NULL DEFAULT 0 CHECK (visits_done    >= 0),
    new_leads      integer NOT NULL DEFAULT 0 CHECK (new_leads      >= 0),
    notes          text,
    submitted_at   timestamp without time zone,
    created_at     timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     timestamp without time zone,
    deleted_at     timestamp without time zone
);

-- One LIVE report per employee per day (upsert conflict target for same-day edits).
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_reports_emp_date
    ON private.daily_reports (employee_id, report_date) WHERE deleted_at IS NULL;

-- Date-range scans for the admin grid / weekly view.
CREATE INDEX IF NOT EXISTS idx_daily_reports_date
    ON private.daily_reports (report_date);

COMMIT;
