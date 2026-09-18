// =============================================================
// lib/navHome.js — ONE role-aware navigation resolver. Two exports:
//
//   homeFor(user)          -> the actor's HOME (dashboards, error pages, bounces)
//   backFor(user, context) -> the actor's world-correct target for a given
//                             navigation context (back links, breadcrumb roots,
//                             "Cancel", post-action redirects)
//
// This is the single source of truth that keeps an admin/HR/role user from EVER
// being dropped into the employee world by a back link, breadcrumb or redirect.
//
//   homeFor:
//     logged-out                       -> /login
//     super_admin / admin              -> /admin/dashboard
//     fine-role with a console (e.g.   -> user.homePath (set at login via
//       hr_manager -> /hr/dashboard)      auth.landingFor; falls back below)
//     plain employee                   -> /dashboard
//
//   backFor(user, context):
//     'home'                           -> homeFor(user)
//     'leads'    manager               -> /admin/leads   ·  employee -> /leads
//     'projects' manager               -> /admin/projects·  employee -> /projects
//     'property' manager               -> /admin/properties· employee -> /projects
//
// Sync + null-safe on purpose: error pages must never depend on a DB call
// (the DB may be the very thing that failed). homePath is precomputed at login;
// propsBaseFor/unitsBaseFor read the navPerms the global middleware attaches.
// =============================================================

const { propsBaseFor, unitsBaseFor } = require('./propsNav');

function homeFor(user) {
    if (!user) return '/login';
    const role = user.access_role || user.role;
    if (role === 'admin' || role === 'super_admin') return '/admin/dashboard';
    if (user.homePath) return user.homePath;   // hr_manager -> /hr/dashboard, role panels, etc.
    return '/dashboard';
}

// The DEDICATED manager consoles — a login whose home is one of these lives in
// its own sealed world (admin/super → /admin, hr_manager → /hr) and must never
// land on an employee page. Add future dedicated consoles here.
const MANAGER_CONSOLES = new Set(['/admin/dashboard', '/hr/dashboard']);

// Is this actor an EMPLOYEE-world user? TRUE for plain employees AND sales-floor
// fine-roles (e.g. team_leader → /role/team_leader) — they all work IN the
// employee portal. FALSE only for the dedicated manager consoles above. Keyed on
// the resolved home, NOT on "home !== /dashboard", so a team_leader is never
// wrongly sealed out of My Leads / Walk-ins (Mustafa, E004 — live regression trap).
function isEmployeeWorld(user) {
    return !MANAGER_CONSOLES.has(homeFor(user));
}

function backFor(user, context) {
    const role = user && (user.access_role || user.role);
    const isAdmin = role === 'admin' || role === 'super_admin';
    switch (context) {
        case 'leads':
            if (isAdmin) return '/admin/leads';
            // hr_manager / role console → their own home, never employee /leads.
            if (!isEmployeeWorld(user)) return homeFor(user);
            return '/leads';
        case 'projects':
            return propsBaseFor(user);   // /admin/projects (manager) vs /projects
        case 'property':
            return unitsBaseFor(user);   // /admin/properties (manager) vs /projects
        case 'home':
        default:
            return homeFor(user);
    }
}

module.exports = { homeFor, backFor, isEmployeeWorld };
