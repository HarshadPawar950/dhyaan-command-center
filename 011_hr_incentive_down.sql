-- =============================================================
-- 011_hr_incentive_down.sql — reverse 011
-- Drops the four HR/incentive tables + the two enums. Nothing else touched.
-- =============================================================

BEGIN;

DROP TABLE IF EXISTS private.incentive_entries;
DROP TABLE IF EXISTS private.incentive_slabs;
DROP TABLE IF EXISTS private.leave_requests;
DROP TABLE IF EXISTS private.leave_types;
DROP TYPE  IF EXISTS private.incentive_status;
DROP TYPE  IF EXISTS private.leave_status;

COMMIT;
