-- =====================================================================
-- 002_ops_roles_down.sql  —  Reverse of 002_ops_roles_up.sql
-- Removes the 13 Operations roles. Safe to run repeatedly.
-- (employee_roles rows for these keys, if any, are removed by the FK
--  cascade is NOT automatic here — delete mappings first if assigned.)
-- =====================================================================

BEGIN;

DELETE FROM private.employee_roles WHERE role_key IN (
  'builder_kam','crm_ops_manager','sitevisit_coordinator','event_coordinator',
  'subbroker_manager','booking_crm_executive','marketing_manager','marketing_executive',
  'creative_lead','graphic_designer','finance_accounts','legal','it_admin'
);

DELETE FROM private.roles WHERE role_key IN (
  'builder_kam','crm_ops_manager','sitevisit_coordinator','event_coordinator',
  'subbroker_manager','booking_crm_executive','marketing_manager','marketing_executive',
  'creative_lead','graphic_designer','finance_accounts','legal','it_admin'
);

COMMIT;
