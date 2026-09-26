-- =============================================================
-- 010_lead_intake_down.sql — reverse 010
-- Drops the SLA config + round-robin pointer tables and the dedup column +
-- index. Nothing else is touched.
-- =============================================================

BEGIN;

DROP TABLE IF EXISTS private.sla_config;
DROP TABLE IF EXISTS private.assignment_pointer;
DROP INDEX IF EXISTS private.idx_leads_normalized_phone;
ALTER TABLE private.leads DROP COLUMN IF EXISTS normalized_phone;

COMMIT;
