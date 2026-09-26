-- =============================================================
-- 006_commission_receivables_down.sql — rollback for 006 up
-- WARNING: drops commission_receipts and commission_receivables
-- (and all receipt/receivable rows, including the migrated ones) plus
-- the commission_recv_status enum. commission_ledger is NOT touched —
-- the real ₹1.5L row (COM-MPY17IER) lives in commission_ledger and
-- survives this rollback untouched. Only run to remove the whole feature.
-- =============================================================

BEGIN;

DROP TABLE IF EXISTS private.commission_receipts;
DROP TABLE IF EXISTS private.commission_receivables;
DROP TYPE  IF EXISTS private.commission_recv_status;

COMMIT;
