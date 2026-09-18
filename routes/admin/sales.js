// =============================================================
// routes/admin/sales.js
// Day 3 — Sales History (closed deals + revenue)
//
// Routes:
//   GET /admin/sales        → closed/won leads + payment data
//
// Data sources:
//   - private.leads (closed/converted/won/booked status)
//   - private.payments (defensive — schema may vary)
//   - private.commission_ledger (defensive)
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/sales] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

/**
 * Detect columns in a table — used to build defensive queries
 * against payments / commission_ledger whose schema we don't fully know.
 */
async function getColumns(tableName) {
    try {
        const r = await pool.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'private' AND table_name = $1
           ORDER BY ordinal_position`,
            [tableName]
        );
        return r.rows.map(row => row.column_name);
    } catch (err) {
        return [];
    }
}

// =============================================================
// GET /admin/sales
//
// Query params:
//   ?employee=E003    filter by salesperson
//   ?days=90          date range, default 90
//   ?q=text           search lead name / location
// =============================================================
router.get('/sales', ensureAdmin, ensurePermission('reports.view'), async (req, res) => {

    const f = {
        employee: (req.query.employee || '').trim(),
        days:     parseInt(req.query.days || '90', 10) || 90,
        q:        (req.query.q || '').trim(),
    };

    if (f.days < 1) f.days = 1;
    if (f.days > 3650) f.days = 3650;

    // Inspect schemas (so we don't crash on column mismatch)
    const paymentCols = await getColumns('payments');
    const commCols    = await getColumns('commission_ledger');

    // Heuristic detection: what column holds the payment amount?
    let payAmountCol = null;
    if      (paymentCols.includes('amount'))        payAmountCol = 'amount';
    else if (paymentCols.includes('payment_amount')) payAmountCol = 'payment_amount';
    else if (paymentCols.includes('value'))         payAmountCol = 'value';
    else if (paymentCols.includes('paid_amount'))   payAmountCol = 'paid_amount';
    else if (paymentCols.includes('total'))         payAmountCol = 'total';

    let payDateCol = null;
    if      (paymentCols.includes('paid_at'))       payDateCol = 'paid_at';
    else if (paymentCols.includes('payment_date'))  payDateCol = 'payment_date';
    else if (paymentCols.includes('created_at'))    payDateCol = 'created_at';

    let payLeadCol = paymentCols.includes('lead_id') ? 'lead_id' : null;

    let commAmountCol = null;
    if      (commCols.includes('amount'))           commAmountCol = 'amount';
    else if (commCols.includes('commission_amount')) commAmountCol = 'commission_amount';
    else if (commCols.includes('value'))            commAmountCol = 'value';

    let commEmpCol = commCols.includes('employee_id') ? 'employee_id' : null;
    let commLeadCol = commCols.includes('lead_id') ? 'lead_id' : null;

    // Build conditions for the closed-leads query
    const conds = [
        `LOWER(l.status::text) IN ('closed', 'converted', 'won', 'booked', 'sold')`,
    ];
    const params = [];
    let i = 1;

    if (f.employee) {
        conds.push(`EXISTS (
            SELECT 1 FROM private.assignments a
              JOIN private.employees e ON e.employee_id = a.employee_id
             WHERE a.lead_id = l.lead_id AND e.external_id = $${i++}
        )`);
        params.push(f.employee);
    }
    if (f.q) {
        conds.push(`(
            LOWER(COALESCE(l.name, ''))     LIKE $${i}
         OR LOWER(COALESCE(l.location, '')) LIKE $${i}
         OR LOWER(COALESCE(l.budget, ''))   LIKE $${i}
        )`);
        params.push('%' + f.q.toLowerCase() + '%');
        i++;
    }

    const whereClause = 'WHERE ' + conds.join(' AND ');

    // -----------------------------------------------------------------
    // Main query: closed leads with their owner + payment total
    // -----------------------------------------------------------------
    let payTotalSubquery = 'NULL';
    if (payAmountCol && payLeadCol) {
        payTotalSubquery = `(
            SELECT COALESCE(SUM(${payAmountCol}::numeric), 0)
              FROM private.payments
             WHERE ${payLeadCol} = l.lead_id
        )`;
    }

    let payCountSubquery = '0';
    if (payLeadCol) {
        payCountSubquery = `(
            SELECT COUNT(*)::int FROM private.payments
             WHERE ${payLeadCol} = l.lead_id
        )`;
    }

    let commTotalSubquery = 'NULL';
    if (commAmountCol && commLeadCol) {
        commTotalSubquery = `(
            SELECT COALESCE(SUM(${commAmountCol}::numeric), 0)
              FROM private.commission_ledger
             WHERE ${commLeadCol} = l.lead_id
        )`;
    }

    const sales = await safe(
        `SELECT l.lead_id,
                COALESCE(l.external_id, '')       AS external_id,
                l.name,
                COALESCE(l.phone, '')             AS phone,
                COALESCE(l.location, '')          AS location,
                COALESCE(l.budget, '')            AS budget,
                COALESCE(l.requirement, '')       AS requirement,
                COALESCE(l.status::text, '')      AS status,
                l.created_at,
                l.closure_probability,
                (SELECT e.name FROM private.assignments a
                   JOIN private.employees e ON e.employee_id = a.employee_id
                  WHERE a.lead_id = l.lead_id
                  ORDER BY a.assigned_at DESC LIMIT 1) AS sales_rep_name,
                (SELECT e.external_id FROM private.assignments a
                   JOIN private.employees e ON e.employee_id = a.employee_id
                  WHERE a.lead_id = l.lead_id
                  ORDER BY a.assigned_at DESC LIMIT 1) AS sales_rep_code,
                ${payTotalSubquery}::numeric  AS payment_total,
                ${payCountSubquery}           AS payment_count,
                ${commTotalSubquery}::numeric AS commission_total
           FROM private.leads l
           ${whereClause}
       ORDER BY l.created_at DESC NULLS LAST
          LIMIT 500`,
        params,
        []
    );

    // -----------------------------------------------------------------
    // Stat totals
    // -----------------------------------------------------------------
    const stats = await safe(
        `SELECT
            (SELECT COUNT(*)::int FROM private.leads
              WHERE LOWER(status::text) IN ('closed','converted','won','booked','sold')) AS total_closed,
            (SELECT COUNT(*)::int FROM private.leads
              WHERE LOWER(status::text) = 'hot') AS hot_open,
            (SELECT COUNT(*)::int FROM private.leads
              WHERE LOWER(status::text) IN ('warm','hot')) AS pipeline_open,
            (SELECT COUNT(*)::int FROM private.payments) AS payment_rows`,
        [],
        [{ total_closed: 0, hot_open: 0, pipeline_open: 0, payment_rows: 0 }]
    );

    // Total payment volume + total commission (if columns exist)
    let revenueRow = { total_revenue: 0, total_commission: 0 };
    if (payAmountCol) {
        const r = await safe(
            `SELECT COALESCE(SUM(${payAmountCol}::numeric), 0) AS total_revenue
               FROM private.payments`,
            [],
            [{ total_revenue: 0 }]
        );
        revenueRow.total_revenue = r[0] ? Number(r[0].total_revenue) : 0;
    }
    if (commAmountCol) {
        const r = await safe(
            `SELECT COALESCE(SUM(${commAmountCol}::numeric), 0) AS total_commission
               FROM private.commission_ledger`,
            [],
            [{ total_commission: 0 }]
        );
        revenueRow.total_commission = r[0] ? Number(r[0].total_commission) : 0;
    }

    // -----------------------------------------------------------------
    // Sales by employee (leaderboard)
    // -----------------------------------------------------------------
    const leaderboard = await safe(
        `SELECT e.external_id,
                e.name,
                COUNT(DISTINCT l.lead_id)::int AS closed_count
           FROM private.employees e
      LEFT JOIN private.assignments a ON a.employee_id = e.employee_id
      LEFT JOIN private.leads l       ON l.lead_id = a.lead_id
                                      AND LOWER(l.status::text) IN ('closed','converted','won','booked','sold')
          WHERE e.status = 'active'::private.employee_status
            AND COALESCE(e.access_role, 'employee') = 'employee'
       GROUP BY e.external_id, e.name
       ORDER BY closed_count DESC, e.name
          LIMIT 20`,
        [],
        []
    );

    // Employee filter dropdown
    const employeesList = await safe(
        `SELECT external_id, name FROM private.employees
          WHERE status = 'active'::private.employee_status
       ORDER BY name`,
        [],
        []
    );

    res.render('admin/sales', {
        pageTitle: 'Sales History',
        user: req.session.user,
        sales,
        stats: stats[0],
        revenue: revenueRow,
        leaderboard,
        filters: f,
        employeesList,
        schemaInfo: {
            paymentsAvailable: !!(payAmountCol && payLeadCol),
            commissionAvailable: !!(commAmountCol && commLeadCol),
            paymentCols,
            commCols,
        },
        showing: sales.length,
    });
});

module.exports = router;
