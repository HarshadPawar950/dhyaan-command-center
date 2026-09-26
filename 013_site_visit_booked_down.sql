-- =============================================================
-- 013_site_visit_booked_down.sql — reverse 013 (best-effort)
-- PostgreSQL cannot DROP a single enum value. Removing 'booked' requires
-- recreating the type WITHOUT it and re-pointing every dependent column —
-- and is only safe when NO row uses 'booked'. This down script performs that
-- recreation, guarded: it ABORTS if any site_visits row is still 'booked'.
-- =============================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM private.site_visits WHERE status = 'booked') THEN
        RAISE EXCEPTION 'Cannot remove enum value ''booked'': % row(s) still use it — reclassify them first',
            (SELECT COUNT(*) FROM private.site_visits WHERE status = 'booked');
    END IF;
END $$;

ALTER TYPE private.site_visit_status RENAME TO site_visit_status_old;
CREATE TYPE private.site_visit_status AS ENUM ('scheduled','confirmed','completed','no_show','cancelled');
ALTER TABLE private.site_visits
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN status TYPE private.site_visit_status USING status::text::private.site_visit_status,
    ALTER COLUMN status SET DEFAULT 'scheduled';
DROP TYPE private.site_visit_status_old;

COMMIT;
