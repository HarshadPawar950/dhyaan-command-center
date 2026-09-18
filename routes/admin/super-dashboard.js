// =====================================================================
// routes/admin/super-dashboard.js — SUPER ADMIN god-view (boss only)
// Mount: app.use('/admin', adminSuperRoutes)  ->  GET /admin/super
// Pattern matches routes/admin/dashboard.js : pool direct + safe() helper
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');

// same crash-proof helper used in dashboard.js
async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/super] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

router.get('/super', ensureSuperAdmin, async (req, res) => {

    // ---- Pending approvals (live badge) ----
    const pendingApprovals = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.approvals
          WHERE status = 'pending'`,
        [],
        [{ c: 0 }]
    );

    // ---- Trash bin: soft-deleted across all entities ----
    const trashLeads = await safe(
        `SELECT COUNT(*)::int AS c FROM private.leads WHERE deleted_at IS NOT NULL`,
        [], [{ c: 0 }]
    );
    const trashProps = await safe(
        `SELECT COUNT(*)::int AS c FROM private.projects WHERE deleted_at IS NOT NULL`,
        [], [{ c: 0 }]
    );
    const trashUnits = await safe(
        `SELECT COUNT(*)::int AS c FROM private.properties WHERE deleted_at IS NOT NULL`,
        [], [{ c: 0 }]
    );
    const trashVisits = await safe(
        `SELECT COUNT(*)::int AS c FROM private.site_visits WHERE deleted_at IS NOT NULL`,
        [], [{ c: 0 }]
    );
    const trashTotal =
        (trashLeads[0].c || 0) + (trashProps[0].c || 0) +
        (trashUnits[0].c || 0) + (trashVisits[0].c || 0);

    // ---- Today's activity ----
    const todayActivity = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.history_log
          WHERE created_at::date = CURRENT_DATE`,
        [], [{ c: 0 }]
    );

    // ---- Team breakdown by role ----
    const teamBreakdown = await safe(
        `SELECT
            COALESCE(access_role, 'employee') AS role,
            COUNT(*)::int AS c
           FROM private.employees
          WHERE status = 'active'::private.employee_status
          GROUP BY COALESCE(access_role, 'employee')
          ORDER BY c DESC`,
        [], []
    );
    const teamTotal = teamBreakdown.reduce((sum, r) => sum + (r.c || 0), 0);

    // ---- Recent approval decisions (last 5) ----
    const recentApprovals = await safe(
        `SELECT approval_id, action_type, target_label, status, requested_by_name, created_at
           FROM private.approvals
          ORDER BY created_at DESC
          LIMIT 5`,
        [], []
    );

    // ---- System health: DB ping ----
    const dbPing = await safe(`SELECT 1 AS ok`, [], []);
    const dbHealthy = dbPing.length > 0;

    res.render('admin/super-dashboard', {
        pageTitle: 'Super Admin',
        user: req.session.user,
        stats: {
            pendingApprovals: pendingApprovals[0].c,
            trashTotal,
            trashLeads: trashLeads[0].c,
            trashProps: trashProps[0].c,
            trashUnits: trashUnits[0].c,
            trashVisits: trashVisits[0].c,
            todayActivity: todayActivity[0].c,
            teamTotal,
            dbHealthy
        },
        teamBreakdown,
        recentApprovals
    });
});

// =====================================================================
// TRASH & RECOVERY  (boss only)
// =====================================================================
const TRASH_MAP = {
    lead:     { table: 'private.leads',          pk: 'lead_id'     },
    property: { table: 'private.projects',     pk: 'project_id' },
    unit:     { table: 'private.properties', pk: 'property_id'     },
    visit:    { table: 'private.site_visits',    pk: 'visit_id'    }
};

router.get('/super/trash', ensureSuperAdmin, async (req, res) => {

    const leads = await safe(
        `SELECT lead_id AS id, name AS label, deleted_at
           FROM private.leads
          WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC`,
        [], []
    );

    const properties = await safe(
        `SELECT project_id AS id, title AS label, deleted_at
           FROM private.projects
          WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC`,
        [], []
    );

    const units = await safe(
        `SELECT u.property_id AS id,
                COALESCE(p.title, 'Property #' || u.project_id::text) AS label,
                u.deleted_at
           FROM private.properties u
           LEFT JOIN private.projects p ON p.project_id = u.project_id
          WHERE u.deleted_at IS NOT NULL
          ORDER BY u.deleted_at DESC`,
        [], []
    );

    const visits = await safe(
        `SELECT v.visit_id AS id,
                COALESCE(l.name, 'Lead #' || v.lead_id::text) AS label,
                v.deleted_at
           FROM private.site_visits v
           LEFT JOIN private.leads l ON l.lead_id = v.lead_id
          WHERE v.deleted_at IS NOT NULL
          ORDER BY v.deleted_at DESC`,
        [], []
    );

    res.render('admin/super-trash', {
        pageTitle: 'Trash & Recovery',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        groups: [
            { type: 'lead',     icon: '&#128100;', title: 'Leads',          rows: leads },
            { type: 'property', icon: '&#127968;', title: 'Properties',     rows: properties },
            { type: 'unit',     icon: '&#127970;', title: 'Property Units', rows: units },
            { type: 'visit',    icon: '&#128197;', title: 'Site Visits',    rows: visits }
        ],
        totalTrash: leads.length + properties.length + units.length + visits.length
    });
});

router.post('/super/trash/restore', ensureSuperAdmin, async (req, res) => {
    const { type, id } = req.body;
    const map = TRASH_MAP[type];

    if (!map || !id) {
        req.flash('error', 'Invalid restore request.');
        return res.redirect('/admin/super/trash');
    }

    try {
        await pool.query(
            `UPDATE ${map.table} SET deleted_at = NULL WHERE ${map.pk} = $1`,
            [id]
        );

        await pool.query(
            `INSERT INTO private.history_log (entity_type, action, changed_by_name, notes, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [type, 'restore', (req.session.user && req.session.user.name) || 'Super Admin',
             `Restored ${type} #${id} from trash`]
        );

        req.flash('success', `${type.charAt(0).toUpperCase() + type.slice(1)} restored successfully.`);
    } catch (err) {
        console.error('[admin/super/trash/restore] failed:', err.message);
        req.flash('error', 'Restore failed — see server log.');
    }

    res.redirect('/admin/super/trash');
});

// =====================================================================
// AUDIT LOG VIEWER  (boss only)
// GET /admin/super/audit  -> searchable/filterable history_log
// Query params: entity, action, user, q (notes search), from, to, page
// =====================================================================
router.get('/super/audit', ensureSuperAdmin, async (req, res) => {
    const PER_PAGE = 25;
    let page = parseInt(req.query.page, 10);
    if (!page || page < 1) page = 1;
    const offset = (page - 1) * PER_PAGE;

    // sanitize filters
    const fEntity = (req.query.entity || '').trim();
    const fAction = (req.query.action || '').trim();
    const fUser   = (req.query.user || '').trim();
    const fQ      = (req.query.q || '').trim();
    const fFrom   = (req.query.from || '').trim();
    const fTo     = (req.query.to || '').trim();

    // build dynamic WHERE with parameterised values
    const where = [];
    const params = [];
    let i = 1;
    if (fEntity) { where.push(`entity_type = $${i++}`); params.push(fEntity); }
    if (fAction) { where.push(`action = $${i++}`); params.push(fAction); }
    if (fUser)   { where.push(`changed_by_name = $${i++}`); params.push(fUser); }
    if (fQ)      { where.push(`notes ILIKE $${i++}`); params.push('%' + fQ + '%'); }
    if (fFrom)   { where.push(`created_at >= $${i++}`); params.push(fFrom); }
    if (fTo)     { where.push(`created_at <= ($${i++}::date + INTERVAL '1 day')`); params.push(fTo); }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    // total count for pagination
    const countRows = await safe(
        `SELECT COUNT(*)::int AS c FROM private.history_log ${whereSql}`,
        params, [{ c: 0 }]
    );
    const totalRows = countRows[0].c;
    const totalPages = Math.max(1, Math.ceil(totalRows / PER_PAGE));

    // page of rows
    const rows = await safe(
        `SELECT id, entity_type, entity_id, action, field_name, old_value, new_value,
                changed_by_name, changed_by_role, ip_address, notes, created_at
           FROM private.history_log
           ${whereSql}
          ORDER BY created_at DESC
          LIMIT ${PER_PAGE} OFFSET ${offset}`,
        params, []
    );

    // distinct values for filter dropdowns
    const entityOpts = await safe(
        `SELECT DISTINCT entity_type AS v FROM private.history_log
          WHERE entity_type IS NOT NULL ORDER BY entity_type`, [], []
    );
    const actionOpts = await safe(
        `SELECT DISTINCT action AS v FROM private.history_log
          WHERE action IS NOT NULL ORDER BY action`, [], []
    );
    const userOpts = await safe(
        `SELECT DISTINCT changed_by_name AS v FROM private.history_log
          WHERE changed_by_name IS NOT NULL ORDER BY changed_by_name`, [], []
    );

    res.render('admin/super-audit', {
        pageTitle: 'Audit Log',
        user: req.session.user,
        rows,
        entityOpts: entityOpts.map(r => r.v),
        actionOpts: actionOpts.map(r => r.v),
        userOpts: userOpts.map(r => r.v),
        filters: { entity: fEntity, action: fAction, user: fUser, q: fQ, from: fFrom, to: fTo },
        page, totalPages, totalRows, perPage: PER_PAGE
    });
});

module.exports = router;
