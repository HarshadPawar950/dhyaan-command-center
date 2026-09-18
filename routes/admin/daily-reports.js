// =====================================================================
// routes/admin/daily-reports.js — admin evening-report grid + weekly
// Mount: app.use('/admin', require('./routes/admin/daily-reports'))
//   GET /admin/reports/daily?date=YYYY-MM-DD  -> grid of the 6 active real
//       staff x self-reported numbers (NOT-SUBMITTED highlighted) with the
//       SYSTEM-counted truth beside each, + a Mon-Sun weekly totals table.
// ensureAdmin + reports.view. Real staff only (E[0-9]{3,}).
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[admin/daily-reports] query failed:', err.message); return fallback; }
}
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function validDate(s) {
    if (!DATE_RE.test(s || '')) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : s;
}

router.get('/reports/daily', ensureAdmin, ensurePermission('reports.view'), async (req, res) => {
    const date = validDate(req.query.date) || today();

    // Daily grid — every active real exec, their report (or null) + system truth.
    const rows = await safe(
        `SELECT e.employee_id, e.name, e.external_id,
                dr.calls_made, dr.followups_done, dr.visits_done, dr.new_leads,
                dr.notes, dr.submitted_at, dr.updated_at,
                (dr.report_id IS NOT NULL) AS submitted,
                (SELECT COUNT(*)::int FROM private.follow_ups f
                   WHERE f.employee_id = e.employee_id AND f.deleted_at IS NULL
                     AND f.created_at::date = $1::date) AS sys_followups,
                (SELECT COUNT(*)::int FROM private.site_visits sv
                   WHERE sv.employee_id = e.employee_id AND sv.deleted_at IS NULL
                     AND sv.scheduled_at::date = $1::date
                     AND sv.status IN ('completed','booked')) AS sys_visits,
                (SELECT COUNT(*)::int FROM private.assignments a
                   WHERE a.employee_id = e.employee_id AND a.assigned_at::date = $1::date) AS sys_new_leads
           FROM private.employees e
           LEFT JOIN private.daily_reports dr
                  ON dr.employee_id = e.employee_id AND dr.report_date = $1::date AND dr.deleted_at IS NULL
          WHERE e.status = 'active' AND e.external_id ~ '^E[0-9]{3,}$'
            AND e.email NOT LIKE '%@dhyaan.local'
          ORDER BY e.external_id`,
        [date], []
    );

    // Weekly totals — Mon-Sun of the week containing the selected date.
    const weekly = await safe(
        `SELECT e.name, e.external_id,
                COALESCE(SUM(dr.calls_made), 0)::int     AS calls,
                COALESCE(SUM(dr.followups_done), 0)::int AS followups,
                COALESCE(SUM(dr.visits_done), 0)::int    AS visits,
                COALESCE(SUM(dr.new_leads), 0)::int      AS new_leads,
                COUNT(dr.report_id)::int                 AS days_submitted
           FROM private.employees e
           LEFT JOIN private.daily_reports dr
                  ON dr.employee_id = e.employee_id AND dr.deleted_at IS NULL
                 AND dr.report_date >= date_trunc('week', $1::date)::date
                 AND dr.report_date <= (date_trunc('week', $1::date) + INTERVAL '6 days')::date
          WHERE e.status = 'active' AND e.external_id ~ '^E[0-9]{3,}$'
            AND e.email NOT LIKE '%@dhyaan.local'
          GROUP BY e.name, e.external_id
          ORDER BY e.external_id`,
        [date], []
    );

    const weekRow = await safe(
        `SELECT to_char(date_trunc('week', $1::date), 'YYYY-MM-DD') AS ws,
                to_char(date_trunc('week', $1::date) + INTERVAL '6 days', 'YYYY-MM-DD') AS we`,
        [date], [{ ws: date, we: date }]
    );

    const submittedCount = rows.filter(r => r.submitted).length;

    // Shame-free highlighting: red for a missing report ONLY on a past date, or on
    // TODAY once it's past 8 PM (a 2 PM view of today shouldn't flag anyone yet).
    const now = new Date();
    const todayStr = today();
    const highlightMissing = (date < todayStr) || (date === todayStr && now.getHours() >= 20);

    return res.render('admin/daily-reports', {
        pageTitle: 'Daily Reports',
        user: req.session.user,
        date, rows, weekly,
        weekStart: weekRow[0].ws, weekEnd: weekRow[0].we,
        submittedCount, total: rows.length,
        highlightMissing,
    });
});

module.exports = router;
