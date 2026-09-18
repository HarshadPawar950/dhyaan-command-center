// =============================================================
// middleware/roleGate.js
// Gate a route to a specific role-panel, the same way adminAuth
// gates admin pages. Reusable factory: ensureRole('hr_manager').
//
// Pass rule:
//   - super_admin / admin (access_role)  -> always allowed (oversight)
//   - holds the role in private.employee_roles -> allowed
//   - else -> 403
// Not logged in -> /login
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

function ensureRole(roleKey, label) {
    return async function (req, res, next) {
        if (!req.session || !req.session.user) {
            return res.redirect('/login');
        }
        const u = req.session.user;

        // admins & super_admins see everything
        if (u.access_role === 'admin' || u.access_role === 'super_admin') {
            return next();
        }

        try {
            const { rows } = await pool.query(
                `SELECT 1 FROM private.employee_roles
                  WHERE employee_id = $1 AND role_key = $2 LIMIT 1`,
                [u.employee_id, roleKey]
            );
            if (rows.length) return next();
        } catch (err) {
            console.error('[roleGate] lookup failed:', err.message);
        }

        return res
            .status(403)
            .send(
                `<html><body style="font-family: Inter, sans-serif; background:#FAFAF7; color:#0A1628; padding:40px; text-align:center;">
                    <h1 style="color:#D4AF37; font-family: 'Playfair Display', serif;">403 — ${label || roleKey} access only</h1>
                    <p>You don't have permission to view that workspace, Captain.</p>
                    ${_homeLink(req)}
                 </body></html>`
            );
    };
}

module.exports = { ensureRole };
