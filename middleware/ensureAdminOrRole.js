// =============================================================
// middleware/ensureAdminOrRole.js
// ADDITIVE gate (Δ1). Widens an admin-only route to ALSO admit a specific
// fine-role holder — WITHOUT weakening the existing admin/super_admin access.
//
//   pass rule:
//     - access_role admin / super_admin  -> always allowed (unchanged)
//     - holds roleKey in private.employee_roles -> allowed (the ADD)
//     - else -> the same friendly 403 as ensureAdmin
//
// Use in place of `ensureAdmin` when a team fine-role (e.g. hr_manager) should
// reach an admin surface. Keep ensurePermission(...) after it if present.
// =============================================================

const pool = require('../db');
const { homeFor } = require('../lib/navHome');

function _homeLink(req) {
    const h = homeFor(req && req.session && req.session.user);
    const label = h === '/login' ? 'Go to login'
        : h === '/admin/dashboard' ? 'Back to admin dashboard'
        : h === '/hr/dashboard' ? 'Back to HR dashboard' : 'Back to your dashboard';
    return `<a href="${h}" style="color:#0A1628; text-decoration:underline;">← ${label}</a>`;
}

function ensureAdminOrRole(roleKey, label) {
    return async function (req, res, next) {
        if (!req.session || !req.session.user) {
            return res.redirect('/login');
        }
        const u = req.session.user;
        const role = u.access_role || u.role || 'employee';

        // Existing admin access — never weakened.
        if (role === 'admin' || role === 'super_admin') {
            return next();
        }

        // The additive path: this human holds the named fine-role.
        try {
            const { rows } = await pool.query(
                `SELECT 1 FROM private.employee_roles
                  WHERE employee_id = $1 AND role_key = $2 LIMIT 1`,
                [u.employee_id || u.id, roleKey]
            );
            if (rows.length) return next();
        } catch (err) {
            console.error('[ensureAdminOrRole] lookup failed (failing closed):', err.message);
        }

        return res
            .status(403)
            .send(
                `<html><body style="font-family: Inter, sans-serif; background:#FAFAF7; color:#0A1628; padding:40px; text-align:center;">
                    <h1 style="color:#D4AF37; font-family: 'Playfair Display', serif;">403 — Admin or ${label || roleKey} only</h1>
                    <p>You don't have permission to view that page, Captain.</p>
                    ${_homeLink(req)}
                 </body></html>`
            );
    };
}

module.exports = { ensureAdminOrRole };
