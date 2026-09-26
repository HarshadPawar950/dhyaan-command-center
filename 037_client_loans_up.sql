-- 037_client_loans_up.sql
-- CUSTOMER MGMT (Phase 2) · Capability B — home-loan progress per client.
-- Multiple rows allowed (one per bank / application). Stage is a text slug with
-- a CHECK (applied -> sanctioned -> disbursed, or rejected). Soft-delete.

BEGIN;

CREATE TABLE IF NOT EXISTS private.client_loans (
  loan_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES private.clients(client_id),
  bank_name         text,
  loan_amount       numeric(14,2) CHECK (loan_amount IS NULL OR loan_amount >= 0),
  sanctioned_amount numeric(14,2) CHECK (sanctioned_amount IS NULL OR sanctioned_amount >= 0),
  stage             text NOT NULL DEFAULT 'applied'
                      CHECK (stage IN ('applied','sanctioned','disbursed','rejected')),
  applied_on        date,
  sanctioned_on     date,
  disbursed_on      date,
  notes             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  deleted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS ix_client_loans_client_live
  ON private.client_loans (client_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('037_client_loans', 'client_loans (bank/amount/sanctioned/stage/dates, multiple per client, soft-delete)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
