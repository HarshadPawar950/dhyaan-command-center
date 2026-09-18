// =============================================================
// routes/admin/leads.js
// Day 2 Phase 2 — All Leads admin pages
// Day 6 — soft-delete aware (deleted_at IS NULL filters added)
//
// Routes:
//   GET /admin/leads               → list all leads with filters & search
//   GET /admin/leads/:id           → single lead detail + feedback + history
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { getFirstTouchHours, overdueExpr, FIRST_ASSIGN_LATERAL } = require('../../middleware/sla');
const { runMatches } = require('../../middleware/matcherService');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/leads] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

// safe csrf token (won't crash if csurf not on this route)
function csrf(req) {
    try { return (typeof req.csrfToken === 'function') ? req.csrfToken() : ''; }
    catch (_) { return ''; }
}

// =============================================================
// GET /admin/leads — filterable list of all leads
// =============================================================
router.get('/leads', ensureAdmin, ensurePermission('leads.view_all'), async (req, res) => {

    const f = {
        status:     (req.query.status     || '').trim().toLowerCase(),
        location:   (req.query.location   || '').trim(),
        source:     (req.query.source     || '').trim(),
        employee:   (req.query.employee   || '').trim(),
        q:          (req.query.q          || '').trim(),
        unassigned: req.query.unassigned === '1',
    };

    // Day 6: deleted_at IS NULL is ALWAYS the first condition (hide soft-deleted)
    const conds = ['l.deleted_at IS NULL'];
    const params = [];
    let i = 1;

    if (f.status) {
        conds.push(`LOWER(l.status::text) = $${i++}`);
        params.push(f.status);
    }
    if (f.location) {
        conds.push(`LOWER(COALESCE(l.location, '')) LIKE $${i++}`);
        params.push('%' + f.location.toLowerCase() + '%');
    }
    if (f.source) {
        conds.push(`LOWER(COALESCE(l.source::text, '')) = $${i++}`);
        params.push(f.source.toLowerCase());
    }
    if (f.employee) {
        conds.push(`EXISTS (
            SELECT 1 FROM private.assignments a2
              JOIN private.employees e2 ON e2.employee_id = a2.employee_id
             WHERE a2.lead_id = l.lead_id AND e2.external_id = $${i++}
        )`);
        params.push(f.employee);
    }
    if (f.unassigned) {
        conds.push(`NOT EXISTS (
            SELECT 1 FROM private.assignments a3 WHERE a3.lead_id = l.lead_id
        )`);
    }
    if (f.q) {
        conds.push(`(
            LOWER(COALESCE(l.name, ''))         LIKE $${i}
         OR LOWER(COALESCE(l.phone, ''))        LIKE $${i}
         OR LOWER(COALESCE(l.email, ''))        LIKE $${i}
         OR LOWER(COALESCE(l.external_id, ''))  LIKE $${i}
        )`);
        params.push('%' + f.q.toLowerCase() + '%');
        i++;
    }

    // conds always has at least the deleted_at filter
    const whereClause = 'WHERE ' + conds.join(' AND ');

    // Config-driven SLA window (first-touch hours). Overdue is computed per row
    // off the first-assignment LATERAL (fa.first_at).
    const slaHours = await getFirstTouchHours(pool);

    const leads = await safe(
        `SELECT
             l.lead_id,
             COALESCE(l.external_id, '')             AS external_id,
             l.name,
             COALESCE(l.phone, '')                   AS phone,
             COALESCE(l.email, '')                   AS email,
             COALESCE(l.location, '')                AS location,
             COALESCE(l.budget, '')                  AS budget,
             COALESCE(l.requirement, '')             AS requirement,
             COALESCE(l.source::text, '')            AS source,
             COALESCE(l.status::text, 'cold')        AS status,
             COALESCE(l.next_action, '')             AS next_action,
             l.next_action_date,
             l.site_visit_date,
             l.closure_probability,
             l.created_at,
             (
                 SELECT e.name FROM private.assignments a
                  JOIN private.employees e ON e.employee_id = a.employee_id
                 WHERE a.lead_id = l.lead_id
                 ORDER BY a.assigned_at DESC LIMIT 1
             ) AS assigned_to_name,
             (
                 SELECT e.external_id FROM private.assignments a
                  JOIN private.employees e ON e.employee_id = a.employee_id
                 WHERE a.lead_id = l.lead_id
                 ORDER BY a.assigned_at DESC LIMIT 1
             ) AS assigned_to_code,
             fa.first_at                             AS first_assigned_at,
             ${overdueExpr(slaHours)}                AS sla_overdue
           FROM private.leads l
           ${FIRST_ASSIGN_LATERAL}
           ${whereClause}
       ORDER BY l.created_at DESC NULLS LAST
          LIMIT 500`,
        params,
        []
    );

    // Status breakdown (also hides soft-deleted)
    const breakdown = await safe(
        `SELECT
             LOWER(COALESCE(status::text, 'cold')) AS s,
             COUNT(*)::int                         AS c
           FROM private.leads
          WHERE deleted_at IS NULL
       GROUP BY s`,
        [],
        []
    );
    const stats = { total: 0, hot: 0, warm: 0, cold: 0, closed: 0, other: 0 };
    breakdown.forEach(row => {
        stats.total += row.c;
        if (['hot', 'warm', 'cold'].includes(row.s)) {
            stats[row.s] += row.c;
        } else if (['closed', 'converted', 'won', 'booked'].includes(row.s)) {
            stats.closed += row.c;
        } else {
            stats.other += row.c;
        }
    });

    const sources = await safe(
        `SELECT DISTINCT COALESCE(source::text, '') AS s
           FROM private.leads
          WHERE source IS NOT NULL AND deleted_at IS NULL
       ORDER BY s`,
        [],
        []
    );
    const locations = await safe(
        `SELECT DISTINCT COALESCE(location, '') AS loc
           FROM private.leads
          WHERE location IS NOT NULL AND location <> '' AND deleted_at IS NULL
       ORDER BY loc`,
        [],
        []
    );
    const employeesList = await safe(
        `SELECT external_id, name FROM private.employees
          WHERE status = 'active'::private.employee_status
       ORDER BY name`,
        [],
        []
    );

    const flash = req.session.leadsListFlash || null;
    req.session.leadsListFlash = null;

    // SLA-overdue count within the shown set (for the list header chip).
    const overdueCount = leads.filter(l => l.sla_overdue).length;

    res.render('admin/leads-list', {
        pageTitle: 'All Leads',
        user: req.session.user,
        leads,
        stats,
        showing: leads.length,
        filters: f,
        sources: sources.map(r => r.s).filter(Boolean),
        locations: locations.map(r => r.loc).filter(Boolean),
        employeesList,
        flash,
        slaHours,
        overdueCount,
    });
});

// =============================================================
// GET /admin/leads/:id — single lead detail with feedback + history
// =============================================================
router.get('/leads/:id', ensureAdmin, ensurePermission('leads.view_all'), async (req, res) => {
    const leadId = req.params.id;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    // 1) Lead record (hide soft-deleted)
    const leadRows = await safe(
        `SELECT lead_id,
                COALESCE(external_id, '')        AS external_id,
                name,
                COALESCE(phone, '')              AS phone,
                COALESCE(email, '')              AS email,
                COALESCE(location, '')           AS location,
                COALESCE(budget, '')             AS budget,
                COALESCE(requirement, '')        AS requirement,
                COALESCE(source::text, '')       AS source,
                COALESCE(status::text, 'cold')   AS status,
                COALESCE(last_feedback, '')      AS last_feedback,
                COALESCE(next_action, '')        AS next_action,
                next_action_date,
                site_visit_date,
                closure_probability,
                created_at,
                cp_configuration, COALESCE(cp_use,'') AS cp_use, cp_possession_pref,
                COALESCE(cp_funding,'') AS cp_funding, cp_down_payment,
                COALESCE(cp_budget_tag,'') AS cp_budget_tag, cp_amenities,
                COALESCE(cp_visit_pref,'') AS cp_visit_pref, COALESCE(cp_urgency_note,'') AS cp_urgency_note
           FROM private.leads
          WHERE lead_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [leadId],
        []
    );

    if (leadRows.length === 0) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }
    const lead = leadRows[0];

    const assignments = await safe(
        `SELECT a.assignment_id,
                COALESCE(a.external_id, '')      AS external_id,
                a.assigned_at,
                e.external_id AS employee_code,
                e.name        AS employee_name,
                COALESCE(e.role, '') AS employee_job_title
           FROM private.assignments a
           JOIN private.employees e ON e.employee_id = a.employee_id
          WHERE a.lead_id = $1
       ORDER BY a.assigned_at DESC`,
        [leadId],
        []
    );

    let feedback = await safe(
        `SELECT * FROM private.feedback
          WHERE lead_id = $1
       ORDER BY created_at DESC NULLS LAST
          LIMIT 50`,
        [leadId],
        null
    );
    if (feedback === null) feedback = [];

    const history = await safe(
        `SELECT entity_type, action, field_name, old_value, new_value,
                changed_by_name, notes, created_at
           FROM private.history_log
          WHERE entity_type = 'lead'
            AND (entity_id = $1 OR entity_id = $2)
       ORDER BY created_at DESC
          LIMIT 30`,
        [leadId, lead.external_id || ''],
        []
    );

    // cost sheets generated for this lead — display values come from the
    // frozen snapshot (never recomputed from live pricing)
    const costSheets = await safe(
        `SELECT cost_sheet_id,
                created_at,
                snapshot->'context'->>'property_title'   AS property_title,
                snapshot->'context'->>'unit_config'      AS unit_config,
                snapshot->'context'->>'generated_by_name' AS generated_by_name,
                snapshot->'computed'->>'total_all_in'    AS total_all_in
           FROM private.cost_sheets
          WHERE lead_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
        [leadId],
        []
    );

    const flash = req.session.leadEditFlash || null;
    req.session.leadEditFlash = null;

    res.render('admin/leads-detail', {
        pageTitle: lead.name,
        user: req.session.user,
        lead,
        assignments,
        feedback,
        history,
        costSheets,
        flash,
        csrfToken: csrf(req),
    });
});

// =============================================================
// GET /admin/leads/:id/matches — deterministic property suggestions (JSON).
// On-demand (fired by the "Find Matches" button). Read-only scoring; logs the
// run to match_log as a side-effect.
// =============================================================
router.get('/leads/:id/matches', ensureAdmin, ensurePermission('leads.view_all'), async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
        return res.status(404).json({ error: 'Lead not found' });
    }
    const rows = await safe(
        `SELECT * FROM private.leads WHERE lead_id = $1 AND deleted_at IS NULL`,
        [req.params.id], []
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    try {
        const out = await runMatches(rows[0], req);
        res.json(out);
    } catch (err) {
        console.error('[admin/leads] matcher failed:', err.message);
        res.status(500).json({ error: 'Matcher unavailable' });
    }
});

module.exports = router;
