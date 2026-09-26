-- 033_expense_categories_up.sql
-- FINANCE MODULE (Phase 1) — managed category master for company expenses.
-- is_input_gst_eligible flags categories whose expenses can carry input GST
-- (per-expense override lives on expenses.gst_input_amount in 034).
-- Soft-delete via deleted_at; live-name uniqueness via a partial index.
-- Seed is idempotent (WHERE NOT EXISTS by lower(name)). No salary-named
-- category this phase (payroll deferred by standing ruling).

BEGIN;

CREATE TABLE IF NOT EXISTS private.expense_categories (
  category_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  is_input_gst_eligible boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_categories_name_live
  ON private.expense_categories (lower(name)) WHERE deleted_at IS NULL;

INSERT INTO private.expense_categories (name, is_input_gst_eligible, sort_order)
SELECT v.name, v.elig, v.ord
  FROM (VALUES
    ('Rent',                          true,  10),
    ('Utilities',                     true,  20),
    ('Marketing',                     true,  30),
    ('Travel',                        true,  40),
    ('Office Supplies',               true,  50),
    ('Professional Fees',             true,  60),
    ('Contract & Professional Staff', false, 70),
    ('Broker Payout',                 false, 80),
    ('Misc',                          false, 90)
  ) AS v(name, elig, ord)
 WHERE NOT EXISTS (
    SELECT 1 FROM private.expense_categories e
     WHERE lower(e.name) = lower(v.name) AND e.deleted_at IS NULL
 );

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('033_expense_categories', 'expense_categories + 9 seed cats (GST-input flags); soft-delete, live-name unique')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
