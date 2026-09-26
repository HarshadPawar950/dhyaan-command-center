-- =====================================================================
-- 001_roles_up.sql  —  Role system (Batch 1: Sales Hierarchy)
-- Additive & reversible. Does NOT touch employees.role / employees.access_role
-- or any existing gating. Down-migration: 001_roles_down.sql
--
-- Creates:
--   private.roles           — catalog of the 31 roles (data, not an ENUM)
--   private.employee_roles  — many-to-many person<->role (left EMPTY this batch;
--                             logins/people assigned in a later step)
-- Seeds: the 10 Sales Hierarchy roles only.
-- =====================================================================

BEGIN;

-- ---------- roles catalog ----------
CREATE TABLE IF NOT EXISTS private.roles (
  role_key     text PRIMARY KEY,
  name         text NOT NULL,
  category     text NOT NULL CHECK (category IN ('sales','operations','hr','external')),
  sort_order   int  NOT NULL,
  is_external  boolean NOT NULL DEFAULT false,
  inherits     text REFERENCES private.roles(role_key),
  permissions  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- add a perm = one UPDATE, no migration
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- person <-> role mapping (empty for now) ----------
CREATE TABLE IF NOT EXISTS private.employee_roles (
  employee_id uuid    NOT NULL REFERENCES private.employees(employee_id) ON DELETE CASCADE,
  role_key    text    NOT NULL REFERENCES private.roles(role_key),
  is_primary  boolean NOT NULL DEFAULT false,
  scope       jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- {region:..}/{project_id:..}/{team_id:..}
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_employee_roles_role ON private.employee_roles(role_key);

-- ---------- seed: 10 Sales Hierarchy roles ----------
-- Insert order respects the inherits FK (parents before children).
INSERT INTO private.roles (role_key, name, category, sort_order, inherits, permissions, description) VALUES
 ('super_admin','Super Admin','sales',1,NULL,
   '["all"]',
   'Full access to everything; tenant configuration, all settings, user and role management.'),

 ('owner_promoter','Owner / Promoter','sales',2,NULL,
   '["read.all","dashboard.owner","approvals.highvalue"]',
   'Read-only across everything + owner dashboard: spend, ROI, pipeline value, cash position. High-value approvals. No operational editing.'),

 ('ceo_director','CEO / Director','sales',3,NULL,
   '["read.all","discount.approve.high"]',
   'All read access; approve high-value discounts.'),

 ('presales_telecaller','Pre-Sales / Tele-caller','sales',10,NULL,
   '["leads.view.queue","leads.qualify"]',
   'Lead qualification queue only; cannot book.'),

 ('sales_executive','Sales Executive','sales',9,'presales_telecaller',
   '["leads.view.own","leads.status.update","sitevisits.schedule"]',
   'Own leads only; status updates; site visits. Cannot reassign.'),

 ('senior_sales_executive','Senior Sales Executive','sales',8,'sales_executive',
   '["leads.view.assigned","bookings.initiate"]',
   'Own leads + assigned leads; site visits; can initiate bookings.'),

 ('team_leader','Team Leader','sales',7,'senior_sales_executive',
   '["leads.view.team","leads.reassign.team","reviews.daily"]',
   'Team''s leads, daily reviews, reassignment within the team.'),

 ('project_head','Project Head / Sales Manager','sales',6,'team_leader',
   '["project.pnl","team.manage","discount.approve.slab"]',
   'Single project P&L; team management; discount approvals up to slab.'),

 ('regional_sales_manager','Regional Sales Manager','sales',5,'project_head',
   '["leads.view.region","leads.reassign.region","reports.region"]',
   'Own region''s leads and team; lead reassignment; region reports.'),

 ('sales_head','Sales Head','sales',4,'regional_sales_manager',
   '["leads.view.all","approvals.crossteam","discount.approve.high","leads.export"]',
   'Cross-region view; approval workflows across teams.')
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
