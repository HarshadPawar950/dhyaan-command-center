// =====================================================================
// routes/admin/follow-ups.js — FOLLOW-UP ENGINE (admin + super admin)
// Mount: app.use('/admin', adminFollowUpsRoutes)
// Routes:
//   GET  /admin/follow-ups            -> list all follow-ups, overdue-first
//   GET  /admin/follow-ups/new        -> log-a-follow-up form (lead picker)
//   POST /admin/follow-ups/new        -> create follow-up (SAVEPOINT) + sync lead next_action
//   POST /admin/follow-ups/complete/:id -> mark outcome = completed
// Blueprint: "Every interaction requires next action and next follow-up date.
//             Overdue follow-ups trigger alerts."
// Soft-delete only. private. schema throughout.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const ejs = require('ejs');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// safe query wrapper
async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/follow-ups] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// render a layout partial to an HTML string (nuclear include-bypass pattern)
async function renderPartial(name, data) {
    try {
        return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data);
    } catch (e) {
        console.error('partial ' + name + ' failed:', e.message);
        return '';
    }
}

// ---------------------------------------------------------------------
// LIST — all follow-ups, overdue-first
// ---------------------------------------------------------------------
router.get('/follow-ups', ensureAdmin, async (req, res) => {
    const rows = await safe(
        `SELECT f.follow_up_id, f.action_taken, f.next_action, f.next_followup_date,
                f.outcome::text AS outcome, f.notes, f.created_at,
                l.name AS lead_name, l.lead_id, l.status::text AS lead_status,
                e.name AS employee_name,
                CASE WHEN f.outcome = 'pending' AND f.next_followup_date < CURRENT_DATE
                     THEN true ELSE false END AS is_overdue
           FROM private.follow_ups f
           LEFT JOIN private.leads l ON l.lead_id = f.lead_id
           LEFT JOIN private.employees e ON e.employee_id = f.employee_id
          WHERE f.deleted_at IS NULL
          ORDER BY is_overdue DESC, f.next_followup_date ASC NULLS LAST, f.created_at DESC`,
        [], []
    );

    const summaryRow = await safe(
        `SELECT
            COUNT(*) FILTER (WHERE outcome = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE outcome = 'pending' AND next_followup_date < CURRENT_DATE)::int AS overdue,
            COUNT(*) FILTER (WHERE outcome = 'pending' AND next_followup_date = CURRENT_DATE)::int AS due_today,
            COUNT(*) FILTER (WHERE outcome = 'completed')::int AS completed
           FROM private.follow_ups WHERE deleted_at IS NULL`,
        [], [{ pending: 0, overdue: 0, due_today: 0, completed: 0 }]
    );

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Follow-Ups' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Follow-Ups' });

    res.render('admin/follow-ups', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Follow-Up Engine',
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        followups: rows,
        summary: summaryRow[0],
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// NEW (form) — pick a lead, log a follow-up
// ---------------------------------------------------------------------
router.get('/follow-ups/new', ensureAdmin, async (req, res) => {
    // active leads only (not converted/lost) for the picker
    const leads = await safe(
        `SELECT lead_id, name, phone, status::text AS status, next_action, next_action_date
           FROM private.leads
          WHERE deleted_at IS NULL AND status NOT IN ('converted','lost')
          ORDER BY name ASC`,
        [], []
    );

    const preLead = req.query.lead && UUID_RE.test(req.query.lead) ? req.query.lead : '';

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Follow-Ups' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Follow-Ups' });

    res.render('admin/follow-up-new', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Log Follow-Up',
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        leads,
        preLead
    });
});

// ---------------------------------------------------------------------
// NEW (create) — SAVEPOINT pattern, also syncs lead.next_action
// ---------------------------------------------------------------------
router.post('/follow-ups/new', ensureAdmin, async (req, res) => {
    const { lead_id, action_taken, next_action, next_followup_date, outcome, notes } = req.body;

    if (!lead_id || !UUID_RE.test(lead_id)) {
        return res.redirect('/admin/follow-ups/new?msg=' + encodeURIComponent('Please select a valid lead'));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_followup');

        const employeeId = req.session.user && req.session.user.employee_id ? req.session.user.employee_id : null;
        const out = ['pending', 'completed', 'rescheduled'].includes(outcome) ? outcome : 'pending';

        await client.query(
            `INSERT INTO private.follow_ups
                (lead_id, employee_id, action_taken, next_action, next_followup_date, outcome, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [lead_id, employeeId, action_taken || null, next_action || null,
             next_followup_date || null, out, notes || null]
        );

        // sync the lead's "next" pointer (blueprint: every interaction sets next action + date)
        if (next_action || next_followup_date) {
            await client.query(
                `UPDATE private.leads
                    SET next_action = COALESCE($2, next_action),
                        next_action_date = COALESCE($3, next_action_date)
                  WHERE lead_id = $1`,
                [lead_id, next_action || null, next_followup_date || null]
            );
        }

        await client.query('RELEASE SAVEPOINT sp_followup');
        await client.query('COMMIT');
        res.redirect('/admin/follow-ups?msg=' + encodeURIComponent('Follow-up logged'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/follow-ups] create failed:', err.message);
        res.redirect('/admin/follow-ups/new?msg=' + encodeURIComponent(userSafeError(err, 'Could not log the follow-up. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// COMPLETE — mark a follow-up done
// ---------------------------------------------------------------------
router.post('/follow-ups/complete/:id', ensureAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/follow-ups?msg=' + encodeURIComponent('Invalid follow-up id'));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_complete');
        await client.query(
            `UPDATE private.follow_ups SET outcome = 'completed' WHERE follow_up_id = $1 AND deleted_at IS NULL`,
            [id]
        );
        await client.query('RELEASE SAVEPOINT sp_complete');
        await client.query('COMMIT');
        res.redirect('/admin/follow-ups?msg=' + encodeURIComponent('Marked complete'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/follow-ups] complete failed:', err.message);
        res.redirect('/admin/follow-ups?msg=' + encodeURIComponent('Could not update'));
    } finally {
        client.release();
    }
});

module.exports = router;
