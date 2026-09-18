// =====================================================================
// routes/leave.js — EMPLOYEE leave self-service
// Mount: app.use('/leave', require('./routes/leave'))
//   GET  /leave   -> my balance (quota − approved days this year) + my
//                    requests + request form
//   POST /leave   -> submit a request (validate, overlap + balance guard,
//                    days computed inclusive, inserted 'pending')
// ensureAuthenticated; strictly self-scoped to the logged-in employee.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { logFromRequest } = require('../middleware/historyLogger');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[leave] query failed:', err.message); return fallback; }
}

function myEmployeeId(user) {
    const cand = (user && (user.employee_id || user.id)) || null;
    return cand && UUID_RE.test(String(cand)) ? cand : null;
}

// Inclusive whole-day count between two YYYY-MM-DD dates (calendar days).
function inclusiveDays(from, to) {
    const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
    return Math.floor((b - a) / 86400000) + 1;
}

// ---------------------------------------------------------------------
// GET /leave
// ---------------------------------------------------------------------
router.get('/', ensureAuthenticated, async (req, res) => {
    const empId = myEmployeeId(req.session.user);

    // Balance per type: quota − approved days in the current calendar year.
    const balances = empId ? await safe(
        `SELECT lt.leave_type_id, lt.name, lt.annual_quota,
                COALESCE((
                    SELECT SUM(lr.days) FROM private.leave_requests lr
                     WHERE lr.employee_id = $1 AND lr.leave_type_id = lt.leave_type_id
                       AND lr.status = 'approved' AND lr.deleted_at IS NULL
                       AND EXTRACT(YEAR FROM lr.from_date) = EXTRACT(YEAR FROM CURRENT_DATE)
                ), 0)::numeric AS used
           FROM private.leave_types lt
          WHERE lt.deleted_at IS NULL
          ORDER BY lt.name`,
        [empId], []
    ) : [];
    balances.forEach(b => { b.balance = Number(b.annual_quota) - Number(b.used); });

    const requests = empId ? await safe(
        `SELECT lr.request_id, lt.name AS type_name, lr.from_date, lr.to_date, lr.days,
                lr.reason, lr.status::text AS status, lr.decided_at, lr.created_at
           FROM private.leave_requests lr
           JOIN private.leave_types lt ON lt.leave_type_id = lr.leave_type_id
          WHERE lr.employee_id = $1 AND lr.deleted_at IS NULL
          ORDER BY lr.created_at DESC`,
        [empId], []
    ) : [];

    const types = await safe(
        `SELECT leave_type_id, name, annual_quota, day_fraction FROM private.leave_types
          WHERE deleted_at IS NULL ORDER BY name`, [], []
    );

    res.render('leave', {
        pageTitle: 'My Leave',
        user: req.session.user,
        balances, requests, types,
        noEmp: !empId,
    });
});

// ---------------------------------------------------------------------
// POST /leave — submit a request
// ---------------------------------------------------------------------
router.post('/', ensureAuthenticated, async (req, res) => {
    const empId = myEmployeeId(req.session.user);
    if (!empId) { req.flash('error_msg', 'Could not resolve your employee record.'); return res.redirect('/leave'); }

    const typeId = (req.body.leave_type_id || '').trim();
    const fromDate = (req.body.from_date || '').trim();
    const toDate = (req.body.to_date || '').trim();
    const reason = (req.body.reason || '').trim().slice(0, 500) || null;

    if (!UUID_RE.test(typeId)) { req.flash('error_msg', 'Pick a valid leave type.'); return res.redirect('/leave'); }
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) { req.flash('error_msg', 'Enter valid from/to dates.'); return res.redirect('/leave'); }
    if (toDate < fromDate) { req.flash('error_msg', 'To-date cannot be before from-date.'); return res.redirect('/leave'); }

    // Type must exist (need its day_fraction before we can size the request).
    const typeRows = await safe(
        `SELECT leave_type_id, name, annual_quota, day_fraction FROM private.leave_types
          WHERE leave_type_id = $1 AND deleted_at IS NULL`, [typeId], []
    );
    if (!typeRows.length) { req.flash('error_msg', 'That leave type no longer exists.'); return res.redirect('/leave'); }
    const type = typeRows[0];

    // Half-day types (day_fraction < 1) consume a fixed fraction and MUST be a
    // single calendar day; full-day types count inclusive calendar days.
    const dayFraction = Number(type.day_fraction) || 1;
    let days;
    if (dayFraction < 1) {
        if (fromDate !== toDate) { req.flash('error_msg', `${type.name} must be a single day.`); return res.redirect('/leave'); }
        days = dayFraction;                       // e.g. 0.5
    } else {
        days = inclusiveDays(fromDate, toDate);
        if (days <= 0 || days > 366) { req.flash('error_msg', 'Leave span looks invalid.'); return res.redirect('/leave'); }
    }

    // Overlap guard — reject if it overlaps an existing pending/approved request.
    const overlap = await safe(
        `SELECT 1 FROM private.leave_requests
          WHERE employee_id = $1 AND deleted_at IS NULL
            AND status IN ('pending','approved')
            AND from_date <= $3::date AND to_date >= $2::date
          LIMIT 1`,
        [empId, fromDate, toDate], []
    );
    if (overlap.length) { req.flash('error_msg', 'You already have a pending/approved leave overlapping those dates.'); return res.redirect('/leave'); }

    // Balance guard — approved days this year + this request must fit the quota.
    const usedRow = await safe(
        `SELECT COALESCE(SUM(days),0)::numeric AS used FROM private.leave_requests
          WHERE employee_id = $1 AND leave_type_id = $2 AND status = 'approved'
            AND deleted_at IS NULL
            AND EXTRACT(YEAR FROM from_date) = EXTRACT(YEAR FROM $3::date)`,
        [empId, typeId, fromDate], [{ used: 0 }]
    );
    const used = Number(usedRow[0].used) || 0;
    const remaining = Number(type.annual_quota) - used;
    if (days > remaining) {
        req.flash('error_msg', `Insufficient ${type.name} balance: ${remaining} day(s) left, you requested ${days}.`);
        return res.redirect('/leave');
    }

    const client = await pool.connect();
    let requestId = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_leave');
        const ins = await client.query(
            `INSERT INTO private.leave_requests
                (employee_id, leave_type_id, from_date, to_date, days, reason, status)
             VALUES ($1, $2, $3::date, $4::date, $5, $6, 'pending')
             RETURNING request_id`,
            [empId, typeId, fromDate, toDate, days, reason]
        );
        requestId = ins.rows[0].request_id;
        await client.query('RELEASE SAVEPOINT sp_leave');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[leave] insert failed:', err.message);
        req.flash('error_msg', 'Could not submit leave request — see server log.');
        return res.redirect('/leave');
    } finally {
        client.release();
    }

    try {
        await logFromRequest(req, {
            entityType: 'leave_request', entityId: requestId, action: 'create',
            newValue: `${type.name} ${fromDate}→${toDate} (${days}d)`,
            notes: `${req.session.user.name} requested ${type.name} leave`,
        });
    } catch (e) { /* logging never blocks */ }

    req.flash('success_msg', `${type.name} leave requested for ${days} day(s) — pending approval.`);
    return res.redirect('/leave');
});

module.exports = router;
