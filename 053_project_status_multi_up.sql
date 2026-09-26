-- 053_project_status_multi_up.sql
-- Status of Property → MULTISELECT. Converts private.projects.status_of_property
-- from a single text slug to a text[] of status tags, exactly the ext:'array'
-- pattern used for property_type (024) and budget_ranges (052).
--   keys: pre_launch / under_construction / near_possession / ready_to_move
--         (canonical list: lib/projectSheet.js STATUS_OPTIONS — shared by the
--          form, the read-only display and the /admin/projects Status filter)
--
-- IN-PLACE conversion (not a parallel column): a second column would drift out of
-- sync with the form exactly the way the vestigial construction_status enum did
-- (that drift was the root cause of the "picks Under Construction, shows Pre
-- Launch" bug). One column = one source of truth. Existing single slugs are
-- preserved by wrapping into a 1-element array; blank/NULL become NULL (untagged).
--
-- NB: private.properties (the SINGULAR sheet) has its OWN status_of_property text
-- column — a DIFFERENT table, untouched by this migration.
--
-- The /admin/projects Status filter switches = ANY($1) → array overlap (&&),
-- same as the budget filter, so the tag you set and the filter you match on stay
-- in lockstep.
BEGIN;

ALTER TABLE private.projects
  ALTER COLUMN status_of_property TYPE text[]
  USING (
    CASE
      WHEN status_of_property IS NULL OR btrim(status_of_property) = '' THEN NULL
      ELSE ARRAY[status_of_property]
    END
  );

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('053_project_status_multi', 'projects.status_of_property text→text[] (multi-select status tags); /admin/projects Status filter = ANY → && array overlap, same pattern as budget_ranges (052); card badge repointed off legacy construction_status enum')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
