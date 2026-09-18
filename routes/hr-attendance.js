// =====================================================================
// routes/hr-attendance.js — HR attendance month grid + mark flow
// Mount: app.use('/hr', require('./routes/hr-attendance'))  (after routes/hr.js)
//   GET  /hr/attendance?month=YYYY-MM -> per-employee month grid (present /
//        absent / leave-approved merged) + month summary counts
//   POST /hr/attendance/mark          -> mark an employee's day present/absent
// ensureRole('hr_manager'). Real staff only (E[0-9]{3,}).
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[hr-attendance] query failed:', err.message); return fallback; }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', 'views', 'hr', 'layout', name + '.ejs'), data); }
    catch (e) { console.error('[hr-attendance] partial ' + name + ' failed:', e.message); return ''; }
}
async function shell(req, pageTitle) {
    const data = { user: req.session.user, pageTitle };
    return {
        sidebarHtml: await renderPartial('sidebar', data),
        topbarHtml: await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', 'topbar.ejs'), data),
    };
}
function monthToFirst(mm) {
    if (!/^\d{4}-\d{2}$/.test(mm)) return null;
    const [y, m] = mm.split('-').map(Number);
    if (m < 1 || m > 12 || y < 2000 || y > 2100) return null;
    return `${mm}-01`;
}
function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

// Pure merge: per-employee per-day status. Explicit attendance row wins; else an
// approved-leave day is 'leave'; else unmarked. Returns rows with cells + summary.
// attMap: emp -> { 'YYYY-MM-DD': status }.  leaveMap: emp -> Set('YYYY-MM-DD').
function computeRows(employees, attMap, leaveMap, year, month, daysInMonth) {
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    return employees.map(e => {
        const cells = days.map(day => {
            const ds = ymd(year, month, day);
            const a = attMap[e.employee_id] && attMap[e.employee_id][ds];
            if (a) return { day, ds, status: a };
            if (leaveMap[e.employee_id] && leaveMap[e.employee_id].has(ds)) return { day, ds, status: 'leave' };
            return { day, ds, status: '' };
        });
        const summary = cells.reduce((s, c) => {
            if (c.status === 'present') s.present++;
            else if (c.status === 'absent') s.absent++;
            else if (c.status === 'leave') s.leave++;
            return s;
        }, { present: 0, absent: 0, leave: 0 });
        return { employee_id: e.employee_id, external_id: e.external_id, name: e.name, cells, summary };
    });
}

// ---------------------------------------------------------------------
// GET /hr/attendance — month grid
// ---------------------------------------------------------------------
router.get('/attendance', ensureHr, async (req, res) => {
    const mmRaw = (req.query.month || '').trim();
    const mm = monthToFirst(mmRaw) ? mmRaw : currentMonth();
    const [year, month] = mm.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${mm}-01`;
    const monthEnd = ymd(year, month, daysInMonth);

    const employees = await safe(
        `SELECT employee_id, external_id, name FROM private.employees
          WHERE status='active' AND external_id ~ '^E[0-9]{3,}$' AND email NOT LIKE '%@dhyaan.local' ORDER BY external_id`, [], []
    );

    // Attendance rows in the month.
    const att = await safe(
        `SELECT employee_id, to_char(date,'YYYY-MM-DD') AS d, COALESCE(status,'present') AS status
           FROM private.attendance
          WHERE date >= $1::date AND date <= $2::date AND deleted_at IS NULL`,
        [monthStart, monthEnd], []
    );
    const attMap = {};   // emp -> { 'YYYY-MM-DD': status }
    att.forEach(r => { (attMap[r.employee_id] = attMap[r.employee_id] || {})[r.d] = r.status; });

    // Approved leaves overlapping the month.
    const leaves = await safe(
        `SELECT employee_id, to_char(from_date,'YYYY-MM-DD') AS f, to_char(to_date,'YYYY-MM-DD') AS t
           FROM private.leave_requests
          WHERE status='approved' AND deleted_at IS NULL
            AND from_date <= $2::date AND to_date >= $1::date`,
        [monthStart, monthEnd], []
    );
    const leaveMap = {};   // emp -> Set of 'YYYY-MM-DD'
    leaves.forEach(l => {
        const set = leaveMap[l.employee_id] = leaveMap[l.employee_id] || new Set();
        for (let day = 1; day <= daysInMonth; day++) {
            const ds = ymd(year, month, day);
            if (ds >= l.f && ds <= l.t) set.add(ds);
        }
    });

    // Build each employee's per-day status + summary (explicit attendance wins).
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    const rows = computeRows(employees, attMap, leaveMap, year, month, daysInMonth);

    const { sidebarHtml, topbarHtml } = await shell(req, 'Attendance');
    res.render('hr/attendance', {
        pageTitle: 'Attendance', user: req.session.user,
        sidebarHtml, topbarHtml,
        month: mm, days, rows, employees, daysInMonth,
        messages: { success: req.flash('success_msg'), error: req.flash('error_msg') },
    });
});

// ---------------------------------------------------------------------
// POST /hr/attendance/mark — mark a day present/absent
// ---------------------------------------------------------------------
router.post('/attendance/mark', ensureHr, async (req, res) => {
    const empId = (req.body.employee_id || '').trim();
    const date = (req.body.date || '').trim();
    const status = (req.body.status || '').trim();
    const backMonth = (date.match(/^(\d{4}-\d{2})/) || [])[1] || currentMonth();
    const back = () => res.redirect('/hr/attendance?month=' + encodeURIComponent(backMonth));

    if (!UUID_RE.test(empId) || !DATE_RE.test(date) || !['present', 'absent'].includes(status)) {
        req.flash('error_msg', 'Pick an employee, a valid date, and present/absent.'); return back();
    }
    // Employee must be real active staff.
    const ok = await safe(
        `SELECT 1 FROM private.employees WHERE employee_id=$1 AND status='active' AND external_id ~ '^E[0-9]{3,}$' AND email NOT LIKE '%@dhyaan.local'`,
        [empId], []
    );
    if (!ok.length) { req.flash('error_msg', 'Not a valid staff member.'); return back(); }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_att');
        await client.query(
            `INSERT INTO private.attendance (attendance_id, employee_id, date, status, created_at)
             VALUES (gen_random_uuid(), $1, $2::date, $3, NOW())
             ON CONFLICT (employee_id, date) DO UPDATE
                SET status = EXCLUDED.status, deleted_at = NULL`,   // re-mark revives a cleared day
            [empId, date, status]
        );
        await client.query('RELEASE SAVEPOINT sp_att');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-attendance] mark failed:', err.message);
        req.flash('error_msg', 'Could not mark attendance — see server log.');
        return back();
    } finally { client.release(); }

    try {
        await logFromRequest(req, {
            entityType: 'attendance', entityId: empId, action: 'mark',
            fieldName: 'status', newValue: status, notes: `${date} marked ${status} by ${req.session.user.name}`,
        });
    } catch (e) { /* logging never blocks */ }
    req.flash('success_msg', `Marked ${status} for ${date}.`);
    return back();
});

// ---------------------------------------------------------------------
// POST /hr/attendance/clear — SOFT-DELETE an attendance entry (Δ9)
// Removes a marked day (employee + date). deleted_at set; row kept for audit.
// ---------------------------------------------------------------------
router.post('/attendance/clear', ensureHr, async (req, res) => {
    const empId = (req.body.employee_id || '').trim();
    const date = (req.body.date || '').trim();
    const backMonth = (date.match(/^(\d{4}-\d{2})/) || [])[1] || currentMonth();
    const back = () => res.redirect('/hr/attendance?month=' + encodeURIComponent(backMonth));

    if (!UUID_RE.test(empId) || !DATE_RE.test(date)) {
        req.flash('error_msg', 'Pick an employee and a valid date to clear.'); return back();
    }

    let removed = 0;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_clear');
        const r = await client.query(
            `UPDATE private.attendance SET deleted_at = NOW()
              WHERE employee_id = $1 AND date = $2::date AND deleted_at IS NULL`,
            [empId, date]
        );
        removed = r.rowCount || 0;
        await client.query('RELEASE SAVEPOINT sp_clear');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-attendance] clear failed:', err.message);
        req.flash('error_msg', 'Could not clear the entry — see server log.');
        return back();
    } finally { client.release(); }

    if (removed) {
        try {
            await logFromRequest(req, {
                entityType: 'attendance', entityId: empId, action: 'clear',
                fieldName: 'deleted_at', newValue: 'removed',
                notes: `${date} attendance cleared (soft-delete) by ${req.session.user.name}`,
            });
        } catch (e) { /* logging never blocks */ }
        req.flash('success_msg', `Cleared the attendance entry for ${date}.`);
    } else {
        req.flash('error_msg', `No marked attendance to clear on ${date}.`);
    }
    return back();
});

module.exports = router;
module.exports.computeRows = computeRows;   // exposed for unit tests
