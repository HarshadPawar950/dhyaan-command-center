-- 029_lead_profile_v2_down.sql
-- Reverses 029: drops the 9 v2 CP columns. cp_urgency_note (mig 027) is left intact.

BEGIN;

ALTER TABLE private.leads
  DROP COLUMN IF EXISTS cp_layout_pref,
  DROP COLUMN IF EXISTS cp_occupation,
  DROP COLUMN IF EXISTS cp_amenities_pref,
  DROP COLUMN IF EXISTS cp_community_pref,
  DROP COLUMN IF EXISTS cp_floor_pref,
  DROP COLUMN IF EXISTS cp_purchase_timeline,
  DROP COLUMN IF EXISTS cp_projects_visited,
  DROP COLUMN IF EXISTS cp_current_residence,
  DROP COLUMN IF EXISTS cp_budget_other;

DELETE FROM private.schema_migrations WHERE migration = '029_lead_profile_v2';

COMMIT;
