-- 050_leave_types_expand_down.sql
-- Reverse 050_up. CAUTION: restoring integer `days` ROUNDS any 0.5 rows to the
-- nearest whole day — only truly clean if no half-day request exists yet.
BEGIN;

-- Drop the two seeded types only if no request references them.
DELETE FROM private.leave_types lt
 WHERE lower(lt.name) IN ('paid leave', 'half day')
   AND NOT EXISTS (SELECT 1 FROM private.leave_requests lr WHERE lr.leave_type_id = lt.leave_type_id);

-- Rename back.
UPDATE private.leave_types SET name = 'Sick'
 WHERE lower(name) = 'sick leave' AND deleted_at IS NULL;

-- days back to integer (rounds fractions — see caution above).
ALTER TABLE private.leave_requests ALTER COLUMN days TYPE integer USING ROUND(days)::int;

ALTER TABLE private.leave_types DROP CONSTRAINT IF EXISTS leave_types_day_fraction_chk;
ALTER TABLE private.leave_types DROP COLUMN IF EXISTS day_fraction;

DELETE FROM private.schema_migrations WHERE migration = '050_leave_types_expand';

COMMIT;
