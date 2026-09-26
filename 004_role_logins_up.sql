-- =====================================================================
-- 004_role_logins_up.sql  —  Working login per role
-- Creates one employee-tier login for each role that has no real person,
-- and maps every internal role to a login in private.employee_roles.
--
--   super_admin -> existing Boss   (kept as super_admin access)
--   it_admin    -> existing Mukul  (kept as admin access)
--   other 25    -> new employee-tier accounts, land on their own panel
--
-- All new accounts share password "Dhyaan@123" (bcrypt, $2b$12$).
-- CHANGE OR DISABLE THESE AFTER TESTING / as you hire real people.
-- Identifiable by external_id LIKE 'ROLE-LOGIN-%'.  Down: 004_role_logins_down.sql
-- =====================================================================

BEGIN;

-- ---------- 1. role login accounts (employee-tier) ----------
INSERT INTO private.employees (external_id, name, role, email, password, access_role) VALUES
 ('ROLE-LOGIN-owner_promoter',        'Owner / Promoter',             'Owner / Promoter',             'owner_promoter@dhyaan.local',        '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-ceo_director',          'CEO / Director',               'CEO / Director',               'ceo_director@dhyaan.local',          '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-sales_head',            'Sales Head',                   'Sales Head',                   'sales_head@dhyaan.local',            '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-regional_sales_manager','Regional Sales Manager',       'Regional Sales Manager',       'regional_sales_manager@dhyaan.local','$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-project_head',          'Project Head / Sales Manager', 'Project Head / Sales Manager', 'project_head@dhyaan.local',          '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-team_leader',           'Team Leader',                  'Team Leader',                  'team_leader@dhyaan.local',           '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-senior_sales_executive','Senior Sales Executive',       'Senior Sales Executive',       'senior_sales_executive@dhyaan.local','$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-sales_executive',       'Sales Executive (role login)', 'Sales Executive',              'sales_executive@dhyaan.local',       '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-presales_telecaller',   'Pre-Sales / Tele-caller',      'Pre-Sales / Tele-caller',      'presales_telecaller@dhyaan.local',   '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-builder_kam',           'Builder Relationship / KAM',   'Builder Relationship / KAM',   'builder_kam@dhyaan.local',           '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-crm_ops_manager',       'CRM / Operations Manager',     'CRM / Operations Manager',     'crm_ops_manager@dhyaan.local',       '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-sitevisit_coordinator', 'Site Visit Coordinator',       'Site Visit Coordinator',       'sitevisit_coordinator@dhyaan.local', '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-event_coordinator',     'Exhibition / Event Coordinator','Exhibition / Event Coordinator','event_coordinator@dhyaan.local',     '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-subbroker_manager',     'Sub-broker Manager',           'Sub-broker Manager',           'subbroker_manager@dhyaan.local',     '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-booking_crm_executive', 'Booking / CRM Executive',      'Booking / CRM Executive',      'booking_crm_executive@dhyaan.local', '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-marketing_manager',     'Marketing Manager',            'Marketing Manager',            'marketing_manager@dhyaan.local',     '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-marketing_executive',   'Marketing Executive',          'Marketing Executive',          'marketing_executive@dhyaan.local',   '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-creative_lead',         'Creative / Design Lead',       'Creative / Design Lead',       'creative_lead@dhyaan.local',         '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-graphic_designer',      'Graphic Designer',             'Graphic Designer',             'graphic_designer@dhyaan.local',      '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-finance_accounts',      'Finance / Accounts',           'Finance / Accounts',           'finance_accounts@dhyaan.local',      '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-legal',                 'Legal',                        'Legal',                        'legal@dhyaan.local',                 '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-hr_head',               'HR Head',                      'HR Head',                      'hr_head@dhyaan.local',               '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-hr_manager',            'HR Manager',                   'HR Manager',                   'hr_manager@dhyaan.local',            '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-hr_executive',          'HR Executive',                 'HR Executive',                 'hr_executive@dhyaan.local',          '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee'),
 ('ROLE-LOGIN-payroll_officer',       'Payroll Officer',              'Payroll Officer',              'payroll_officer@dhyaan.local',       '$2b$12$s2LCiXmjCw1R3rzEFRMEU.088vTDc1VhjbvLg3lgQoY0gKFgLaPby','employee')
ON CONFLICT (email) DO NOTHING;

-- ---------- 2. map new accounts -> their role (primary) ----------
INSERT INTO private.employee_roles (employee_id, role_key, is_primary)
SELECT e.employee_id, m.role_key, true
  FROM (VALUES
    ('owner_promoter@dhyaan.local','owner_promoter'),
    ('ceo_director@dhyaan.local','ceo_director'),
    ('sales_head@dhyaan.local','sales_head'),
    ('regional_sales_manager@dhyaan.local','regional_sales_manager'),
    ('project_head@dhyaan.local','project_head'),
    ('team_leader@dhyaan.local','team_leader'),
    ('senior_sales_executive@dhyaan.local','senior_sales_executive'),
    ('sales_executive@dhyaan.local','sales_executive'),
    ('presales_telecaller@dhyaan.local','presales_telecaller'),
    ('builder_kam@dhyaan.local','builder_kam'),
    ('crm_ops_manager@dhyaan.local','crm_ops_manager'),
    ('sitevisit_coordinator@dhyaan.local','sitevisit_coordinator'),
    ('event_coordinator@dhyaan.local','event_coordinator'),
    ('subbroker_manager@dhyaan.local','subbroker_manager'),
    ('booking_crm_executive@dhyaan.local','booking_crm_executive'),
    ('marketing_manager@dhyaan.local','marketing_manager'),
    ('marketing_executive@dhyaan.local','marketing_executive'),
    ('creative_lead@dhyaan.local','creative_lead'),
    ('graphic_designer@dhyaan.local','graphic_designer'),
    ('finance_accounts@dhyaan.local','finance_accounts'),
    ('legal@dhyaan.local','legal'),
    ('hr_head@dhyaan.local','hr_head'),
    ('hr_manager@dhyaan.local','hr_manager'),
    ('hr_executive@dhyaan.local','hr_executive'),
    ('payroll_officer@dhyaan.local','payroll_officer')
  ) AS m(email, role_key)
  JOIN private.employees e ON e.email = m.email
ON CONFLICT (employee_id, role_key) DO NOTHING;

-- ---------- 3. map existing people -> their role ----------
INSERT INTO private.employee_roles (employee_id, role_key, is_primary)
SELECT employee_id, 'super_admin', true FROM private.employees WHERE name = 'Boss'
ON CONFLICT (employee_id, role_key) DO NOTHING;

INSERT INTO private.employee_roles (employee_id, role_key, is_primary)
SELECT employee_id, 'it_admin', true FROM private.employees WHERE name = 'Mukul'
ON CONFLICT (employee_id, role_key) DO NOTHING;

COMMIT;
