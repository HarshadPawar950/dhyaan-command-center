-- 045_salary_structure_up.sql
-- PHASE 4 · PAYROLL — per-employee salary structure + statutory identifiers.
-- 1:1 live per employee (partial-unique). Compensation is the most private data
-- in the system; reads/writes are payroll-gated. Soft-delete. All amounts >= 0.

BEGIN;

CREATE TABLE IF NOT EXISTS private.salary_structure (
  structure_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL REFERENCES private.employees(employee_id),
  basic               numeric(14,2) NOT NULL DEFAULT 0 CHECK (basic >= 0),
  hra                 numeric(14,2) NOT NULL DEFAULT 0 CHECK (hra >= 0),
  allowances          numeric(14,2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  ctc                 numeric(14,2) CHECK (ctc IS NULL OR ctc >= 0),
  monthly_tds_default numeric(14,2) NOT NULL DEFAULT 0 CHECK (monthly_tds_default >= 0),
  pan                 text,
  pf_uan              text,
  esi_number          text,
  bank_account        text,
  bank_ifsc           text,
  effective_from      date NOT NULL DEFAULT CURRENT_DATE,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  deleted_at          timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_structure_emp_live
  ON private.salary_structure (employee_id) WHERE deleted_at IS NULL;

INSERT INTO private.schema_migrations (migration, note) VALUES
  ('045_salary_structure', 'salary_structure (basic/hra/allowances/ctc + tds default + PAN/UAN/ESI/bank, 1:1 live)')
ON CONFLICT (migration) DO NOTHING;

COMMIT;
