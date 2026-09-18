// =============================================================
// middleware/adminAuth.js
// Two gates for admin pages. Both NULL-safe.
//
//   ensureAdmin       — allows admin OR super_admin
//   ensureSuperAdmin  — allows super_admin only
//
// Non-logged-in users → /login
// Logged-in employees trying admin pages → /dashboard with a flash hint
// =============================================================

const { homeFor } = require('../lib/navHome');

function _isLoggedIn(req) {
    return Boolean(req && req.session && req.session.user);
}

// Role-aware "back" link for a 403 — a blocked ADMIN never gets an employee link.
function _homeLink(req) {
    const h = homeFor(req && req.session && req.session.user);
    const label = h === '/login' ? 'Go to login'
        : h === '/admin/dashboard' ? 'Back to admin dashboard'
        : h === '/hr/dashboard' ? 'Back to HR dashboard' : 'Back to your dashboard';
    return `<a href="${h}" style="color:#0A1628; text-decoration:underline;">← ${label}</a>`;
}

function _role(req) {
    return _isLoggedIn(req) ? (req.session.user.role || 'employee') : null;
}

function ensureAdmin(req, res, next) {
    if (!_isLoggedIn(req)) {
        return res.redirect('/login');
    }
    const role = _role(req);
    if (role === 'admin' || role === 'super_admin') {
        return next();
    }
    // Logged-in employee tried to peek at admin — bounce them home.
    return res
        .status(403)
        .send(
            `<html><body style="font-family: Inter, sans-serif; background:#FAFAF7; color:#0A1628; padding:40px; text-align:center;">
                <h1 style="color:#D4AF37; font-family: 'Playfair Display', serif;">403 — Admin access only</h1>
                <p>You don't have permission to view that page, Captain.</p>
                ${_homeLink(req)}
             </body></html>`
        );
}

function ensureSuperAdmin(req, res, next) {
    if (!_isLoggedIn(req)) {
        return res.redirect('/login');
    }
    if (_role(req) === 'super_admin') {
        return next();
    }
    return res
        .status(403)
        .send(
            `<html><body style="font-family: Inter, sans-serif; background:#FAFAF7; color:#0A1628; padding:40px; text-align:center;">
                <h1 style="color:#D4AF37; font-family: 'Playfair Display', serif;">403 — Super-admin only</h1>
                <p>This action requires the Boss.</p>
                ${_homeLink(req)}
             </body></html>`
        );
}

module.exports = { ensureAdmin, ensureSuperAdmin };
