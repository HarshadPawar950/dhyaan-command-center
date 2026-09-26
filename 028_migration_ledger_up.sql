-- 028_migration_ledger_up.sql
-- Adds a DB-side migration ledger so "which migrations are applied" is tracked
-- in the database itself, not inferred from schema columns. Backfills 001-027
-- (confirmed applied by schema state on 2026-07-28) and records 028 itself.

BEGIN;

CREATE TABLE IF NOT EXISTS private.schema_migrations (
  migration   text        PRIMARY KEY,           -- e.g. '027_property_leads_upgrade'
  applied_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

-- Backfill 001-027. These predate the ledger; applied-state was confirmed by
-- live schema inspection on 2026-07-28. ON CONFLICT keeps this idempotent.
INSERT INTO private.schema_migrations (migration, note) VALUES
  ('001_roles',                 'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('002_ops_roles',             'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('003_hr_roles',              'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('004_role_logins',           'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('005_pricing',               'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('006_commission_receivables','backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('007_rbac_permissions',      'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('008_booking_completion',    'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('009_monthly_targets',       'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('010_lead_intake',           'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('011_hr_incentive',          'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('012_daily_reports',         'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('013_site_visit_booked',     'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('014_team_layer',            'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('015_match_log',             'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('016_property_showcase',     'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('017_team_review',           'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('018_hierarchy_rename',      'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('019_config_99acres',        'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('020_property_title',        'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('021_decouple_and_sheet',    'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('022_mixeduse',              'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('023_sheet_mirror',          'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('024_structured_fields',     'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('025_available_units',       'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('026_property_sheet',        'backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('027_property_leads_upgrade','backfilled 2026-07-28 (pre-ledger; confirmed by schema)'),
  ('028_migration_ledger',      'introduces the ledger itself')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
