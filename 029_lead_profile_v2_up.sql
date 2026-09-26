-- 029_lead_profile_v2_up.sql
-- Lead Client Profile v2: adds structured profile fields (all optional except
-- urgency, which is enforced in the route layer) + a custom-budget free field.
-- Additive + idempotent. cp_urgency_note already exists (mig 027) — not touched here.

BEGIN;

ALTER TABLE private.leads
  ADD COLUMN IF NOT EXISTS cp_layout_pref       text,    -- standalone | township
  ADD COLUMN IF NOT EXISTS cp_occupation        text,    -- business | salaried | retired
  ADD COLUMN IF NOT EXISTS cp_amenities_pref    text,    -- with_amenities | without
  ADD COLUMN IF NOT EXISTS cp_community_pref    text,    -- gated | cosmos
  ADD COLUMN IF NOT EXISTS cp_floor_pref        text[],  -- lower | mid | higher (multi)
  ADD COLUMN IF NOT EXISTS cp_purchase_timeline text,    -- immediate | 1_3m | 3_6m | 6plus
  ADD COLUMN IF NOT EXISTS cp_projects_visited  text,    -- free text: projects already seen
  ADD COLUMN IF NOT EXISTS cp_current_residence text,    -- free text: where they live now
  ADD COLUMN IF NOT EXISTS cp_budget_other      text;    -- custom budget when cp_budget_tag='other'

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('029_lead_profile_v2', 'lead CP v2: +9 cp_ cols (layout/occupation/amenities_pref/community/floor/timeline/projects_visited/current_residence/budget_other)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
