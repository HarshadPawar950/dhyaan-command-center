// =============================================================
// routes/auth.js — v2 REAL SCHEMA
// REPLACES the existing auth router.
// - Reads `access_role` (NEW column) for admin gating
// - Uses real columns: external_id, status, password, access_role
// - status='active' check instead of is_active=TRUE
// - Logs login/logout to history_log
// =============================================================

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');

const pool = require('../db');
const { logFromRequest } = require('../middleware/historyLogger');

function redirectByRole(accessRole) {
    if (accessRole === 'admin' || accessRole === 'super_admin') {
        return '/admin/dashboard';
    }
    return '/dashboard';
}

// Where to send an employee-tier user after login.
// Admins -> admin dashboard. Otherwise, if they hold a role-panel mapping,
// land them on that panel; else fall back to the classic /dashboard.
async function landingFor(emp) {
    if (emp.access_role === 'admin' || emp.access_role === 'super_admin') {
        return '/admin/dashboard';
    }
    try {
        const { rows } = await pool.query(
            `SELECT role_key
               FROM private.employee_roles
              WHERE employee_id = $1
              ORDER BY is_primary DESC
              LIMIT 1`,
            [emp.employee_id]
        );
        if (rows.length) {
            const key = rows[0].role_key;
            // roles with a dedicated console land there; others on their role panel
            const ROLE_HOME = { hr_manager: '/hr/dashboard' };
            return ROLE_HOME[key] || ('/role/' + key);
        }
    } catch (err) {
        console.error('[auth] landingFor lookup failed:', err.message);
    }
    return '/dashboard';
}

// ---------- GET /login ----------
router.get('/login', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect(redirectByRole(req.session.user.access_role));
    }
    res.render('login', {
        pageTitle: 'Login',
        error: null,
    });
});

// ---------- POST /login ----------
router.post('/login', async (req, res) => {
    const email = ((req.body && req.body.email) || '').trim().toLowerCase();
    const password = (req.body && req.body.password) || '';

    if (!email || !password) {
        return res.status(400).render('login', {
            pageTitle: 'Login',
            error: 'Please enter both email and password.',
        });
    }

    try {
        const { rows } = await pool.query(
            `SELECT employee_id,
                    external_id,
                    name,
                    email,
                    password,
                    role         AS job_title,
                    COALESCE(access_role, 'employee') AS access_role,
                    status::text AS status
               FROM private.employees
              WHERE LOWER(email) = $1
              LIMIT 1`,
            [email]
        );

        if (rows.length === 0) {
            return res.status(401).render('login', {
                pageTitle: 'Login',
                error: 'Invalid email or password.',
            });
        }

        const emp = rows[0];

        if (emp.status !== 'active') {
            return res.status(403).render('login', {
                pageTitle: 'Login',
                error: 'This account is not active. Please contact admin.',
            });
        }

        const ok = await bcrypt.compare(password, emp.password || '');
        if (!ok) {
            return res.status(401).render('login', {
                pageTitle: 'Login',
                error: 'Invalid email or password.',
            });
        }

        // Build session — keep both old keys (for existing employee portal compatibility)
        // and new keys (for admin panel).
        req.session.user = {
            id: emp.employee_id,
            employee_id: emp.employee_id,
            employee_code: emp.external_id,   // legacy alias — existing code may read this
            external_id: emp.external_id,
            name: emp.name,
            email: emp.email,
            role: emp.access_role,            // legacy alias — admin code reads this
            access_role: emp.access_role,
            job_title: emp.job_title,
            designation: emp.job_title,       // legacy alias
        };

        logFromRequest(req, {
            entityType: 'auth',
            entityId: emp.external_id,
            action: 'login',
            notes: `${emp.name} logged in as ${emp.access_role}`,
        });

        const landing = await landingFor(emp);
        // Persist the actor's real home so error pages / bounces are role-aware
        // (esp. hr_manager -> /hr/dashboard, which access_role alone can't tell).
        req.session.user.homePath = landing;

        return req.session.save((err) => {
            if (err) console.error('[auth] session save error:', err);
            return res.redirect(landing);
        });
    } catch (err) {
        console.error('[auth] login error:', err);
        return res.status(500).render('login', {
            pageTitle: 'Login',
            error: 'Something went wrong. Please try again.',
        });
    }
});

// ---------- GET /logout ----------
router.get('/logout', (req, res) => {
    if (req.session && req.session.user) {
        logFromRequest(req, {
            entityType: 'auth',
            entityId: req.session.user.external_id,
            action: 'logout',
            notes: `${req.session.user.name} logged out`,
        });
    }
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

module.exports = router;
