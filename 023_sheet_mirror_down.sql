-- =============================================================
-- 023_sheet_mirror_down.sql — inverse of 023 up. Drops the 14 added columns.
-- Legacy shared payment_plan/documents_received/rera_number are untouched (021/019).
-- =============================================================
BEGIN;

ALTER TABLE private.projects
  DROP COLUMN IF EXISTS res_unit_no,             DROP COLUMN IF EXISTS com_unit_no,
  DROP COLUMN IF EXISTS res_unit_area_available, DROP COLUMN IF EXISTS com_unit_area_available,
  DROP COLUMN IF EXISTS res_floor_number,        DROP COLUMN IF EXISTS com_floor_number,
  DROP COLUMN IF EXISTS com_vastu,
  DROP COLUMN IF EXISTS res_payment_plan,        DROP COLUMN IF EXISTS com_payment_plan,
  DROP COLUMN IF EXISTS res_documents_received,  DROP COLUMN IF EXISTS com_documents_received,
  DROP COLUMN IF EXISTS res_rera_number,         DROP COLUMN IF EXISTS com_rera_number,
  DROP COLUMN IF EXISTS breakdown;

COMMIT;
