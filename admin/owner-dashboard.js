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
const { ensureSuperAdmin } = require('../../middleware/adminAuth');

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
router.get('/owner-dashboard', ensureSuperAdmin, async (req, res) => {
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

    // ---- Derived metrics ----
    const roas = totalSpend > 0 ? (revenueCollected / totalSpend) : 0;

    res.render('admin/owner-dashboard', {
        csrfToken: req.csrfToken(),
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
        roas
    });
});

module.exports = router;
