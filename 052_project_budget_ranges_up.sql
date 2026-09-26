-- 052_project_budget_ranges_up.sql
-- Budget brackets (Munish): a project-level multi-select price-tag on
-- private.projects. Each project is tagged with one or more price brackets at
-- creation, and the /admin/projects Budget filter matches on THESE tags (not on
-- unit prices) — so a project with no units still filters correctly.
--   * budget_ranges — text[] of bucket keys (nullable)
--     keys: 50-100 / 100-150 / 150-200 / 250-300 / 300plus / other
--     (canonical list: lib/budgetBuckets.js — shared by tag + filter)
-- Additive + nullable + no default → existing rows read NULL (untagged). Form,
-- save, SELECT and read-only display wire via the ext:'array' pattern
-- (dedicated collector + UPDATE), same as property_type.
BEGIN;

ALTER TABLE private.projects
  ADD COLUMN IF NOT EXISTS budget_ranges text[];

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('052_project_budget_ranges', 'projects +budget_ranges (text[], nullable); project-level price-bracket tags, keys shared with /admin/projects budget filter via lib/budgetBuckets.js')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
