-- 047_payroll_runs_up.sql
-- PHASE 4 · PAYROLL — the run + payslip tables. COMPUTE-THEN-CONFIRM:
-- payroll_runs lifecycle draft -> approved -> paid (+ cancelled). Transition
-- order is enforced IN-ROUTE (draft->paid is rejected; must pass approved).
-- payslips = one row per employee per run with every gross component + each
-- statutory deduction + net; snapshot jsonb freezes the computation (incl. the
-- incentive entry_ids consumed) so a payslip reconciles even if rates change.

BEGIN;

CREATE TABLE IF NOT EXISTS private.payroll_runs (
  run_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month  date NOT NULL,                 -- 1st of the payroll month
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','approved','paid','cancelled')),
  notes         text,
  created_by    uuid,
  approved_by   uuid,
  approved_at   timestamptz,
  paid_by       uuid,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
-- one live, non-cancelled run per month
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_run_period_live
  ON private.payroll_runs (period_month) WHERE deleted_at IS NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS private.payslips (
  payslip_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES private.payroll_runs(run_id),
  employee_id       uuid NOT NULL REFERENCES private.employees(employee_id),
  basic             numeric(14,2) NOT NULL DEFAULT 0,
  hra               numeric(14,2) NOT NULL DEFAULT 0,
  allowances        numeric(14,2) NOT NULL DEFAULT 0,
  gross             numeric(14,2) NOT NULL DEFAULT 0,
  incentive_amount  numeric(14,2) NOT NULL DEFAULT 0,
  pf_employee       numeric(14,2) NOT NULL DEFAULT 0,
  esi_employee      numeric(14,2) NOT NULL DEFAULT 0,
  professional_tax  numeric(14,2) NOT NULL DEFAULT 0,
  tds               numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions  numeric(14,2) NOT NULL DEFAULT 0,
  net_pay           numeric(14,2) NOT NULL DEFAULT 0,
  pf_employer       numeric(14,2) NOT NULL DEFAULT 0,   -- recorded, not deducted from net
  esi_employer      numeric(14,2) NOT NULL DEFAULT 0,
  snapshot          jsonb,
  pdf_path          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payslip_run_emp ON private.payslips (run_id, employee_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_payslips_emp_live ON private.payslips (employee_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('047_payroll_runs', 'payroll_runs (draft->approved->paid) + payslips (components/deductions/net, snapshot, pdf_path)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
