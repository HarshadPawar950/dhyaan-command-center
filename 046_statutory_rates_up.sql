-- 046_statutory_rates_up.sql
-- PHASE 4 · PAYROLL — CONFIGURABLE statutory rates + Maharashtra PT slabs.
-- CRITICAL: rates are DATA, never code constants. Rows are EFFECTIVE-DATED and
-- NEVER hard-updated — a rate change INSERTs a new effective_from row; the old
-- row stays so a historical payslip still reconciles. The compute reads the row
-- effective for the run's period_month (latest effective_from <= period, active).
-- Seed = current values effective 2025-04-01 (FY start), editable by super_admin.

BEGIN;

CREATE TABLE IF NOT EXISTS private.statutory_rates (
  rate_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_key       text NOT NULL,
  rate_type      text NOT NULL CHECK (rate_type IN ('percent','amount','threshold')),
  value          numeric(14,4) NOT NULL,
  effective_from date NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT uq_statutory_rate_key_from UNIQUE (rate_key, effective_from)
);

-- Maharashtra PT is slab-based → its own effective-dated table.
CREATE TABLE IF NOT EXISTS private.pt_slabs (
  slab_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state          text NOT NULL DEFAULT 'MH',
  lower_gross    numeric(14,2) NOT NULL,      -- match: gross > lower AND (upper IS NULL OR gross <= upper)
  upper_gross    numeric(14,2),               -- NULL = open top
  monthly_amount numeric(14,2) NOT NULL,
  feb_amount     numeric(14,2),               -- MH February quirk (NULL = same as monthly)
  effective_from date NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS ix_pt_slabs_state_from ON private.pt_slabs (state, effective_from) WHERE deleted_at IS NULL;

-- ---- SEED: current statutory rates (effective FY 2025-26 onward) ----
INSERT INTO private.statutory_rates (rate_key, rate_type, value, effective_from, notes)
SELECT v.k, v.t, v.val, DATE '2025-04-01', v.n
  FROM (VALUES
    ('pf_employee_pct',    'percent',   12.0000, 'EPF employee contribution %'),
    ('pf_employer_pct',    'percent',   12.0000, 'EPF employer contribution %'),
    ('pf_wage_ceiling',    'threshold', 15000.0000, 'PF computed on basic capped at this'),
    ('esi_employee_pct',   'percent',   0.7500, 'ESI employee %'),
    ('esi_employer_pct',   'percent',   3.2500, 'ESI employer %'),
    ('esi_gross_threshold','threshold', 21000.0000, 'ESI applies only if gross <= this')
  ) AS v(k, t, val, n)
 WHERE NOT EXISTS (SELECT 1 FROM private.statutory_rates r WHERE r.rate_key = v.k AND r.effective_from = DATE '2025-04-01');

-- ---- SEED: Maharashtra PT slabs (effective FY 2025-26) ----
INSERT INTO private.pt_slabs (state, lower_gross, upper_gross, monthly_amount, feb_amount, effective_from, notes)
SELECT 'MH', v.lo, v.hi, v.amt, v.feb, DATE '2025-04-01', v.n
  FROM (VALUES
    (0.00,     7500.00, 0.00,   NULL::numeric, 'Up to 7,500 — nil'),
    (7500.00,  10000.00, 175.00, NULL::numeric, '7,501–10,000 — Rs.175'),
    (10000.00, NULL::numeric, 200.00, 300.00,   'Above 10,000 — Rs.200 (Rs.300 in Feb)')
  ) AS v(lo, hi, amt, feb, n)
 WHERE NOT EXISTS (SELECT 1 FROM private.pt_slabs s WHERE s.state='MH' AND s.lower_gross = v.lo AND s.effective_from = DATE '2025-04-01');

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('046_statutory_rates', 'statutory_rates + pt_slabs (effective-dated, seeded PF/ESI + MH PT slabs)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
