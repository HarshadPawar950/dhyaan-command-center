// =============================================================
// routes/admin/dashboard.js — v3 SOFT-DELETE AWARE
// Day 7: deleted_at IS NULL filters added to all KPI/pipeline queries
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { getFirstTouchHours, overdueExpr, FIRST_ASSIGN_LATERAL } = require('../../middleware/sla');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/dashboard] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

router.get('/dashboard', ensureAdmin, async (req, res) => {

    // ---- KPI: counts ----
    const empCount = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.employees
          WHERE status = 'active'::private.employee_status
            AND COALESCE(access_role, 'employee') = 'employee'`,
        [],
        [{ c: 0 }]
    );

    // Day 7: hide soft-deleted leads from KPI count
    const leadCount = await safe(
        `SELECT COUNT(*)::int AS c FROM private.leads WHERE deleted_at IS NULL`,
        [],
        [{ c: 0 }]
    );

    // Day 7: hide soft-deleted properties from KPI count
    let propCount = await safe(
        `SELECT COUNT(*)::int AS c FROM private.projects WHERE deleted_at IS NULL`,
        [],
        null
    );
    if (!propCount) {
        propCount = await safe(
            `SELECT COUNT(*)::int AS c FROM private.projects WHERE deleted_at IS NULL`,
            [],
            [{ c: 0 }]
        );
    }

    const todayActivity = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.history_log
          WHERE created_at::date = CURRENT_DATE`,
        [],
        [{ c: 0 }]
    );

    // ---- SLA first-touch overdue count (assigned, window elapsed, no touch) ----
    const slaHours = await getFirstTouchHours(pool);
    const overdueRow = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.leads l
           ${FIRST_ASSIGN_LATERAL}
          WHERE l.deleted_at IS NULL AND ${overdueExpr(slaHours)}`,
        [],
        [{ c: 0 }]
    );

    // ---- Top performers ----
    // Day 7: exclude soft-deleted leads from performer stats
    let topPerformers = await safe(
        `SELECT
             e.external_id        AS employee_code,
             e.name,
             COALESCE(e.role, '') AS designation,
             COALESCE(COUNT(DISTINCT a.lead_id) FILTER (WHERE l.deleted_at IS NULL), 0)::int AS total_leads,
             COALESCE(
                 SUM(CASE
                         WHEN l.deleted_at IS NULL
                          AND LOWER(COALESCE(l.status::text, '')) IN
                              ('closed', 'closure', 'converted', 'won', 'booked', 'hot')
                         THEN 1 ELSE 0
                     END),
                 0
             )::int AS closures
           FROM private.employees e
      LEFT JOIN private.assignments a ON a.employee_id = e.employee_id
      LEFT JOIN private.leads l       ON l.lead_id     = a.lead_id
          WHERE e.status = 'active'::private.employee_status
            AND COALESCE(e.access_role, 'employee') = 'employee'
       GROUP BY e.external_id, e.name, e.role
       ORDER BY closures DESC, total_leads DESC
          LIMIT 5`,
        [],
        null
    );
    if (!topPerformers) {
        topPerformers = await safe(
            `SELECT
                 e.external_id        AS employee_code,
                 e.name,
                 COALESCE(e.role, '') AS designation,
                 0::int               AS total_leads,
                 0::int               AS closures
               FROM private.employees e
              WHERE e.status = 'active'::private.employee_status
                AND COALESCE(e.access_role, 'employee') = 'employee'
           ORDER BY e.external_id
              LIMIT 5`,
            [],
            []
        );
    }

    // ---- Hot pipeline ----
    // Day 7: exclude soft-deleted leads from pipeline value
    const hotPipeline = await safe(
        `WITH cleaned AS (
             SELECT
                 CASE
              WHEN budget ~* 'cr' THEN NULLIF(REGEXP_REPLACE(COALESCE(budget, '0'), '[^0-9.]', '', 'g'), '')::NUMERIC * 10000000
              WHEN budget ~* 'lakh|lac' THEN NULLIF(REGEXP_REPLACE(COALESCE(budget, '0'), '[^0-9.]', '', 'g'), '')::NUMERIC * 100000
              ELSE NULLIF(REGEXP_REPLACE(COALESCE(budget, '0'), '[^0-9.]', '', 'g'), '')::NUMERIC
            END AS amt,
                 status::text AS s
               FROM private.leads
              WHERE deleted_at IS NULL
          )
          SELECT
             COALESCE(SUM(amt), 0)::numeric AS pipeline_value,
             COUNT(*)::int                  AS hot_count
            FROM cleaned
           WHERE LOWER(s) IN ('hot', 'warm', 'interested', 'site_visit', 'site visit',
                              'negotiation', 'follow_up', 'follow up')`,
        [],
        [{ pipeline_value: 0, hot_count: 0 }]
    );

    // ---- Recent activity feed ----
    const recentChanges = await safe(
        `SELECT entity_type, action, changed_by_name, notes, created_at
           FROM private.history_log
       ORDER BY created_at DESC
          LIMIT 10`,
        [],
        []
    );

    res.render('admin/dashboard', {
        pageTitle: 'Admin Dashboard',
        user: req.session.user,
        stats: {
            employees: empCount[0].c,
            leads: leadCount[0].c,
            properties: propCount[0].c,
            todayActivity: todayActivity[0].c,
            hotPipelineValue: Number(hotPipeline[0].pipeline_value || 0),
            hotLeadsCount: hotPipeline[0].hot_count,
            slaOverdue: overdueRow[0].c,
        },
        slaHours,
        topPerformers,
        recentChanges,
    });
});

module.exports = router;
