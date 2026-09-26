-- =============================================================
-- 009_monthly_targets_down.sql — reverse 009
-- Drops the KPI targets table + its indexes. Nothing else is touched.
-- =============================================================

BEGIN;

DROP INDEX IF EXISTS private.idx_monthly_targets_month;
DROP INDEX IF EXISTS private.uq_monthly_targets_emp_month;
DROP TABLE IF EXISTS private.monthly_targets;

COMMIT;
