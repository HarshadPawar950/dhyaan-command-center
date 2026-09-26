-- 038_client_goals_referral_up.sql
-- CUSTOMER MGMT (Phase 2) · Capability C + D.
--
-- C. client_goals — the STRUCTURED SUCCESSOR to the legacy free-text columns
--    (clients.budget/preferences/investment_profile/requirement). 1:1 per client
--    (partial-unique on live rows). Legacy columns are NOT touched or migrated —
--    they stay as read-only "From lead" display; promote-from-lead still fills them.
--
-- D. Referral linkage on clients — self-FK referrer + free-text fallback. The
--    existing "referral" concept is only a leads.source enum value; this ADDS the
--    who-referred-whom link. "Clients they referred" = reverse query on the self-FK.

BEGIN;

CREATE TABLE IF NOT EXISTS private.client_goals (
  goal_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES private.clients(client_id),
  budget_min          numeric(14,2) CHECK (budget_min IS NULL OR budget_min >= 0),
  budget_max          numeric(14,2) CHECK (budget_max IS NULL OR budget_max >= 0),
  property_type       text[],
  preferred_locations text,
  timeline            text,
  purpose             text CHECK (purpose IS NULL OR purpose IN ('end_use','investment')),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  deleted_at          timestamptz
);

-- 1:1 among live rows (a soft-deleted goal set doesn't block a fresh one).
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_goals_client_live
  ON private.client_goals (client_id) WHERE deleted_at IS NULL;

ALTER TABLE private.clients
  ADD COLUMN IF NOT EXISTS referred_by_client_id uuid REFERENCES private.clients(client_id),
  ADD COLUMN IF NOT EXISTS referred_by_name      text,
  ADD COLUMN IF NOT EXISTS referral_notes        text;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('038_client_goals_referral', 'client_goals (1:1 structured successor) + clients referral self-FK/name/notes')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
