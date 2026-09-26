-- 045_salary_structure_down.sql
BEGIN;
DROP TABLE IF EXISTS private.salary_structure;
DELETE FROM private.schema_migrations WHERE migration = '045_salary_structure';
COMMIT;
