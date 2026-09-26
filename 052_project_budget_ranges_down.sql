-- 052_project_budget_ranges_down.sql
-- Reverse 052_up. Drops the additive project-level budget_ranges column.
-- Safe: additive column with no dependents. Any entered tags are lost.
BEGIN;

ALTER TABLE private.projects
  DROP COLUMN IF EXISTS budget_ranges;

DELETE FROM private.schema_migrations WHERE migration = '052_project_budget_ranges';

COMMIT;
