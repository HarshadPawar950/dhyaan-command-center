-- 054_project_budget_other_down.sql
-- Reverse 054_up. Drops the additive project-level budget_other column.
-- Safe: additive column with no dependents. Any entered free text is lost.
BEGIN;

ALTER TABLE private.projects
  DROP COLUMN IF EXISTS budget_other;

DELETE FROM private.schema_migrations WHERE migration = '054_project_budget_other';

COMMIT;
