-- 058_project_property_type_other_up.sql
-- Property Type "Other" free-text (Munish). Group 2 property_type is a flat text[]
-- of canonical BHK/type tags, rendered per-category (res + com sub-sets). When a
-- project needs a type outside the fixed options ("Row House", "Duplex",
-- "Shop-cum-office"), let the user type it — ONE field PER CATEGORY so a mixed-use
-- project can name a residential-Other and a commercial-Other independently.
-- Companion columns to the per-side "Other" checkbox; a mirror of budget_other (054):
-- the free text NEVER enters property_type[], so the AI matcher / filters / cost
-- sheets (none of which read these) stay provably unaffected. The save routes CLEAR
-- each column to NULL when that side's Other is unticked, so it can't orphan.
--   * property_type_other_res — text (nullable)
--   * property_type_other_com — text (nullable)
-- Additive + nullable + no default → existing rows read NULL.
BEGIN;

ALTER TABLE private.projects
  ADD COLUMN IF NOT EXISTS property_type_other_res text,
  ADD COLUMN IF NOT EXISTS property_type_other_com text;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('058_project_property_type_other', 'projects +property_type_other_res +property_type_other_com (text, nullable); per-category free-text companion to the Group 2 property_type ''Other'' checkbox; cleared to NULL when that side''s Other unticked; free text never enters property_type[]; matcher/filters/cost-sheets do not read it')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
