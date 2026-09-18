// =====================================================================
// routes/admin/finance-reports.js — FINANCE MODULE (Phase 1) · B/C/D
// Read-only computed dashboards. Mount: app.use('/admin', ...)
// Gating: ensureAdmin + ensurePermission('finance.view') (super_admin + admin).
//
//   B. GST      -> GET /admin/finance/gst        output GST (commissions, SAC
//                  997222) vs input-eligible expenses, net position by month.
//   C. CashFlow -> GET /admin/finance/cashflow   monthly IN (payments +
//                  commission_receipts) vs OUT (expenses + ad spend).
//   D. P&L      -> GET /admin/finance/pnl        revenue (commissions earned,
//                  company_share) minus expenses by category, monthly + FY.
// No new data — every number reads live source tables.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const ejs = require('ejs');
const path = require('path');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) {
        console.error('[finance-reports] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data); }
    catch (e) { console.error('partial ' + name + ' failed:', e.message); return ''; }
}

// ---------------------------------------------------------------------
// B. GST SUMMARY — output (commissions) vs input (expenses), net by month
// ---------------------------------------------------------------------
router.get('/finance/gst', ensureAdmin, ensurePermission('finance.view'), async (req, res) => {
    // One row per month present in either side; output/input coalesced to 0.
    const rows = await safe(
        `WITH out_gst AS (
            SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') AS ym,
                   SUM(COALESCE(gst_on_invoice,0))::numeric AS output_gst
              FROM private.commission_receivables
             WHERE deleted_at IS NULL AND invoice_date IS NOT NULL
             GROUP BY 1
         ), in_gst AS (
            SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') AS ym,
                   SUM(COALESCE(gst_input_amount,0))::numeric AS input_gst
              FROM private.expenses
             WHERE deleted_at IS NULL AND is_input_gst_eligible = true AND status = 'approved'
             GROUP BY 1
         )
         SELECT COALESCE(o.ym, i.ym) AS ym,
                COALESCE(o.output_gst,0)::numeric AS output_gst,
                COALESCE(i.input_gst,0)::numeric AS input_gst,
                (COALESCE(o.output_gst,0) - COALESCE(i.input_gst,0))::numeric AS net_gst
           FROM out_gst o FULL OUTER JOIN in_gst i ON o.ym = i.ym
          ORDER BY ym DESC`,
        [], []);
    const tot = rows.reduce((a, r) => {
        a.output += Number(r.output_gst); a.input += Number(r.input_gst); a.net += Number(r.net_gst); return a;
    }, { output: 0, input: 0, net: 0 });

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'GST Summary' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'GST Summary' });
    res.render('admin/finance-gst', {
        csrfToken: req.csrfToken(), pageTitle: 'GST Summary', user: req.session.user,
        sidebarHtml, topbarHtml, rows, tot,
    });
});

// ---------------------------------------------------------------------
// C. CASH FLOW — monthly IN (payments + commission_receipts) vs OUT
//    (approved expenses + marketing ad spend). SEPARATE ledgers, summed.
// ---------------------------------------------------------------------
router.get('/finance/cashflow', ensureAdmin, ensurePermission('finance.view'), async (req, res) => {
    const rows = await safe(
        `WITH pay AS (
            SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') ym, SUM(amount)::numeric v
              FROM private.payments WHERE deleted_at IS NULL AND paid_at IS NOT NULL GROUP BY 1
         ), comm AS (
            SELECT to_char(date_trunc('month', received_on), 'YYYY-MM') ym, SUM(amount)::numeric v
              FROM private.commission_receipts WHERE deleted_at IS NULL GROUP BY 1
         ), exp AS (
            SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') ym, SUM(amount)::numeric v
              FROM private.expenses WHERE deleted_at IS NULL AND status = 'approved' GROUP BY 1
         ), spend AS (
            SELECT to_char(date_trunc('month', spend_date), 'YYYY-MM') ym, SUM(amount)::numeric v
              FROM private.spend_records GROUP BY 1
         ), months AS (
            SELECT ym FROM pay UNION SELECT ym FROM comm UNION SELECT ym FROM exp UNION SELECT ym FROM spend
         )
         SELECT m.ym,
                COALESCE(pay.v,0)::numeric   AS pay_in,
                COALESCE(comm.v,0)::numeric  AS comm_in,
                COALESCE(exp.v,0)::numeric   AS exp_out,
                COALESCE(spend.v,0)::numeric AS spend_out
           FROM months m
           LEFT JOIN pay   ON pay.ym = m.ym
           LEFT JOIN comm  ON comm.ym = m.ym
           LEFT JOIN exp   ON exp.ym = m.ym
           LEFT JOIN spend ON spend.ym = m.ym
          WHERE m.ym IS NOT NULL
          ORDER BY m.ym DESC`,
        [], []);
    const tot = rows.reduce((a, r) => {
        const inn = Number(r.pay_in) + Number(r.comm_in);
        const out = Number(r.exp_out) + Number(r.spend_out);
        a.pay += Number(r.pay_in); a.comm += Number(r.comm_in);
        a.exp += Number(r.exp_out); a.spend += Number(r.spend_out);
        a.in += inn; a.out += out; a.net += (inn - out); return a;
    }, { pay: 0, comm: 0, exp: 0, spend: 0, in: 0, out: 0, net: 0 });

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Cash Flow' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Cash Flow' });
    res.render('admin/finance-cashflow', {
        csrfToken: req.csrfToken(), pageTitle: 'Cash Flow', user: req.session.user,
        sidebarHtml, topbarHtml, rows, tot,
    });
});

// ---------------------------------------------------------------------
// D. P&L — revenue (commissions earned, company_share) minus expenses by
//    category. Monthly net + Indian-FY-to-date (Apr 1 -> today). No new data.
// ---------------------------------------------------------------------
router.get('/finance/pnl', ensureAdmin, ensurePermission('finance.view'), async (req, res) => {
    // Monthly revenue vs expenses.
    const monthly = await safe(
        `WITH rev AS (
            SELECT to_char(date_trunc('month', earned_at), 'YYYY-MM') ym, SUM(company_share)::numeric v
              FROM private.commission_ledger WHERE earned_at IS NOT NULL GROUP BY 1
         ), exp AS (
            SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') ym, SUM(amount)::numeric v
              FROM private.expenses WHERE deleted_at IS NULL AND status = 'approved' GROUP BY 1
         ), months AS (SELECT ym FROM rev UNION SELECT ym FROM exp)
         SELECT m.ym, COALESCE(rev.v,0)::numeric AS revenue, COALESCE(exp.v,0)::numeric AS expenses
           FROM months m LEFT JOIN rev ON rev.ym=m.ym LEFT JOIN exp ON exp.ym=m.ym
          WHERE m.ym IS NOT NULL ORDER BY m.ym DESC`,
        [], []);

    // Indian FY window: Apr 1 of the current FY -> today.
    const fyStartRow = await safe(
        `SELECT (CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 4
                      THEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, 4, 1)
                      ELSE make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int - 1, 4, 1) END) AS fy_start`,
        [], [{ fy_start: null }]);
    const fyStart = fyStartRow[0].fy_start;

    const fyRev = await safe(
        `SELECT COALESCE(SUM(company_share),0)::numeric v FROM private.commission_ledger
          WHERE earned_at >= $1`, [fyStart], [{ v: 0 }]);
    const byCat = await safe(
        `SELECT c.name, COALESCE(SUM(e.amount),0)::numeric v
           FROM private.expenses e LEFT JOIN private.expense_categories c ON c.category_id=e.category_id
          WHERE e.deleted_at IS NULL AND e.status='approved' AND e.expense_date >= $1
          GROUP BY c.name ORDER BY v DESC`, [fyStart], []);
    const fyExp = byCat.reduce((s, r) => s + Number(r.v), 0);
    const fyRevenue = Number(fyRev[0].v);
    const fy = { start: fyStart, revenue: fyRevenue, expenses: fyExp, net: fyRevenue - fyExp };

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'P&L' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'P&L' });
    res.render('admin/finance-pnl', {
        csrfToken: req.csrfToken(), pageTitle: 'Profit & Loss', user: req.session.user,
        sidebarHtml, topbarHtml, monthly, byCat, fy,
    });
});

module.exports = router;
