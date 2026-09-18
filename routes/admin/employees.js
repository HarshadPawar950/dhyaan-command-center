// =============================================================
// routes/admin/employees.js
// Day 2 Phase 1 — All Employees admin pages
// + User Management (Add / Edit / Reset Password / Change Role)
//
// Routes:
//   GET  /admin/employees                      → list all employees
//   GET  /admin/employees-new                  → add employee form
//   POST /admin/employees-new                  → create employee
//   GET  /admin/employees/:id                  → single employee detail
//   GET  /admin/employees/:id/edit             → edit form
//   POST /admin/employees/:id/edit             → update details
//   POST /admin/employees/:id/toggle           → activate/deactivate
//   POST /admin/employees/:id/delete           → BOSS ONLY hard-delete (zero-ref)
//   POST /admin/employees/:id/reset-password   → BOSS ONLY
//   POST /admin/employees/:id/change-role      → BOSS ONLY
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const bcrypt = require('bcrypt');
const { ensureAdmin, ensureSuperAdmin } = require('../../middleware/adminAuth');
const { logFromRequest } = require('../../middleware/historyLogger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Safe query wrapper */
async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/employees] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

// =============================================================
// GET /admin/employees — list all employees
// =============================================================
router.get('/employees', ensureAdmin, async (req, res) => {
    const employees = await safe(
        `SELECT
             e.employee_id,
             e.external_id,
             e.name,
             COALESCE(e.email, '')                        AS email,
             COALESCE(e.phone, '')                        AS phone,
             COALESCE(e.role, '')                         AS job_title,
             COALESCE(e.access_role, 'employee')          AS access_role,
             COALESCE(e.status::text, 'active')           AS status,
             e.hired_at,
             COALESCE(COUNT(DISTINCT a.lead_id), 0)::int  AS lead_count
           FROM private.employees e
      LEFT JOIN private.assignments a ON a.employee_id = e.employee_id
       GROUP BY e.employee_id, e.external_id, e.name, e.email, e.phone,
                e.role, e.access_role, e.status, e.hired_at
       ORDER BY
                CASE COALESCE(e.access_role, 'employee')
                    WHEN 'super_admin' THEN 1
                    WHEN 'admin'       THEN 2
                    ELSE 3
                END,
                e.external_id`,
        [],
        []
    );

    const stats = {
        total:     employees.length,
        active:    employees.filter(e => e.status === 'active').length,
        inactive:  employees.filter(e => e.status === 'inactive').length,
        on_leave:  employees.filter(e => e.status === 'on_leave').length,
    };

    res.render('admin/employees-list', {
        pageTitle: 'All Employees',
        user: req.session.user,
        employees,
        stats,
    });
});

// =============================================================
// GET /admin/employees-new — add employee form
// (MUST be declared BEFORE /employees/:id so it isn't captured)
// =============================================================
router.get('/employees-new', ensureSuperAdmin, async (req, res) => {
    res.render('admin/employees-new', {
        pageTitle: 'Add Employee',
        user: req.session.user,
        csrfToken: req.csrfToken()
    });
});

// =============================================================
// POST /admin/employees-new — create employee
// =============================================================
router.post('/employees-new', ensureSuperAdmin, async (req, res) => {
    const { external_id, name, role, email, phone, password, access_role } = req.body;

    if (!name || !email || !password) {
        req.flash('error', 'Name, email and password are required.');
        return res.redirect('/admin/employees-new');
    }
    if (password.length < 6) {
        req.flash('error', 'Password must be at least 6 characters.');
        return res.redirect('/admin/employees-new');
    }

    // only a super_admin may mint admin/super_admin accounts
    let finalAccessRole = (access_role || 'employee').trim();
    const requesterRole = req.session.user && req.session.user.access_role;
    if (finalAccessRole !== 'employee' && requesterRole !== 'super_admin') {
        finalAccessRole = 'employee';
    }
    if (!['employee', 'admin', 'super_admin'].includes(finalAccessRole)) {
        finalAccessRole = 'employee';
    }

    try {
        const hash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO private.employees
                (external_id, name, role, status, phone, email, hired_at, password, access_role)
             VALUES ($1, $2, $3, 'active'::private.employee_status, $4, $5, NOW(), $6, $7)
             RETURNING employee_id, external_id`,
            [external_id || null, name, role || null, phone || null, email, hash, finalAccessRole]
        );

        try {
            await logFromRequest(req, {
                entityType: 'employee',
                entityId: result.rows[0].external_id || result.rows[0].employee_id,
                action: 'create',
                notes: `Created employee ${name} (${email}), access_role=${finalAccessRole}`
            });
        } catch (e) { console.error('[employees-new] log failed:', e.message); }

        req.flash('success', `Employee "${name}" created.`);
        res.redirect('/admin/employees');
    } catch (err) {
        console.error('[employees-new] failed:', err.message);
        if (err.code === '23505') {
            req.flash('error', 'That email or employee code already exists.');
        } else {
            req.flash('error', 'Could not create employee — see server log.');
        }
        res.redirect('/admin/employees-new');
    }
});

// =============================================================
// GET /admin/employees/:id/edit — edit form
// =============================================================
router.get('/employees/:id/edit', ensureAdmin, async (req, res) => {
    const employeeId = req.params.id;
    if (!UUID_RE.test(employeeId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }
    try {
        const r = await pool.query(
            `SELECT employee_id, external_id, name, role,
                    COALESCE(status::text, 'active') AS status,
                    phone, email,
                    COALESCE(access_role, 'employee') AS access_role,
                    reports_to
               FROM private.employees WHERE employee_id = $1 LIMIT 1`,
            [employeeId]
        );
        if (r.rows.length === 0) {
            req.flash('error', 'Employee not found.');
            return res.redirect('/admin/employees');
        }
        // Manager candidates for the "Reports to" dropdown: active REAL humans
        // (E[0-9]{3,}) only — role-logins excluded — and never self.
        const managers = await safe(
            `SELECT employee_id, external_id, name
               FROM private.employees
              WHERE status = 'active'::private.employee_status
                AND external_id ~ '^E[0-9]{3,}$'
                AND email NOT LIKE '%@dhyaan.local'
                AND employee_id <> $1
              ORDER BY external_id`,
            [employeeId],
            []
        );
        // Does this employee hold the team_leader fine role? (drives view-team)
        const tlRows = await safe(
            `SELECT 1 FROM private.employee_roles
              WHERE employee_id = $1 AND role_key = 'team_leader' LIMIT 1`,
            [employeeId],
            []
        );
        // Who currently reports to this employee (their depth-1 team) — shown
        // under the dropdown so an un-mapping mistake is visible before save.
        const directReports = await safe(
            `SELECT external_id, name FROM private.employees
              WHERE reports_to = $1
                AND status = 'active'::private.employee_status
                AND external_id ~ '^E[0-9]{3,}$'
                AND email NOT LIKE '%@dhyaan.local'
              ORDER BY external_id`,
            [employeeId],
            []
        );
        res.render('admin/employees-edit', {
            pageTitle: 'Edit Employee',
            user: req.session.user,
            csrfToken: req.csrfToken(),
            emp: r.rows[0],
            managers,
            isTeamLeader: tlRows.length > 0,
            directReports
        });
    } catch (err) {
        console.error('[employees/:id/edit GET] failed:', err.message);
        req.flash('error', 'Could not load employee.');
        res.redirect('/admin/employees');
    }
});

// =============================================================
// POST /admin/employees/:id/edit — update details (NOT password/role)
// =============================================================
router.post('/employees/:id/edit', ensureAdmin, async (req, res) => {
    const employeeId = req.params.id;
    if (!UUID_RE.test(employeeId)) {
        return res.redirect('/admin/employees');
    }
    const { external_id, name, role, email, phone } = req.body;
    if (!name || !email) {
        req.flash('error', 'Name and email are required.');
        return res.redirect(`/admin/employees/${employeeId}/edit`);
    }

    // --- Reports-to (manager mapping) — normalize + validate --------------
    // Only REAL humans (E[0-9]{3,}) may carry a manager mapping. Role-logins are
    // excluded on BOTH sides of the dropdown: not offered as managers (GET), and
    // not assignable a manager here (defense-in-depth against a crafted POST).
    const targetRows = await safe(
        `SELECT external_id FROM private.employees WHERE employee_id = $1 LIMIT 1`,
        [employeeId], []
    );
    const targetIsReal = targetRows.length > 0 &&
        /^E[0-9]{3,}$/.test(targetRows[0].external_id || '');

    // Canonical entity code = DB truth (not the possibly-edited form value),
    // used as the history-log entityId so it stays stable across a same-request
    // external_id edit.
    const canonicalCode = targetRows.length ? (targetRows[0].external_id || null) : null;

    let reportsTo = (req.body.reports_to || '').trim();
    if (reportsTo === '') reportsTo = null;
    if (!targetIsReal) reportsTo = null; // role-login target → never mapped
    let newMgrCode = null;
    if (reportsTo) {
        if (!UUID_RE.test(reportsTo)) {
            req.flash('error', 'Invalid manager selection.');
            return res.redirect(`/admin/employees/${employeeId}/edit`);
        }
        // UI-level self-reference block (the DB CHECK is the backstop).
        if (reportsTo === employeeId) {
            req.flash('error', 'An employee cannot report to themselves.');
            return res.redirect(`/admin/employees/${employeeId}/edit`);
        }
        // Manager must be an active REAL human (E[0-9]{3,}) — never a role-login.
        const mgr = await safe(
            `SELECT external_id, name FROM private.employees
              WHERE employee_id = $1
                AND status = 'active'::private.employee_status
                AND external_id ~ '^E[0-9]{3,}$'
                AND email NOT LIKE '%@dhyaan.local'
              LIMIT 1`,
            [reportsTo],
            []
        );
        if (mgr.length === 0) {
            req.flash('error', 'Selected manager is not an active employee.');
            return res.redirect(`/admin/employees/${employeeId}/edit`);
        }
        newMgrCode = mgr[0].external_id; // reuse validation result — no re-fetch
    }

    try {
        // Current reports_to (for old->new history logging), resolved to a code.
        const curRows = await safe(
            `SELECT e.reports_to,
                    (SELECT m.external_id FROM private.employees m
                      WHERE m.employee_id = e.reports_to) AS old_mgr_code
               FROM private.employees e WHERE e.employee_id = $1 LIMIT 1`,
            [employeeId],
            []
        );
        const oldReportsTo = curRows.length ? (curRows[0].reports_to || null) : null;
        const oldMgrCode = curRows.length ? (curRows[0].old_mgr_code || null) : null;

        await pool.query(
            `UPDATE private.employees
                SET external_id = $1, name = $2, role = $3, email = $4, phone = $5,
                    reports_to = $6
              WHERE employee_id = $7`,
            [external_id || null, name, role || null, email, phone || null, reportsTo, employeeId]
        );
        try {
            await logFromRequest(req, {
                entityType: 'employee', entityId: canonicalCode || employeeId,
                action: 'update', notes: `Updated details for ${name}`
            });
            // Dedicated old->new entry when the manager mapping actually changed.
            if (String(oldReportsTo || '') !== String(reportsTo || '')) {
                await logFromRequest(req, {
                    entityType: 'employee', entityId: canonicalCode || employeeId,
                    action: 'update', fieldName: 'reports_to',
                    oldValue: oldMgrCode || 'none', newValue: newMgrCode || 'none',
                    notes: `Reports-to for ${name}: ${oldMgrCode || 'none'} -> ${newMgrCode || 'none'}`
                });
            }
        } catch (e) { console.error('[employees-edit] log failed:', e.message); }

        // --- Team Leader fine role (employee_roles) — real humans only -------
        // The checkbox grants/removes the team_leader role for this person. The
        // role's leads.view_team grant (Permission Editor) is what actually
        // lights up team-view; this only assigns the role. Hard insert/delete —
        // employee_roles has no soft-delete column by design.
        if (targetIsReal) {
            const wantTL = req.body.is_team_leader === 'on' || req.body.is_team_leader === 'true';
            const hadTL = (await safe(
                `SELECT 1 FROM private.employee_roles
                  WHERE employee_id = $1 AND role_key = 'team_leader' LIMIT 1`,
                [employeeId], []
            )).length > 0;
            if (wantTL !== hadTL) {
                try {
                    if (wantTL) {
                        await pool.query(
                            `INSERT INTO private.employee_roles (employee_id, role_key, is_primary)
                             VALUES ($1, 'team_leader', false)
                             ON CONFLICT (employee_id, role_key) DO NOTHING`,
                            [employeeId]
                        );
                    } else {
                        await pool.query(
                            `DELETE FROM private.employee_roles
                              WHERE employee_id = $1 AND role_key = 'team_leader'`,
                            [employeeId]
                        );
                    }
                    await logFromRequest(req, {
                        entityType: 'employee', entityId: canonicalCode || employeeId,
                        action: 'update', fieldName: 'role:team_leader',
                        oldValue: hadTL ? 'assigned' : 'none',
                        newValue: wantTL ? 'assigned' : 'none',
                        notes: `Team Leader role for ${name}: ${hadTL ? 'assigned' : 'none'} -> ${wantTL ? 'assigned' : 'none'}`
                    });
                } catch (e) { console.error('[employees-edit] team_leader sync failed:', e.message); }
            }
        }

        req.flash('success', `Employee "${name}" updated.`);
        res.redirect('/admin/employees');
    } catch (err) {
        console.error('[employees/:id/edit POST] failed:', err.message);
        req.flash('error', 'Update failed — see server log.');
        res.redirect(`/admin/employees/${employeeId}/edit`);
    }
});

// =============================================================
// GET /admin/employees/:id — single employee detail + leads
// =============================================================
router.get('/employees/:id', ensureAdmin, async (req, res) => {
    const employeeId = req.params.id;

    if (!UUID_RE.test(employeeId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const empRows = await safe(
        `SELECT employee_id,
                external_id,
                name,
                COALESCE(email, '')               AS email,
                COALESCE(phone, '')               AS phone,
                COALESCE(role, '')                AS job_title,
                COALESCE(access_role, 'employee') AS access_role,
                COALESCE(status::text, 'active')  AS status,
                hired_at
           FROM private.employees
          WHERE employee_id = $1
          LIMIT 1`,
        [employeeId],
        []
    );

    if (empRows.length === 0) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }
    const employee = empRows[0];

    // Team relationships (depth-1). Manager = who this employee reports to.
    // Reports = active real humans (E[0-9]{3,}) who report to this employee.
    const managerRows = await safe(
        `SELECT m.external_id, m.name
           FROM private.employees e
           JOIN private.employees m ON m.employee_id = e.reports_to
          WHERE e.employee_id = $1
          LIMIT 1`,
        [employeeId],
        []
    );
    const manager = managerRows.length ? managerRows[0] : null;
    const directReports = await safe(
        `SELECT external_id, name FROM private.employees
          WHERE reports_to = $1
            AND status = 'active'::private.employee_status
            AND external_id ~ '^E[0-9]{3,}$'
            AND email NOT LIKE '%@dhyaan.local'
          ORDER BY external_id`,
        [employeeId],
        []
    );

    const leads = await safe(
        `SELECT l.lead_id,
                COALESCE(l.external_id, '')      AS external_id,
                l.name,
                COALESCE(l.phone, '')            AS phone,
                COALESCE(l.email, '')            AS email,
                COALESCE(l.status::text, 'cold') AS status,
                COALESCE(l.location, '')         AS location,
                COALESCE(l.budget, '')           AS budget,
                a.assigned_at
           FROM private.assignments a
           JOIN private.leads l ON l.lead_id = a.lead_id
          WHERE a.employee_id = $1
       ORDER BY a.assigned_at DESC
          LIMIT 100`,
        [employeeId],
        []
    );

    const breakdown = leads.reduce((acc, l) => {
        const s = (l.status || 'unknown').toLowerCase();
        acc[s] = (acc[s] || 0) + 1;
        return acc;
    }, {});

    const history = await safe(
        `SELECT entity_type, action, field_name, old_value, new_value,
                changed_by_name, notes, created_at
           FROM private.history_log
          WHERE entity_type = 'employee' AND entity_id = $1
       ORDER BY created_at DESC
          LIMIT 20`,
        [employee.external_id],
        []
    );

    res.render('admin/employees-detail', {
        pageTitle: employee.name,
        user: req.session.user,
        employee,
        leads,
        breakdown,
        history,
        manager,
        directReports,
    });
});

// =============================================================
// POST /admin/employees/:id/toggle — flip status active <-> inactive
// =============================================================
router.post('/employees/:id/toggle', ensureSuperAdmin, async (req, res) => {
    const employeeId = req.params.id;
    const actor = req.session.user;

    if (!UUID_RE.test(employeeId)) {
        return res.redirect('/admin/employees');
    }

    if (actor && (actor.employee_id === employeeId || actor.id === employeeId)) {
        return res.redirect('/admin/employees/' + employeeId);
    }

    try {
        const cur = await pool.query(
            `SELECT external_id, name, status::text AS status,
                    COALESCE(access_role, 'employee') AS access_role
               FROM private.employees
              WHERE employee_id = $1
              LIMIT 1`,
            [employeeId]
        );

        if (cur.rows.length === 0) {
            return res.redirect('/admin/employees');
        }
        const before = cur.rows[0];

        if (actor.access_role === 'admin' && before.access_role !== 'employee') {
            return res.redirect('/admin/employees/' + employeeId);
        }

        const newStatus = before.status === 'active' ? 'inactive' : 'active';

        // LOCKOUT GUARD: never deactivate the last active super_admin.
        if (newStatus === 'inactive' && before.access_role === 'super_admin') {
            const sc = await pool.query(
                `SELECT COUNT(*)::int AS c FROM private.employees
                  WHERE access_role = 'super_admin' AND status = 'active'::private.employee_status`);
            if (sc.rows[0].c <= 1) {
                req.flash('error', 'Cannot deactivate the last active super admin — you would lock everyone out.');
                return res.redirect('/admin/employees/' + employeeId);
            }
        }

        await pool.query(
            `UPDATE private.employees
                SET status = $1::private.employee_status
              WHERE employee_id = $2`,
            [newStatus, employeeId]
        );

        await logFromRequest(req, {
            entityType: 'employee',
            entityId: before.external_id,
            action: 'status_change',
            fieldName: 'status',
            oldValue: before.status,
            newValue: newStatus,
            notes: `${actor.name} changed status of ${before.name} (${before.external_id}) from ${before.status} -> ${newStatus}`,
        });

        return res.redirect('/admin/employees/' + employeeId);
    } catch (err) {
        console.error('[admin/employees] toggle error:', err.message);
        return res.redirect('/admin/employees');
    }
});

// =============================================================
// POST /admin/employees/:id/delete — BOSS ONLY, direct hard-delete.
//   Guarded: not self, not the last super_admin, and ZERO references
//   across every FK table (except the employee's own employee_roles,
//   which are removed in the same txn). Any other reference -> refuse,
//   tell them to Deactivate. Irreversible; logged to history_log.
// =============================================================
router.post('/employees/:id/delete', ensureSuperAdmin, async (req, res) => {
    const employeeId = req.params.id;
    const actor = req.session.user;
    if (!UUID_RE.test(employeeId)) return res.redirect('/admin/employees');
    if (actor && (actor.employee_id === employeeId || actor.id === employeeId)) {
        req.flash('error', 'You cannot delete your own account.');
        return res.redirect('/admin/employees/' + employeeId);
    }

    // Load target.
    const cur = await safe(
        `SELECT external_id, name, status::text AS status,
                COALESCE(access_role,'employee') AS access_role
           FROM private.employees WHERE employee_id = $1 LIMIT 1`, [employeeId], []);
    if (!cur.length) { req.flash('error', 'Employee not found.'); return res.redirect('/admin/employees'); }
    const before = cur[0];

    // Never delete the only super_admin identity (any status).
    if (before.access_role === 'super_admin') {
        const sc = await safe(`SELECT COUNT(*)::int AS c FROM private.employees WHERE access_role='super_admin'`, [], [{ c: 0 }]);
        if (sc[0].c <= 1) {
            req.flash('error', 'Cannot delete the last super admin account.');
            return res.redirect('/admin/employees/' + employeeId);
        }
    }

    // ZERO-REFERENCE check: every FK column pointing at employees, except the
    // employee's own employee_roles (cleaned up with the row). Names come from
    // pg_catalog only — safe to interpolate.
    const fks = await safe(
        `SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col
           FROM pg_constraint con
           JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum,ord) ON true
           JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ck.attnum
           JOIN pg_class c ON c.oid=con.conrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE con.contype='f' AND con.confrelid='private.employees'::regclass
            AND c.relname <> 'employee_roles'`, [], []);
    const blockers = new Set();
    for (const fk of fks) {
        const hit = await safe(`SELECT 1 FROM "${fk.schema}"."${fk.tbl}" WHERE "${fk.col}" = $1 LIMIT 1`, [employeeId], []);
        if (hit.length) blockers.add(fk.tbl);
    }
    if (blockers.size) {
        req.flash('error', `Cannot permanently delete ${before.name} — they still have records in: ${[...blockers].join(', ')}. Deactivate instead.`);
        return res.redirect('/admin/employees/' + employeeId);
    }

    // Atomic delete: own role grants, then the row.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_emp_del');
        await client.query(`DELETE FROM private.employee_roles WHERE employee_id = $1`, [employeeId]);
        const del = await client.query(`DELETE FROM private.employees WHERE employee_id = $1`, [employeeId]);
        if (del.rowCount === 0) throw new Error('employee row vanished mid-delete');
        await client.query('RELEASE SAVEPOINT sp_emp_del');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/employees] delete error:', err.message);
        req.flash('error', 'Delete failed — see server log.');
        return res.redirect('/admin/employees/' + employeeId);
    } finally { client.release(); }

    try {
        await logFromRequest(req, {
            entityType: 'employee', entityId: before.external_id || employeeId,
            action: 'delete', fieldName: 'status', oldValue: before.status, newValue: 'DELETED',
            notes: `${actor.name} PERMANENTLY DELETED ${before.name} (${before.external_id}) — direct super_admin action, zero-reference verified`,
        });
    } catch (e) { console.error('[employee-delete] log failed:', e.message); }

    req.flash('success', `${before.name} permanently deleted.`);
    return res.redirect('/admin/employees');
});

// =============================================================
// POST /admin/employees/:id/reset-password — BOSS ONLY
// =============================================================
router.post('/employees/:id/reset-password', ensureSuperAdmin, async (req, res) => {
    const employeeId = req.params.id;
    if (!UUID_RE.test(employeeId)) {
        return res.redirect('/admin/employees');
    }
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) {
        req.flash('error', 'New password must be at least 6 characters.');
        return res.redirect(`/admin/employees/${employeeId}/edit`);
    }
    try {
        const hash = await bcrypt.hash(new_password, 12);
        const r = await pool.query(
            `UPDATE private.employees SET password = $1 WHERE employee_id = $2
             RETURNING name, external_id`,
            [hash, employeeId]
        );
        if (r.rows.length === 0) {
            req.flash('error', 'Employee not found.');
            return res.redirect('/admin/employees');
        }
        try {
            await logFromRequest(req, {
                entityType: 'employee', entityId: r.rows[0].external_id || employeeId,
                action: 'reset_password', notes: `Password reset for ${r.rows[0].name}`
            });
        } catch (e) { console.error('[reset-password] log failed:', e.message); }
        req.flash('success', `Password reset for "${r.rows[0].name}".`);
        res.redirect(`/admin/employees/${employeeId}/edit`);
    } catch (err) {
        console.error('[reset-password] failed:', err.message);
        req.flash('error', 'Password reset failed — see server log.');
        res.redirect(`/admin/employees/${employeeId}/edit`);
    }
});

// =============================================================
// POST /admin/employees/:id/change-role — BOSS ONLY
//   Includes last-super_admin lockout guard.
// =============================================================
router.post('/employees/:id/change-role', ensureSuperAdmin, async (req, res) => {
    const employeeId = req.params.id;
    if (!UUID_RE.test(employeeId)) {
        return res.redirect('/admin/employees');
    }
    const { access_role } = req.body;
    const allowed = ['employee', 'admin', 'super_admin'];
    if (!allowed.includes(access_role)) {
        req.flash('error', 'Invalid role.');
        return res.redirect(`/admin/employees/${employeeId}/edit`);
    }
    try {
        const current = await pool.query(
            `SELECT name, external_id, COALESCE(access_role, 'employee') AS access_role
               FROM private.employees WHERE employee_id = $1 LIMIT 1`,
            [employeeId]
        );
        if (current.rows.length === 0) {
            req.flash('error', 'Employee not found.');
            return res.redirect('/admin/employees');
        }
        const before = current.rows[0];

        // LOCKOUT GUARD: don't demote the last active super_admin
        if (before.access_role === 'super_admin' && access_role !== 'super_admin') {
            const superCount = await pool.query(
                `SELECT COUNT(*)::int AS c FROM private.employees
                  WHERE access_role = 'super_admin'
                    AND status = 'active'::private.employee_status`
            );
            if (superCount.rows[0].c <= 1) {
                req.flash('error', 'Cannot demote the last super admin — you would lock everyone out.');
                return res.redirect(`/admin/employees/${employeeId}/edit`);
            }
        }

        await pool.query(
            `UPDATE private.employees SET access_role = $1 WHERE employee_id = $2`,
            [access_role, employeeId]
        );
        try {
            await logFromRequest(req, {
                entityType: 'employee', entityId: before.external_id || employeeId,
                action: 'change_role',
                fieldName: 'access_role', oldValue: before.access_role, newValue: access_role,
                notes: `Changed ${before.name} role: ${before.access_role} -> ${access_role}`
            });
        } catch (e) { console.error('[change-role] log failed:', e.message); }
        req.flash('success', `Role updated to "${access_role}".`);
        res.redirect(`/admin/employees/${employeeId}/edit`);
    } catch (err) {
        console.error('[change-role] failed:', err.message);
        req.flash('error', 'Role change failed — see server log.');
        res.redirect(`/admin/employees/${employeeId}/edit`);
    }
});

module.exports = router;
