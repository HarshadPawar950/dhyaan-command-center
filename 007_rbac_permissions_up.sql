-- =====================================================================
-- 007_rbac_permissions_up.sql — RBAC ENFORCEMENT LAYER (§5)
-- Adds the permission/grant tables the enforcement layer needs:
--   private.permissions      — the catalogue of permission keys (soft-delete)
--   private.role_permissions — which ACCESS TIER holds which permission
--
-- role_key in role_permissions = an ACCESS TIER value
-- ('super_admin' | 'admin' | 'employee'), matching
-- private.employees.access_role — NOT a fine private.roles.role_key.
-- (The 27 fine roles / team layer are a deferred future grant subject.)
--
-- Seed grants: super_admin -> ALL 14 · admin -> all except hr.manage (13)
--              employee -> leads.view_own + site_visits.manage (2).
-- leads.view_team is catalogued but granted to nobody (team layer deferred).
--
-- No existing table/column altered or dropped. Approval engine untouched.
-- Frozen trio (leads/properties/property_units) untouched. Idempotent.
-- Down: 007_rbac_permissions_down.sql
-- =====================================================================

BEGIN;

-- 1. Permission catalogue (soft-delete via deleted_at).
CREATE TABLE IF NOT EXISTS private.permissions (
    permission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key           text NOT NULL UNIQUE,
    label         text NOT NULL,
    category      text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);

-- 2. Grants. role_key = ACCESS TIER (super_admin|admin|employee),
--    mirroring private.employees.access_role. Soft-delete via deleted_at.
CREATE TABLE IF NOT EXISTS private.role_permissions (
    role_key       text NOT NULL,
    permission_key text NOT NULL REFERENCES private.permissions(key) ON UPDATE CASCADE,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    deleted_at     timestamptz,
    PRIMARY KEY (role_key, permission_key)
);

-- 3. Seed the 14 starter permissions.
INSERT INTO private.permissions (key, label, category) VALUES
 ('leads.view_own',     'View own leads',         'Leads'),
 ('leads.view_team',    'View team leads',        'Leads'),
 ('leads.view_all',     'View all leads',         'Leads'),
 ('leads.reassign',     'Reassign leads',         'Leads'),
 ('leads.export',       'Export leads',           'Leads'),
 ('properties.manage',  'Manage properties',      'Properties'),
 ('clients.manage',     'Manage clients',         'Clients'),
 ('bookings.manage',    'Manage bookings',        'Bookings'),
 ('commissions.view',   'View commissions',       'Commissions'),
 ('commissions.manage', 'Manage commissions',     'Commissions'),
 ('site_visits.manage', 'Manage site visits',     'Site Visits'),
 ('marketing.view',     'View marketing',         'Marketing'),
 ('reports.view',       'View reports & history', 'Reports'),
 ('hr.manage',          'Manage HR',              'HR')
ON CONFLICT (key) DO NOTHING;

-- 4. Seed grants per access tier.

-- super_admin -> ALL 14 (also hard-bypassed in can(); seeded so the editor
-- matrix shows the full row and the revoke-guard has rows to protect).
INSERT INTO private.role_permissions (role_key, permission_key)
SELECT 'super_admin', key FROM private.permissions
ON CONFLICT (role_key, permission_key) DO NOTHING;

-- admin -> all EXCEPT hr.manage (13).
INSERT INTO private.role_permissions (role_key, permission_key)
SELECT 'admin', key FROM private.permissions WHERE key <> 'hr.manage'
ON CONFLICT (role_key, permission_key) DO NOTHING;

-- employee -> leads.view_own + site_visits.manage (2).
INSERT INTO private.role_permissions (role_key, permission_key) VALUES
 ('employee', 'leads.view_own'),
 ('employee', 'site_visits.manage')
ON CONFLICT (role_key, permission_key) DO NOTHING;

COMMIT;
