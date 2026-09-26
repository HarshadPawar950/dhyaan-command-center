-- 054_project_budget_other_up.sql
-- Budget "Other" free-text (Munish). When a project is tagged with the 'other'
-- budget bucket (052 budget_ranges), the fixed brackets don't fit — so let the
-- user type the actual figure ("45L – 55L", "On request"). This is a companion
-- to budget_ranges, NOT a filter key: the /admin/projects Budget filter stays
-- tag-based (array overlap on budget_ranges) and never looks at this free text.
--   * budget_other — text (nullable)
-- Additive + nullable + no default → existing rows read NULL. It is CLEARED to
-- NULL by the save routes whenever the 'other' tag is not ticked, so it can
-- never orphan a value behind a missing chip.
BEGIN;

ALTER TABLE private.projects
  ADD COLUMN IF NOT EXISTS budget_other text;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('054_project_budget_other', 'projects +budget_other (text, nullable); free-text companion to the budget_ranges ''other'' tag; cleared to NULL when Other unticked; /admin/projects Budget filter stays tag-based and ignores it')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
