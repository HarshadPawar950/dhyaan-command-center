// =====================================================================
// routes/hr-leave.js — HR leave approval inbox
// Mount: app.use('/hr', require('./routes/hr-leave'))  (after routes/hr.js)
//   GET  /hr/leave                 -> inbox (pending first) of real-staff requests
//   POST /hr/leave/:id/decision    -> approve / reject + reason (history-logged)
// ensureRole('hr_manager') — HR Manager + admin/super_admin. Role-login
// accounts excluded via the E[0-9]{3,} discriminator.
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const pool = require('../db');
const { ensureRole } = require('../middleware/roleGate');
const { logFromRequest } = require('../middleware/historyLogger');

const ensureHr = ensureRole('hr_manager', 'HR Manager');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[hr-leave] query failed:', err.message); return fallback; }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', 'views', 'hr', 'layout', name + '.ejs'), data); }
    catch (e) { console.error('[hr-leave] partial ' + name + ' failed:', e.message); return ''; }
}
async function shell(req, pageTitle) {
    const data = { user: req.session.user, pageTitle };
    return {
        sidebarHtml: await renderPartial('sidebar', data),
        topbarHtml: await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', 'topbar.ejs'), data),
    };
}

// ---------------------------------------------------------------------
// GET /hr/leave — approval inbox
// ---------------------------------------------------------------------
router.get('/leave', ensureHr, async (req, res) => {
    const requests = await safe(
        `SELECT lr.request_id, e.name AS emp_name, e.external_id AS emp_code,
                lt.name AS type_name, lr.from_date, lr.to_date, lr.days, lr.reason,
                to_char(lr.from_date,'YYYY-MM-DD') AS from_ymd,
                to_char(lr.to_date,'YYYY-MM-DD')   AS to_ymd,
                lr.status::text AS status, lr.decided_at, lr.created_at,
                de.name AS decided_by_name
           FROM private.leave_requests lr
           JOIN private.employees e  ON e.employee_id = lr.employee_id
           JOIN private.leave_types lt ON lt.leave_type_id = lr.leave_type_id
           LEFT JOIN private.employees de ON de.employee_id = lr.decided_by
          WHERE lr.deleted_at IS NULL AND e.external_id ~ '^E[0-9]{3,}$'
            AND e.email NOT LIKE '%@dhyaan.local'
          ORDER BY (lr.status = 'pending') DESC, lr.created_at DESC`,
        [], []
    );
    const counts = requests.reduce((c, r) => { c[r.status] = (c[r.status] || 0) + 1; return c; }, {});

    const { sidebarHtml, topbarHtml } = await shell(req, 'Leave Approvals');
    res.render('hr/leave', {
        pageTitle: 'Leave Approvals', user: req.session.user,
        sidebarHtml, topbarHtml, requests, counts,
        messages: { success: req.flash('success_msg'), error: req.flash('error_msg') },
    });
});

// ---------------------------------------------------------------------
// POST /hr/leave/:id/decision — approve / reject
// ---------------------------------------------------------------------
router.post('/leave/:id/decision', ensureHr, async (req, res) => {
    const id = req.params.id;
    const action = (req.body.action || '').trim();
    const reason = (req.body.reason || '').trim().slice(0, 500) || null;
    if (!UUID_RE.test(id) || !['approve', 'reject'].includes(action)) {
        req.flash('error_msg', 'Invalid decision.'); return res.redirect('/hr/leave');
    }
    const deciderId = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const client = await pool.connect();
    let done = false, empName = '', typeName = '';
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_decision');

        // Lock the request; only a still-pending, live request can be decided.
        const rq = await client.query(
            `SELECT lr.request_id, lr.employee_id, lr.leave_type_id, lr.from_date, lr.days,
                    e.name AS emp_name, lt.name AS type_name, lt.annual_quota
               FROM private.leave_requests lr
               JOIN private.employees e ON e.employee_id = lr.employee_id
               JOIN private.leave_types lt ON lt.leave_type_id = lr.leave_type_id
              WHERE lr.request_id = $1 AND lr.status = 'pending' AND lr.deleted_at IS NULL
              FOR UPDATE OF lr`,
            [id]
        );
        if (rq.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error_msg', 'That request is no longer pending.');
            return res.redirect('/hr/leave');
        }
        const r = rq.rows[0];
        empName = r.emp_name; typeName = r.type_name;

        // Serialize concurrent decisions for THIS employee. FOR UPDATE OF lr above
        // only locks this one request row, so two approvers deciding two different
        // pending requests for the same employee could both read a stale 'used'
        // total and both pass the quota check. Locking the employee row forces the
        // second txn to wait for the first to commit, then re-read the true total.
        await client.query(
            `SELECT 1 FROM private.employees WHERE employee_id = $1 FOR UPDATE`,
            [r.employee_id]
        );

        // On approve, re-check the balance (guards against over-allocation when
        // several pending requests would together exceed the quota).
        if (action === 'approve') {
            const usedRow = await client.query(
                `SELECT COALESCE(SUM(days),0)::numeric AS used FROM private.leave_requests
                  WHERE employee_id = $1 AND leave_type_id = $2 AND status = 'approved'
                    AND deleted_at IS NULL
                    AND EXTRACT(YEAR FROM from_date) = EXTRACT(YEAR FROM $3::date)`,
                [r.employee_id, r.leave_type_id, r.from_date]
            );
            const used = Number(usedRow.rows[0].used) || 0;
            if (used + Number(r.days) > Number(r.annual_quota)) {
                await client.query('ROLLBACK');
                req.flash('error_msg', `Cannot approve — exceeds ${r.type_name} quota (${used} used + ${r.days} > ${r.annual_quota}).`);
                return res.redirect('/hr/leave');
            }
        }

        await client.query(
            `UPDATE private.leave_requests
                SET status = $1::private.leave_status, decided_by = $2, decided_at = NOW()
              WHERE request_id = $3 AND status = 'pending' AND deleted_at IS NULL`,
            [newStatus, deciderId, id]
        );
        await client.query('RELEASE SAVEPOINT sp_decision');
        await client.query('COMMIT');
        done = true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-leave] decision failed:', err.message);
        req.flash('error_msg', 'Could not record the decision — see server log.');
        return res.redirect('/hr/leave');
    } finally {
        client.release();
    }

    if (done) {
        try {
            await logFromRequest(req, {
                entityType: 'leave_request', entityId: id, action: 'decision',
                fieldName: 'status', oldValue: 'pending', newValue: newStatus,
                notes: `${newStatus} by ${req.session.user.name}${reason ? ' — ' + reason : ''}`,
            });
        } catch (e) { /* logging never blocks */ }
        req.flash('success_msg', `${typeName} leave for ${empName} ${newStatus}.`);
    }
    return res.redirect('/hr/leave');
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------
// POST /hr/leave/:id/edit — edit a PENDING request's dates + reason (Δ9)
// Days are recomputed server-side; approved/rejected rows are NOT editable
// (their quota is already committed). Approval engine untouched.
// ---------------------------------------------------------------------
router.post('/leave/:id/edit', ensureHr, async (req, res) => {
    const id = req.params.id;
    const fromDate = (req.body.from_date || '').trim();
    const toDate = (req.body.to_date || '').trim();
    const reason = (req.body.reason || '').trim().slice(0, 500) || null;
    if (!UUID_RE.test(id) || !DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
        req.flash('error_msg', 'Enter valid from/to dates to edit.'); return res.redirect('/hr/leave');
    }
    if (toDate < fromDate) {
        req.flash('error_msg', 'To-date must be on or after the from-date.'); return res.redirect('/hr/leave');
    }

    // Inclusive whole-day count (mirrors routes/leave.js inclusiveDays()).
    const editDays = Math.floor(
        (new Date(toDate + 'T00:00:00Z') - new Date(fromDate + 'T00:00:00Z')) / 86400000
    ) + 1;

    let updated = 0;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_edit');

        // A half-day type (day_fraction < 1) keeps its fixed fraction and stays
        // a single day; full-day types recompute inclusive days.
        const fr = await client.query(
            `SELECT lt.day_fraction FROM private.leave_requests lr
               JOIN private.leave_types lt ON lt.leave_type_id = lr.leave_type_id
              WHERE lr.request_id = $1 AND lr.status = 'pending' AND lr.deleted_at IS NULL`,
            [id]
        );
        const frac = fr.rows.length ? Number(fr.rows[0].day_fraction) : 1;
        if (frac < 1 && fromDate !== toDate) {
            await client.query('ROLLBACK');
            req.flash('error_msg', 'A half-day leave must stay a single day.');
            return res.redirect('/hr/leave');
        }
        const days = frac < 1 ? frac : editDays;

        const r = await client.query(
            `UPDATE private.leave_requests
                SET from_date = $1::date, to_date = $2::date, days = $3, reason = $4
              WHERE request_id = $5 AND status = 'pending' AND deleted_at IS NULL`,
            [fromDate, toDate, days, reason, id]
        );
        updated = r.rowCount || 0;
        await client.query('RELEASE SAVEPOINT sp_edit');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-leave] edit failed:', err.message);
        req.flash('error_msg', 'Could not edit the request — see server log.');
        return res.redirect('/hr/leave');
    } finally { client.release(); }

    if (updated) {
        try {
            await logFromRequest(req, {
                entityType: 'leave_request', entityId: id, action: 'edit',
                notes: `Edited to ${fromDate} → ${toDate} by ${req.session.user.name}`,
            });
        } catch (e) { /* logging never blocks */ }
        req.flash('success_msg', 'Leave request updated.');
    } else {
        req.flash('error_msg', 'Only pending requests can be edited.');
    }
    return res.redirect('/hr/leave');
});

// ---------------------------------------------------------------------
// POST /hr/leave/:id/delete — SOFT-DELETE a leave request (Δ9)
// deleted_at set; row kept for audit. Any status may be removed.
// ---------------------------------------------------------------------
router.post('/leave/:id/delete', ensureHr, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { req.flash('error_msg', 'Invalid request.'); return res.redirect('/hr/leave'); }

    let removed = 0;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_del');
        const r = await client.query(
            `UPDATE private.leave_requests SET deleted_at = NOW()
              WHERE request_id = $1 AND deleted_at IS NULL`,
            [id]
        );
        removed = r.rowCount || 0;
        await client.query('RELEASE SAVEPOINT sp_del');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-leave] delete failed:', err.message);
        req.flash('error_msg', 'Could not remove the request — see server log.');
        return res.redirect('/hr/leave');
    } finally { client.release(); }

    if (removed) {
        try {
            await logFromRequest(req, {
                entityType: 'leave_request', entityId: id, action: 'delete',
                fieldName: 'deleted_at', newValue: 'removed',
                notes: `Leave request removed (soft-delete) by ${req.session.user.name}`,
            });
        } catch (e) { /* logging never blocks */ }
        req.flash('success_msg', 'Leave request removed.');
    } else {
        req.flash('error_msg', 'Request not found or already removed.');
    }
    return res.redirect('/hr/leave');
});

module.exports = router;
