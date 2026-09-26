-- =============================================================
-- 012_daily_reports_down.sql — reverse 012
-- Drops the daily_reports table + its indexes. Nothing else touched.
-- =============================================================

BEGIN;

DROP INDEX IF EXISTS private.idx_daily_reports_date;
DROP INDEX IF EXISTS private.uq_daily_reports_emp_date;
DROP TABLE IF EXISTS private.daily_reports;

COMMIT;
