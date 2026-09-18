// =====================================================================
// routes/reports.js — EMPLOYEE evening report submit
// Mount: app.use('/reports', require('./routes/reports'))
//   POST /reports/daily -> upsert TODAY's report (report_date = CURRENT_DATE,
//                          server-side, so a past day can never be edited).
// ensureAuthenticated; strictly self + today. Same-day edits allowed and
// history-logged (old->new). Duplicate-day blocked by the partial unique index.
// The "Today's Report" card itself lives on /dashboard.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { logFromRequest } = require('../middleware/historyLogger');
const { homeFor } = require('../lib/navHome');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function myEmployeeId(user) {
    const cand = (user && (user.employee_id || user.id)) || null;
    return cand && UUID_RE.test(String(cand)) ? cand : null;
}
const numI = v => Math.max(0, Math.floor(Number(v) || 0));

router.post('/daily', ensureAuthenticated, async (req, res) => {
    const empId = myEmployeeId(req.session.user);
    if (!empId) { req.flash('error_msg', 'Could not resolve your employee record.'); return res.redirect(homeFor(req.session.user)); }

    const vals = {
        calls_made: numI(req.body.calls_made),
        followups_done: numI(req.body.followups_done),
        visits_done: numI(req.body.visits_done),
        new_leads: numI(req.body.new_leads),
        notes: (req.body.notes || '').trim().slice(0, 1000) || null,
    };

    const client = await pool.connect();
    let existed = false, oldRow = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_report');

        // Lock today's row if it exists (own report — serialises a double-submit).
        const cur = await client.query(
            `SELECT calls_made, followups_done, visits_done, new_leads, notes
               FROM private.daily_reports
              WHERE employee_id = $1 AND report_date = CURRENT_DATE AND deleted_at IS NULL
              FOR UPDATE`,
            [empId]
        );
        if (cur.rows.length) { existed = true; oldRow = cur.rows[0]; }

        // report_date is ALWAYS CURRENT_DATE — a past day can never be targeted.
        await client.query(
            `INSERT INTO private.daily_reports
                (employee_id, report_date, calls_made, followups_done, visits_done, new_leads, notes, submitted_at)
             VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (employee_id, report_date) WHERE deleted_at IS NULL
             DO UPDATE SET calls_made=EXCLUDED.calls_made, followups_done=EXCLUDED.followups_done,
                           visits_done=EXCLUDED.visits_done, new_leads=EXCLUDED.new_leads,
                           notes=EXCLUDED.notes, updated_at=NOW()`,
            [empId, vals.calls_made, vals.followups_done, vals.visits_done, vals.new_leads, vals.notes]
        );

        await client.query('RELEASE SAVEPOINT sp_report');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[reports/daily] failed:', err.message);
        req.flash('error_msg', 'Could not save your report — see server log.');
        return res.redirect(homeFor(req.session.user));
    } finally {
        client.release();
    }

    // History: on an edit, log each changed field old->new; on first submit, a create.
    try {
        if (existed && oldRow) {
            const fields = ['calls_made', 'followups_done', 'visits_done', 'new_leads', 'notes'];
            for (const f of fields) {
                const oldV = oldRow[f] === null || oldRow[f] === undefined ? '' : String(oldRow[f]);
                const newV = vals[f] === null || vals[f] === undefined ? '' : String(vals[f]);
                if (oldV !== newV) {
                    await logFromRequest(req, {
                        entityType: 'daily_report', entityId: empId, action: 'update',
                        fieldName: f, oldValue: oldV, newValue: newV,
                        notes: `Daily report edited (${req.session.user.name})`,
                    });
                }
            }
        } else {
            await logFromRequest(req, {
                entityType: 'daily_report', entityId: empId, action: 'create',
                notes: `Daily report submitted by ${req.session.user.name}`,
            });
        }
    } catch (e) { /* logging never blocks */ }

    req.flash('success_msg', existed ? 'Today\'s report updated.' : 'Today\'s report submitted.');
    return res.redirect(homeFor(req.session.user));
});

module.exports = router;
