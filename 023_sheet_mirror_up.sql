-- =============================================================
-- 023_sheet_mirror_up.sql — LINE-BY-LINE sheet fidelity.
-- Adds the 14 columns the Dhyaan workbook needs that 021/022 didn't cover.
-- Groups 3 & 4 are fully per-category (res_/com_); Breakdown (G6) gets its own
-- column. ALL additive, nullable, no backfill (the 1 real project is
-- uncategorized). Legacy shared payment_plan/documents_received/rera_number are
-- kept (rera still feeds the 019 hero) — the sheet just reads the res_/com_ set.
-- =============================================================
BEGIN;

ALTER TABLE private.projects
  -- G3 Unit Configuration & Availability (per-category)
  ADD COLUMN IF NOT EXISTS res_unit_no               text,
  ADD COLUMN IF NOT EXISTS com_unit_no               text,
  ADD COLUMN IF NOT EXISTS res_unit_area_available   text,
  ADD COLUMN IF NOT EXISTS com_unit_area_available   text,
  ADD COLUMN IF NOT EXISTS res_floor_number          text,
  ADD COLUMN IF NOT EXISTS com_floor_number          text,
  ADD COLUMN IF NOT EXISTS com_vastu                 text,   -- res_vastu already exists (022)
  -- G4 Pricing, ROI & Legal (per-category)
  ADD COLUMN IF NOT EXISTS res_payment_plan          text,
  ADD COLUMN IF NOT EXISTS com_payment_plan          text,
  ADD COLUMN IF NOT EXISTS res_documents_received    text,
  ADD COLUMN IF NOT EXISTS com_documents_received    text,
  ADD COLUMN IF NOT EXISTS res_rera_number           text,
  ADD COLUMN IF NOT EXISTS com_rera_number           text,
  -- G6 Connectivity & Marketing Insights (shared)
  ADD COLUMN IF NOT EXISTS breakdown                 text;

COMMIT;
