-- =============================================================
-- 015_match_log_down.sql — reverse 015 (property-matcher run log)
-- Drops the match_log table and its two indexes. Safe to run repeatedly
-- (IF EXISTS guards). Logged match runs are lost on drop — this is the
-- intended reversal of an additive, side-effect-only table.
-- =============================================================

BEGIN;

DROP INDEX IF EXISTS private.idx_match_log_run_at;
DROP INDEX IF EXISTS private.idx_match_log_lead;
DROP TABLE IF EXISTS private.match_log;

COMMIT;
