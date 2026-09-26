-- =============================================================
-- 014_team_layer_down.sql — reverse 014 (manager mapping)
-- Drops the reports_to column, its self-reference CHECK, and its index.
-- Safe to run repeatedly (IF EXISTS guards). Any reports_to values are lost
-- on drop — this is the intended reversal of an additive column.
-- =============================================================

BEGIN;

ALTER TABLE private.employees DROP CONSTRAINT IF EXISTS employees_reports_to_not_self;
DROP INDEX IF EXISTS private.idx_employees_reports_to;
ALTER TABLE private.employees DROP COLUMN IF EXISTS reports_to;

COMMIT;
