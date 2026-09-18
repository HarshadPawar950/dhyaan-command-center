// =====================================================================
// routes/admin/owner-dashboard.js — OWNER / PROMOTER DASHBOARD (boss-only)
// Mount: app.use('/admin', adminOwnerDashboardRoutes)
// Routes:
//   GET /admin/owner-dashboard  -> read-only executive overview
//
// READ-ONLY. No writes, no forms, no POST. Aggregates existing data:
//   payments         -> revenue (collected / pending+partial)
//   commission_ledger -> commission payouts, company vs employee share, top earners
//   spend_records    -> marketing spend
//   campaigns        -> active campaign count
//   ROAS = revenue collected / marketing spend
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/owner-dashboard] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// ---------------------------------------------------------------------
// DASHBOARD (read-only)
// ---------------------------------------------------------------------
router.get('/owner-dashboard', ensureAdmin, async (req, res) => {
    // ---- Revenue (payments) ----
    const collectedRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.payments
          WHERE status = 'paid'`,
        [], [{ v: 0 }]
    );
    const revenueCollected = Number(collectedRow[0].v) || 0;

    const outstandingRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.payments
          WHERE status IN ('pending', 'partial')`,
        [], [{ v: 0 }]
    );
    const revenueOutstanding = Number(outstandingRow[0].v) || 0;

    const overdueRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.payments
          WHERE status = 'overdue'`,
        [], [{ v: 0 }]
    );
    const revenueOverdue = Number(overdueRow[0].v) || 0;

    const paidCountRow = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.payments
          WHERE status = 'paid'`,
        [], [{ c: 0 }]
    );
    const paidDeals = Number(paidCountRow[0].c) || 0;

    // ---- Commission (commission_ledger) ----
    const commTotalsRow = await safe(
        `SELECT COALESCE(SUM(commission_amount), 0)::numeric AS total,
                COALESCE(SUM(company_share), 0)::numeric  AS company,
                COALESCE(SUM(employee_share), 0)::numeric AS employee
           FROM private.commission_ledger`,
        [], [{ total: 0, company: 0, employee: 0 }]
    );
    const commissionTotal = Number(commTotalsRow[0].total) || 0;
    const companyShare = Number(commTotalsRow[0].company) || 0;
    const employeeShare = Number(commTotalsRow[0].employee) || 0;

    // ---- Top earners (employee_share by employee) ----
    const topEarners = await safe(
        `SELECT e.name AS name,
                COALESCE(SUM(cl.employee_share), 0)::numeric AS earned,
                COUNT(*)::int AS deals
           FROM private.commission_ledger cl
           JOIN private.employees e ON e.employee_id = cl.employee_id
          GROUP BY e.name
          ORDER BY earned DESC
          LIMIT 8`,
        [], []
    );

    // ---- Marketing spend (spend_records) ----
    const spendRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM private.spend_records`,
        [], [{ v: 0 }]
    );
    const totalSpend = Number(spendRow[0].v) || 0;

    // ---- Active campaigns ----
    const activeCampRow = await safe(
        `SELECT COUNT(*)::int AS c
           FROM private.campaigns
          WHERE deleted_at IS NULL AND status = 'active'`,
        [], [{ c: 0 }]
    );
    const activeCampaigns = Number(activeCampRow[0].c) || 0;

    // =================================================================
    // OWNER DASHBOARD v2 — demo-grade tiles. Every figure from live SQL,
    // soft-delete filtered, COALESCE-guarded (system is freshly live, so
    // zero-rows must render as a real 0, never NaN/undefined).
    // =================================================================

    // Fiscal year starts 1 April. For any date in Jan-Mar the FY began the
    // previous calendar year; Apr-Dec it began this year.
    const _now = new Date();
    const _fyStartYear = _now.getMonth() >= 3 ? _now.getFullYear() : _now.getFullYear() - 1;
    const fyStart = `${_fyStartYear}-04-01`;

    // ---- TILE 1: Total Cash Position (FY) = token receipts + commission receipts ----
    const tokenCashRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.token_receipts
          WHERE deleted_at IS NULL AND created_at >= $1`,
        [fyStart], [{ v: 0 }]
    );
    const commCashRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.commission_receipts
          WHERE deleted_at IS NULL AND received_on >= $1`,
        [fyStart], [{ v: 0 }]
    );
    const cashToken = Number(tokenCashRow[0].v) || 0;
    const cashCommission = Number(commCashRow[0].v) || 0;
    const cashPosition = cashToken + cashCommission;

    // ---- TILE 2: Outstanding Commissions (expected - received, active AR) ----
    const outstandingCommRow = await safe(
        `SELECT COALESCE(SUM(cr.expected_amount - COALESCE(rec.paid, 0)), 0)::numeric AS v
           FROM private.commission_receivables cr
           LEFT JOIN (
                SELECT receivable_id, SUM(amount) AS paid
                  FROM private.commission_receipts
                 WHERE deleted_at IS NULL
                 GROUP BY receivable_id
           ) rec ON rec.receivable_id = cr.receivable_id
          WHERE cr.deleted_at IS NULL AND cr.status <> 'fully_received'`,
        [], [{ v: 0 }]
    );
    const outstandingCommissions = Number(outstandingCommRow[0].v) || 0;

    // ---- TILE 3: Pipeline Value = SUM(budget x stage weight) on active leads ----
    // "Active leads x stage": budget parsed from free text (proven parser from
    // lead-scoring / hot-pipeline) x a stage confidence factor. Stage (status) is
    // always populated; closure_probability is set on almost no leads, so it would
    // collapse the pipeline to ~0 — status weighting is the honest, non-zero signal.
    // First numeric token only — many budgets are ranges ("70-80 Lakh") or
    // multi-line ("35 Lakh (9-10 Lakh + 25 Lakh)"); stripping ALL non-digits
    // globally would concatenate them into billions. Take the leading number.
    const FIRST_NUM = `NULLIF(substring(budget from '([0-9]+(?:\\.[0-9]+)?)'), '')::numeric`;
    const BUDGET_VALUE = `
        CASE
            WHEN budget IS NULL OR btrim(budget) = '' THEN 0
            WHEN budget ~* 'cr'   THEN COALESCE(${FIRST_NUM}, 0) * 10000000
            WHEN budget ~* 'lakh' OR budget ~* 'lac' OR budget ~* '\\mL\\M'
                                  THEN COALESCE(${FIRST_NUM}, 0) * 100000
            ELSE COALESCE(${FIRST_NUM}, 0)
        END`;
    const STAGE_WEIGHT = `
        CASE status
            WHEN 'hot'  THEN 0.7
            WHEN 'warm' THEN 0.4
            WHEN 'cold' THEN 0.15
            ELSE 0.1
        END`;
    const pipelineRow = await safe(
        `SELECT COALESCE(SUM((${BUDGET_VALUE}) * (${STAGE_WEIGHT})), 0)::numeric AS v,
                COUNT(*)::int AS n
           FROM private.leads
          WHERE deleted_at IS NULL AND status NOT IN ('converted', 'lost')`,
        [], [{ v: 0, n: 0 }]
    );
    const pipelineValue = Number(pipelineRow[0].v) || 0;
    const pipelineLeads = Number(pipelineRow[0].n) || 0;

    // ---- TILE 4: Bookings totals (payments has no soft-delete) ----
    const bookingsRow = await safe(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.payments`,
        [], [{ n: 0, v: 0 }]
    );
    const bookingsCount = Number(bookingsRow[0].n) || 0;
    const bookingsValue = Number(bookingsRow[0].v) || 0;

    // ---- TILE 5: Worst-ageing active receivable ----
    const worstAgeRow = await safe(
        `SELECT COALESCE(b.name, 'Unknown builder') AS builder_name,
                cr.booking_ref,
                (cr.expected_amount - COALESCE(rec.paid, 0))::numeric AS outstanding,
                (CURRENT_DATE - cr.accrued_at::date)::int AS days_aged,
                cr.status::text AS status
           FROM private.commission_receivables cr
           LEFT JOIN private.builders b ON b.builder_id = cr.builder_id
           LEFT JOIN (
                SELECT receivable_id, SUM(amount) AS paid
                  FROM private.commission_receipts
                 WHERE deleted_at IS NULL
                 GROUP BY receivable_id
           ) rec ON rec.receivable_id = cr.receivable_id
          WHERE cr.deleted_at IS NULL AND cr.status <> 'fully_received'
            AND (cr.expected_amount - COALESCE(rec.paid, 0)) > 0
          ORDER BY cr.accrued_at ASC
          LIMIT 1`,
        [], []
    );
    const worstAgeing = worstAgeRow.length ? worstAgeRow[0] : null;

    // ---- TILE 6: Bookings this calendar month ----
    const bookingsMonthRow = await safe(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS v
           FROM private.payments
          WHERE paid_at >= date_trunc('month', CURRENT_DATE)
            AND paid_at <  date_trunc('month', CURRENT_DATE) + interval '1 month'`,
        [], [{ n: 0, v: 0 }]
    );
    const bookingsMonthCount = Number(bookingsMonthRow[0].n) || 0;
    const bookingsMonthValue = Number(bookingsMonthRow[0].v) || 0;

    // ---- Derived metrics ----
    const roas = totalSpend > 0 ? (revenueCollected / totalSpend) : 0;

    res.render('admin/owner-dashboard', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Owner Dashboard',
        user: req.session.user,
        revenueCollected,
        revenueOutstanding,
        revenueOverdue,
        paidDeals,
        commissionTotal,
        companyShare,
        employeeShare,
        topEarners,
        totalSpend,
        activeCampaigns,
        roas,
        // ---- v2 tiles ----
        fyStart,
        cashPosition,
        cashToken,
        cashCommission,
        outstandingCommissions,
        pipelineValue,
        pipelineLeads,
        bookingsCount,
        bookingsValue,
        worstAgeing,
        bookingsMonthCount,
        bookingsMonthValue
    });
});

module.exports = router;

