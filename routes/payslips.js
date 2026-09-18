// =====================================================================
// routes/payslips.js — EMPLOYEE "My Payslips" (Phase 4). Mounted at /payslips
// behind sealEmployeeWorld. Every query is scoped to the logged-in employee_id;
// an employee sees ONLY their own payslips, and only from PAID runs (drafts are
// internal). Salary is the most private data in the system — the ownership check
// is enforced on BOTH the list and the PDF-download route (IDOR headline test).
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const pool = require('../db');
const { ensurePermission } = require('../middleware/permissions');
const { getOrRenderPayslipPdf } = require('../lib/payslipPdf');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canView = ensurePermission('payslip.view_own');

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[payslips] query failed:', err.message); return fallback; }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', name + '.ejs'), data); }
    catch (e) { return ''; }
}
function uidOf(req) { const u = req.session.user; return (u && (u.employee_id || u.id)) || null; }

// LIST — own, PAID runs only
router.get('/', canView, async (req, res) => {
    const uid = uidOf(req);
    const rows = await safe(
        `SELECT p.payslip_id, p.gross, p.incentive_amount, p.total_deductions, p.net_pay, r.period_month
           FROM private.payslips p
           JOIN private.payroll_runs r ON r.run_id = p.run_id
          WHERE p.employee_id = $1 AND p.deleted_at IS NULL AND r.status = 'paid' AND r.deleted_at IS NULL
          ORDER BY r.period_month DESC`, [uid], []);
    let topbarHtml = '';
    try { topbarHtml = await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', 'topbar.ejs'), { user: req.session.user, pageTitle: 'My Payslips' }); } catch (_) {}
    res.render('payslips-list', {
        pageTitle: 'My Payslips', user: req.session.user, topbarHtml, payslips: rows,
        csrfToken: (typeof req.csrfToken === 'function') ? req.csrfToken() : '',
    });
});

// PDF — own only. Ownership + PAID enforced before streaming.
router.get('/:id/pdf', canView, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).send('Bad request');
    const uid = uidOf(req);
    const own = await safe(
        `SELECT p.payslip_id
           FROM private.payslips p JOIN private.payroll_runs r ON r.run_id = p.run_id
          WHERE p.payslip_id = $1 AND p.employee_id = $2 AND p.deleted_at IS NULL AND r.status = 'paid'`,
        [id, uid], []);
    if (!own.length) return res.status(404).send('Payslip not found');   // not yours / not paid -> 404
    try {
        const fp = await getOrRenderPayslipPdf(id);
        if (!fp) return res.status(404).send('Payslip not found');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.download(fp, 'payslip.pdf');
    } catch (e) { console.error('[payslips] pdf failed:', e.message); return res.status(500).send('PDF failed'); }
});

module.exports = router;
