// =============================================================
// middleware/sealEmployeeWorld.js — SEALED WORLDS.
//
// The one guard that bounces any non-employee actor (admin, super_admin,
// hr_manager, a role-console user) OFF an employee-world GET surface and back to
// THEIR own home. Kills the recurring "press back → land on an employee page"
// bug at the source: the employee page simply refuses to render for a manager
// and sends them home instead.
//
// Employee-world test = homeFor(user) === '/dashboard' (see lib/navHome). A plain
// employee passes through untouched; everyone else is redirected home.
//
// SAFETY: mount this ONLY on GET view-render surfaces that are employee-only.
// NEVER on a POST/mutation endpoint an admin might legitimately call, or a shared
// form route — a bounce there would silently drop the action. Logged-out users
// fall through to the route's own ensureAuthenticated (which sends them to login).
// =============================================================

const { homeFor, isEmployeeWorld } = require('../lib/navHome');

function sealEmployeeWorld(req, res, next) {
    const u = req.session && req.session.user;
    if (!u) return next();                 // not our job — ensureAuthenticated handles login
    if (isEmployeeWorld(u)) return next(); // a real employee — let them in
    return res.redirect(homeFor(u));       // manager on an employee surface — go home
}

module.exports = { sealEmployeeWorld };
