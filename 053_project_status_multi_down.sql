-- 053_project_status_multi_down.sql
-- Reverse 053: projects.status_of_property text[] → text. Collapses the array to
-- its FIRST element (multi-tagged rows lose the extra tags — unavoidable going
-- back to a scalar). Empty/NULL arrays become NULL.
BEGIN;

ALTER TABLE private.projects
  ALTER COLUMN status_of_property TYPE text
  USING (
    CASE
      WHEN status_of_property IS NULL OR array_length(status_of_property, 1) IS NULL THEN NULL
      ELSE status_of_property[1]
    END
  );

DELETE FROM private.schema_migrations WHERE migration = '053_project_status_multi';

COMMIT;
