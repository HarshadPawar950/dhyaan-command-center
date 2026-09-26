-- 050_leave_types_expand_up.sql
-- HR leave types: half-day support + Sick rename + Paid Leave/Half Day seed.
--   * leave_types.day_fraction (1.0 = full-day type, 0.5 = half-day type)
--   * leave_requests.days: integer -> numeric(4,1) so a half day stores 0.5
--   * rename existing 'Sick' -> 'Sick Leave' (quota preserved)
--   * seed 'Paid Leave' (full) + 'Half Day' (0.5), idempotent
-- A Half Day consumes 0.5 of its bucket; all other types consume whole days.
--
-- >>> QUOTAS BELOW ARE PLACEHOLDERS pending HR confirmation. <<<
--     They are annual quotas IN DAYS. To change either quota LATER WITHOUT
--     a new migration, run one line (example sets Paid Leave to 15):
--
--       UPDATE private.leave_types SET annual_quota = 15
--        WHERE lower(name) = 'paid leave' AND deleted_at IS NULL;
--
--     (swap 'paid leave' -> 'half day' and the number as needed).
BEGIN;

-- 1) day_fraction: how much of a day one request of this type consumes.
ALTER TABLE private.leave_types
  ADD COLUMN IF NOT EXISTS day_fraction numeric(2,1) NOT NULL DEFAULT 1.0;

-- Domain guard (0.5 or 1.0), added once so a re-run does not duplicate it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_types_day_fraction_chk') THEN
    ALTER TABLE private.leave_types
      ADD CONSTRAINT leave_types_day_fraction_chk CHECK (day_fraction IN (0.5, 1.0));
  END IF;
END $$;

-- 2) days must hold 0.5. numeric(4,1) is a widening change; existing whole
--    integers (e.g. 3) become 3.0 — same value, no row is altered in meaning.
ALTER TABLE private.leave_requests ALTER COLUMN days TYPE numeric(4,1);

-- 3) 'Sick' -> 'Sick Leave' (quota untouched).
UPDATE private.leave_types SET name = 'Sick Leave'
 WHERE lower(name) = 'sick' AND deleted_at IS NULL;

-- 4) Seed the two new types. Quotas are PLACEHOLDERS (see header). Idempotent.
INSERT INTO private.leave_types (name, annual_quota, day_fraction)
SELECT v.name, v.quota, v.frac
  FROM (VALUES
    ('Paid Leave', 12, 1.0),   -- PLACEHOLDER quota — confirm with HR
    ('Half Day',   12, 0.5)    -- PLACEHOLDER quota — confirm with HR
  ) AS v(name, quota, frac)
 WHERE NOT EXISTS (SELECT 1 FROM private.leave_types lt
                    WHERE lower(lt.name) = lower(v.name) AND lt.deleted_at IS NULL);

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('050_leave_types_expand', 'day_fraction + days->numeric(4,1); Sick->Sick Leave; +Paid Leave +Half Day(0.5); quotas placeholder pending HR')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
