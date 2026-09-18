// =============================================================
// middleware/permissions.js — RBAC ENFORCEMENT LAYER (§5)
//
// Grants live in private.role_permissions, keyed by ACCESS TIER
// (super_admin | admin | employee) = private.employees.access_role.
//
//   can(user, permKey, req?)   — async boolean. super_admin bypasses
//                                ALL checks (always true). Otherwise
//                                checks the tier's live grants.
//                                Per-request memo when req is passed.
//   ensurePermission(permKey)  — route middleware. Layers ON TOP of
//                                ensureAdmin/ensureSuperAdmin, never
//                                replacing them. Unauth -> /login;
//                                lacks-perm -> 403 friendly page.
//
// FAIL-CLOSED: if the grant lookup throws, access is denied. super_admin
// still passes (no DB needed), so a transient DB blip can't lock the Boss out.
// =============================================================

const pool = require('../db');
const { homeFor } = require('../lib/navHome');

// Look up the set of permission keys granted to one access tier (live only).
async function grantsForTier(tier) {
    const { rows } = await pool.query(
        `SELECT permission_key
           FROM private.role_permissions
          WHERE role_key = $1 AND deleted_at IS NULL`,
        [tier]
    );
    return new Set(rows.map(r => r.permission_key));
}

// Look up the set of permission keys granted to an employee's FINE ROLES
// (private.employee_roles → private.role_permissions). This is the per-person
// layer on top of the access-tier grants: it lets ONE human hold a permission
// (e.g. leads.view_team via the team_leader role) without granting it to the
// whole tier. Empty set when the employee has no fine roles assigned.
async function grantsForEmployeeRoles(employeeId) {
    if (!employeeId) return new Set();
    const { rows } = await pool.query(
        `SELECT DISTINCT rp.permission_key
           FROM private.employee_roles er
           JOIN private.role_permissions rp ON rp.role_key = er.role_key
          WHERE er.employee_id = $1 AND rp.deleted_at IS NULL`,
        [employeeId]
    );
    return new Set(rows.map(r => r.permission_key));
}

// Resolve the tier from a session user (access_role is canonical; role is the
// legacy alias auth.js also sets). Default to the most-restricted tier.
function tierOf(user) {
    return (user && (user.access_role || user.role)) || 'employee';
}

// can(user, permKey, req?) -> Promise<boolean>
async function can(user, permKey, req) {
    if (!user) return false;
    const tier = tierOf(user);
    if (tier === 'super_admin') return true;   // hard bypass — no DB needed

    // Per-request memo so a page checking several perms hits the DB once.
    let cache = null;
    if (req) cache = req._permGrants || (req._permGrants = {});

    // 1) Access-tier grants (the common path — short-circuits before the
    //    per-person query so employees with no fine roles are unaffected).
    let grants = cache ? cache[tier] : null;
    if (!grants) {
        grants = await grantsForTier(tier);   // may throw -> caller fails closed
        if (cache) cache[tier] = grants;
    }
    if (grants.has(permKey)) return true;

    // 2) Per-person fine-role grants (employee_roles → role_permissions). Only
    //    reached for permissions the tier does NOT already grant, so a DB blip
    //    here fails just the fine-role-derived permissions closed.
    const empId = (user.employee_id || user.id) || null;
    if (empId) {
        const fineKey = '_fine:' + empId;
        let fineGrants = cache ? cache[fineKey] : null;
        if (!fineGrants) {
            fineGrants = await grantsForEmployeeRoles(empId);
            if (cache) cache[fineKey] = fineGrants;
        }
        if (fineGrants.has(permKey)) return true;
    }

    return false;
}

// Friendly 403 — navy/gold, same voice as adminAuth's gate pages.
function friendly403(permKey, backHref) {
    return `<html><body style="font-family: Inter, sans-serif; background:#FAFAF7; color:#0A1628; padding:40px; text-align:center;">
        <h1 style="color:#D4AF37; font-family: 'Playfair Display', serif;">403 — Permission required</h1>
        <p>You don't hold the <code>${permKey}</code> permission, Captain.</p>
        <p style="color:#6b7280; font-size:14px;">Ask a Super Admin to grant it in the Permission Editor.</p>
        <a href="${backHref}" style="color:#0A1628; text-decoration:underline;">← Back</a>
     </body></html>`;
}

// ensurePermission(permKey) -> Express middleware. Use AFTER ensureAdmin.
function ensurePermission(permKey) {
    return async function (req, res, next) {
        const u = req.session && req.session.user;
        if (!u) return res.redirect('/login');
        try {
            if (await can(u, permKey, req)) return next();
        } catch (err) {
            console.error('[permissions] can() failed (failing closed):', err.message);
        }
        const back = homeFor(u);   // role-aware (hr_manager -> /hr/dashboard, admin -> /admin/dashboard)
        return res.status(403).send(friendly403(permKey, back));
    };
}

module.exports = { can, ensurePermission, grantsForTier, grantsForEmployeeRoles, tierOf };
