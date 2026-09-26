-- 034_expenses_and_counter_series_up.sql
-- FINANCE MODULE (Phase 1) — the general expense ledger + a counter re-key.
--
-- PART A — re-key private.receipt_counters from PK(year) to PK(series, year)
--   so the new EXP- series can never collide with or reset the live
--   DHY-RCPT- receipt sequence. Existing row is backfilled to 'DHY-RCPT'.
--   *** COMPANION CODE CHANGE (ships atomically): routes/admin/receipts.js
--       must switch INSERT ... ON CONFLICT (year) -> ON CONFLICT (series, year)
--       and pass series='DHY-RCPT'. Applying this migration without that
--       edit breaks receipt numbering. ***
--
-- PART B — private.expenses: general company expenses with nullable
--   project/campaign attribution, GST-input fields, FROZEN-approval status
--   (>Rs.50,000 -> pending_approval + approvals ticket; else approved direct),
--   soft-delete. external_id (EXP-<year>-####) draws from ('EXP', year).

BEGIN;

-- ---- PART A: counter re-key ----------------------------------------------
ALTER TABLE private.receipt_counters ADD COLUMN IF NOT EXISTS series text;
UPDATE private.receipt_counters SET series = 'DHY-RCPT' WHERE series IS NULL;
ALTER TABLE private.receipt_counters ALTER COLUMN series SET NOT NULL;
ALTER TABLE private.receipt_counters DROP CONSTRAINT IF EXISTS receipt_counters_pkey;
ALTER TABLE private.receipt_counters ADD CONSTRAINT receipt_counters_pkey
  PRIMARY KEY (series, year);

-- ---- PART B: expenses ledger ---------------------------------------------
CREATE TABLE IF NOT EXISTS private.expenses (
  expense_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id           text UNIQUE,
  expense_date          date NOT NULL,
  category_id           uuid NOT NULL REFERENCES private.expense_categories(category_id),
  amount                numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_to               text,
  payment_mode          text CHECK (payment_mode IS NULL OR payment_mode IN
                          ('cash','bank','upi','cheque','card')),
  project_id            uuid REFERENCES private.projects(project_id),
  campaign_id           uuid REFERENCES private.campaigns(campaign_id),
  notes                 text,
  receipt_reference     text,
  gst_input_amount      numeric(14,2) CHECK (gst_input_amount IS NULL OR gst_input_amount >= 0),
  is_input_gst_eligible boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'approved'
                          CHECK (status IN ('approved','pending_approval','rejected')),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz,
  deleted_at            timestamptz
);

CREATE INDEX IF NOT EXISTS ix_expenses_date_live
  ON private.expenses (expense_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_expenses_category
  ON private.expenses (category_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('034_expenses_and_counter_series',
   'expenses ledger (attribution+GST-input+FROZEN approval) + receipt_counters re-keyed PK(series,year), backfill DHY-RCPT')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
