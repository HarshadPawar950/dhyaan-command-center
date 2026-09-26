-- 043_possession_up.sql
-- PHASE 3 · D — possession stage on the BOOKING (private.payments), per ruling
-- §4. Possession belongs to the deal, not the client (one client can hold many
-- bookings). Nullable/default NULL (only set after allotment). CHECK bounds the
-- status; the "completed -> possession_date NOT NULL" rule is enforced IN-ROUTE
-- (not a DB constraint — historical rows may lack a date).

BEGIN;

ALTER TABLE private.payments
  ADD COLUMN IF NOT EXISTS possession_date   date,
  ADD COLUMN IF NOT EXISTS possession_status text
    CHECK (possession_status IS NULL OR possession_status IN ('pending','offered','completed'));

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('043_possession', 'payments +possession_date +possession_status{pending,offered,completed} (per-booking; completed-needs-date enforced in route)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
