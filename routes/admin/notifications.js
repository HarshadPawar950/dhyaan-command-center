// =====================================================================
// routes/admin/notifications.js — NOTIFICATION ENGINE (admin + super admin)
// Mount: app.use('/admin', adminNotificationsRoutes)
// Routes:
//   GET /admin/notifications  -> live aggregated alert center
// Blueprint: "Alerts for overdue tasks, approval requests, hot leads,
//             missed follow-ups, site visits and closure updates."
// Derived/live-query design: alerts computed on load from source tables,
// so they're always accurate and never go stale. No notifications table.
// Also exports buildNotifications() for the topbar bell badge.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const ejs = require('ejs');
const path = require('path');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/notifications] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

async function renderPartial(name, data) {
    try {
        return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data);
    } catch (e) {
        console.error('partial ' + name + ' failed:', e.message);
        return '';
    }
}

// -------------------------------------------------------------------
// Core aggregator — returns grouped alert buckets.
// Exported so the topbar bell can reuse the count.
// -------------------------------------------------------------------
async function buildNotifications() {
    // 1. Overdue follow-ups
    const overdueFollowups = await safe(
        `SELECT f.follow_up_id, l.name AS lead_name, f.next_action, f.next_followup_date
           FROM private.follow_ups f
           LEFT JOIN private.leads l ON l.lead_id = f.lead_id
          WHERE f.deleted_at IS NULL AND f.outcome = 'pending'
            AND f.next_followup_date < CURRENT_DATE
          ORDER BY f.next_followup_date ASC`,
        [], []
    );

    // 2. Follow-ups due today
    const dueTodayFollowups = await safe(
        `SELECT f.follow_up_id, l.name AS lead_name, f.next_action
           FROM private.follow_ups f
           LEFT JOIN private.leads l ON l.lead_id = f.lead_id
          WHERE f.deleted_at IS NULL AND f.outcome = 'pending'
            AND f.next_followup_date = CURRENT_DATE`,
        [], []
    );

    // 3. Pending approvals (waiting on super admin)
    const pendingApprovals = await safe(
        `SELECT approval_id, action_type, target_label, requested_by_name, created_at
           FROM private.approvals
          WHERE status = 'pending'
          ORDER BY created_at DESC`,
        [], []
    );

    // 4. Hot leads with no future action set (need attention)
    const hotLeads = await safe(
        `SELECT lead_id, name, phone, next_action, next_action_date
           FROM private.leads
          WHERE deleted_at IS NULL AND status = 'hot'
            AND (next_action_date IS NULL OR next_action_date < CURRENT_DATE)
          ORDER BY created_at DESC`,
        [], []
    );

    // 5. Site visits scheduled today
    const visitsToday = await safe(
        `SELECT sv.visit_id, l.name AS lead_name, sv.scheduled_at, sv.status::text AS status
           FROM private.site_visits sv
           LEFT JOIN private.leads l ON l.lead_id = sv.lead_id
          WHERE sv.deleted_at IS NULL
            AND sv.scheduled_at::date = CURRENT_DATE
          ORDER BY sv.scheduled_at ASC`,
        [], []
    );

    // 6. Inactive employees — no login in 3+ days (from history_log)
    //    Active employees whose most recent 'login' event is older than
    //    3 days, OR who have never logged in at all.
    const inactiveEmployees = await safe(
        `SELECT e.external_id, e.name, MAX(h.created_at) AS last_login
           FROM private.employees e
           LEFT JOIN private.history_log h
             ON h.changed_by_code = e.external_id
            AND LOWER(h.action) = 'login'
          WHERE e.status = 'active'::private.employee_status
       GROUP BY e.external_id, e.name
         HAVING MAX(h.created_at) IS NULL
             OR MAX(h.created_at) < NOW() - INTERVAL '3 days'
       ORDER BY MAX(h.created_at) ASC NULLS FIRST`,
        [], []
    );

    // 7. Today's closures — leads converted or lost today (closed_at stamp)
    const closuresToday = await safe(
        `SELECT lead_id,
                COALESCE(external_id, '') AS external_id,
                name,
                status::text AS status,
                closed_at
           FROM private.leads
          WHERE deleted_at IS NULL
            AND status::text IN ('converted', 'lost')
            AND closed_at::date = CURRENT_DATE
          ORDER BY closed_at DESC`,
        [], []
    );

    // 8. Legal documents expiring within 30 days OR already past expiry while not
    //    yet marked 'expired' (an unmarked expired NOC is MORE urgent). Flagged.
    const legalExpiry = await safe(
        `SELECT doc_id, entity_type, doc_kind, party, expiry_date, status,
                CASE WHEN expiry_date < CURRENT_DATE THEN 'expired' ELSE 'expiring' END AS urgency
           FROM private.legal_documents
          WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND status <> 'expired'
            AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY expiry_date ASC`,
        [], []
    );

    const groups = [
        { key: 'legal_expiry', icon: 'document', title: 'Legal Docs Expiring / Overdue', tone: 'amber',
          link: '/admin/legal', items: legalExpiry },
        { key: 'overdue', icon: 'overdue', title: 'Overdue Follow-Ups', tone: 'red',
          link: '/admin/follow-ups', items: overdueFollowups },
        { key: 'due_today', icon: 'clock', title: 'Follow-Ups Due Today', tone: 'amber',
          link: '/admin/follow-ups', items: dueTodayFollowups },
        { key: 'approvals', icon: 'approval', title: 'Pending Approvals', tone: 'blue',
          link: '/admin/approvals', items: pendingApprovals },
        { key: 'hot', icon: 'fire', title: 'Hot Leads Need Action', tone: 'red',
          link: '/admin/leads', items: hotLeads },
        { key: 'visits', icon: 'pin', title: 'Site Visits Today', tone: 'green',
          link: '/admin/site-visits', items: visitsToday },
        { key: 'inactive', icon: 'user', title: 'Inactive Employees (3+ Days)', tone: 'amber',
          link: '/admin/employees', items: inactiveEmployees },
        { key: 'closures', icon: 'check', title: "Today's Closures", tone: 'green',
          link: '/admin/leads', items: closuresToday }
    ];

    const total = groups.reduce((sum, g) => sum + g.items.length, 0);
    return { groups, total };
}

// -------------------------------------------------------------------
// GET /admin/notifications
// -------------------------------------------------------------------
router.get('/notifications', ensureAdmin, async (req, res) => {
    const { groups, total } = await buildNotifications();

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Notifications' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Notifications' });

    res.render('admin/notifications', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Notification Center',
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        groups,
        total
    });
});

module.exports = router;
module.exports.buildNotifications = buildNotifications;
