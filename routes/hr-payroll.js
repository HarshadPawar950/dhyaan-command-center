// =====================================================================
// routes/hr-payroll.js — PHASE 4 PAYROLL (management). Mount: app.use('/hr', ...)
// Base gate ensureRole('hr_manager') (admits hr_manager + admin/super), then a
// permission layer:
//   payroll.run     -> structures, compute draft, edit draft TDS, generate PDFs
//                      (super + hr_manager; admin is admitted by role but lacks
//                       the key -> blocked)
//   payroll.approve -> approve run + mark paid + edit statutory rates
//                      (super_admin ONLY — two-hands; Drishti cannot self-approve)
//
// COMPUTE-THEN-CONFIRM: draft -> approved -> paid (order enforced here).
// PAID is ONE atomic txn: finalize + batch-mark the snapshot's payable incentives
// paid (SAVEPOINT; any error rolls back the whole run — nothing half-paid).
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureRole } = require('../middleware/roleGate');
const { ensurePermission } = require('../middleware/permissions');
const { getEffectiveRates, getEffectivePtSlabs, computePayslip } = require('../lib/payroll');
const { getOrRenderPayslipPdf } = require('../lib/payslipPdf');

const ensureHr = ensureRole('hr_manager', 'HR Manager');
const canRun = ensurePermission('payroll.run');
const canApprove = ensurePermission('payroll.approve');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REAL_STAFF = `COALESCE(external_id,'') NOT LIKE 'ROLE-LOGIN-%' AND COALESCE(email,'') NOT LIKE '%@dhyaan.local'`;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[hr-payroll] query failed:', err.message); return fallback; }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', 'views', 'hr', 'layout', name + '.ejs'), data); }
    catch (e) { console.error('[hr-payroll] partial failed:', e.message); return ''; }
}
async function shell(req, pageTitle) {
    const user = req.session.user;
    const navPerms = (user && user.navPerms) || [];
    const data = { user, pageTitle, navPerms, roleLabel: (user && user.role) || '' };
    return {
        sidebarHtml: await renderPartial('sidebar', data),
        topbarHtml: await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', 'topbar.ejs'), data),
    };
}
const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
const num = (v) => { const n = t(v); return n === null ? null : Number(n); };
function firstOfMonth(s) { const m = /^(\d{4})-(\d{2})/.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-01` : null; }

// ---------------------------------------------------------------------
// RUNS list + create
// ---------------------------------------------------------------------
router.get('/payroll', ensureHr, canRun, async (req, res) => {
    const runs = await safe(
        `SELECT r.run_id, r.period_month, r.status, r.created_at, r.approved_at, r.paid_at,
                COUNT(p.payslip_id) FILTER (WHERE p.deleted_at IS NULL)::int AS slips,
                COALESCE(SUM(p.net_pay) FILTER (WHERE p.deleted_at IS NULL),0)::numeric AS net_total
           FROM private.payroll_runs r
           LEFT JOIN private.payslips p ON p.run_id = r.run_id
          WHERE r.deleted_at IS NULL
          GROUP BY r.run_id
          ORDER BY r.period_month DESC, r.created_at DESC`, [], []);
    const { sidebarHtml, topbarHtml } = await shell(req, 'Payroll');
    res.render('hr/payroll-runs', {
        pageTitle: 'Payroll', user: req.session.user, sidebarHtml, topbarHtml, runs,
        flash: req.query.msg || null, err: req.query.err || null,
    });
});

// Create a draft run for a month + compute payslips for every real active
// employee that has a salary structure. Incentives are INCLUDED (payable this
// month) but NOT marked paid until the run is paid.
router.post('/payroll/runs', ensureHr, canRun, async (req, res) => {
    const period = firstOfMonth(req.body.period_month);
    if (!period) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Pick a valid month'));
    const u = req.session.user; const by = (u && (u.employee_id || u.id)) || null;

    const rates = await getEffectiveRates(period);
    const ptSlabs = await getEffectivePtSlabs(period, 'MH');
    const structures = await safe(
        `SELECT s.employee_id, s.basic, s.hra, s.allowances, s.monthly_tds_default, e.name
           FROM private.salary_structure s
           JOIN private.employees e ON e.employee_id = s.employee_id
          WHERE s.deleted_at IS NULL AND e.status='active' AND ${REAL_STAFF.replace(/external_id/g, 'e.external_id').replace(/email/g, 'e.email')}`, [], []);
    if (!structures.length) return res.redirect('/hr/payroll?err=' + encodeURIComponent('No active employees have a salary structure yet'));

    // payable incentives for the month, per employee
    const incRows = await safe(
        `SELECT employee_id, COALESCE(SUM(incentive_amount),0)::numeric AS amt,
                array_agg(entry_id) AS ids
           FROM private.incentive_entries
          WHERE status='payable' AND deleted_at IS NULL
            AND date_trunc('month', payable_at) = date_trunc('month', $1::date)
          GROUP BY employee_id`, [period], []);
    const incByEmp = {};
    for (const r of incRows) incByEmp[r.employee_id] = { amt: Number(r.amt), ids: r.ids || [] };

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_run');
        const runRow = await client.query(
            `INSERT INTO private.payroll_runs (period_month, status, created_by) VALUES ($1,'draft',$2) RETURNING run_id`,
            [period, by]);
        const runId = runRow.rows[0].run_id;
        for (const s of structures) {
            const inc = incByEmp[s.employee_id] || { amt: 0, ids: [] };
            const c = computePayslip({ structure: s, rates, ptSlabs, incentiveTotal: inc.amt, tdsOverride: null, periodMonth: period });
            const snapshot = { rates, ptSlabs, incentiveEntryIds: inc.ids, employeeName: s.name, period };
            await client.query(
                `INSERT INTO private.payslips (run_id, employee_id, basic, hra, allowances, gross, incentive_amount,
                    pf_employee, esi_employee, professional_tax, tds, total_deductions, net_pay, pf_employer, esi_employer, snapshot)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [runId, s.employee_id, c.basic, c.hra, c.allowances, c.gross, c.incentive_amount,
                 c.pf_employee, c.esi_employee, c.professional_tax, c.tds, c.total_deductions, c.net_pay,
                 c.pf_employer, c.esi_employer, JSON.stringify(snapshot)]);
        }
        await client.query('RELEASE SAVEPOINT sp_run'); await client.query('COMMIT');
        res.redirect('/hr/payroll/runs/' + runId + '?msg=' + encodeURIComponent(`Draft run created (${structures.length} payslips)`));
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        const dup = /uq_payroll_run_period_live/.test(e.message);
        res.redirect('/hr/payroll?err=' + encodeURIComponent(dup ? 'A live run already exists for that month' : userSafeError(e, 'Could not create the run. Please try again.')));
    } finally { client.release(); }
});

// ---------------------------------------------------------------------
// RUN detail
// ---------------------------------------------------------------------
router.get('/payroll/runs/:id', ensureHr, canRun, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Invalid run id'));
    const runRows = await safe(`SELECT * FROM private.payroll_runs WHERE run_id=$1 AND deleted_at IS NULL`, [id], []);
    if (!runRows.length) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Run not found'));
    const run = runRows[0];
    const slips = await safe(
        `SELECT p.*, e.name AS employee_name, e.external_id
           FROM private.payslips p JOIN private.employees e ON e.employee_id = p.employee_id
          WHERE p.run_id=$1 AND p.deleted_at IS NULL
          ORDER BY e.name`, [id], []);
    const totals = slips.reduce((a, s) => {
        a.gross += Number(s.gross); a.inc += Number(s.incentive_amount); a.ded += Number(s.total_deductions); a.net += Number(s.net_pay); return a;
    }, { gross: 0, inc: 0, ded: 0, net: 0 });
    const canApproveNow = (req.session.user.navPerms || []).some(k => k === '*' || k === 'payroll.approve');
    const { sidebarHtml, topbarHtml } = await shell(req, 'Payroll Run');
    res.render('hr/payroll-run-detail', {
        pageTitle: 'Payroll Run', user: req.session.user, sidebarHtml, topbarHtml,
        run, slips, totals, canApprove: canApproveNow,
        flash: req.query.msg || null, err: req.query.err || null,
    });
});

// Edit TDS on a DRAFT payslip -> recompute net (payroll.run).
router.post('/payroll/runs/:id/payslips/:psId/tds', ensureHr, canRun, async (req, res) => {
    const { id, psId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(psId)) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Invalid id'));
    const back = '/hr/payroll/runs/' + id;
    const newTds = num(req.body.tds);
    if (newTds === null || isNaN(newTds) || newTds < 0) return res.redirect(back + '?err=' + encodeURIComponent('TDS must be >= 0'));
    const run = (await safe(`SELECT status FROM private.payroll_runs WHERE run_id=$1 AND deleted_at IS NULL`, [id], []))[0];
    if (!run || run.status !== 'draft') return res.redirect(back + '?err=' + encodeURIComponent('TDS is editable only on a draft run'));
    const ps = (await safe(`SELECT gross, incentive_amount, pf_employee, esi_employee, professional_tax FROM private.payslips WHERE payslip_id=$1 AND run_id=$2 AND deleted_at IS NULL`, [psId, id], []))[0];
    if (!ps) return res.redirect(back + '?err=' + encodeURIComponent('Payslip not found'));
    const ded = Number(ps.pf_employee) + Number(ps.esi_employee) + Number(ps.professional_tax) + newTds;
    const net = Number(ps.gross) + Number(ps.incentive_amount) - ded;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_tds');
        await client.query(`UPDATE private.payslips SET tds=$1, total_deductions=$2, net_pay=$3 WHERE payslip_id=$4 AND run_id=$5`, [newTds, ded, net, psId, id]);
        await client.query('RELEASE SAVEPOINT sp_tds'); await client.query('COMMIT');
        res.redirect(back + '?msg=' + encodeURIComponent('TDS updated'));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.redirect(back + '?err=' + encodeURIComponent('Could not update TDS')); }
    finally { client.release(); }
});

// APPROVE: draft -> approved (super only). Enforce order.
router.post('/payroll/runs/:id/approve', ensureHr, canApprove, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Invalid run id'));
    const by = (req.session.user.employee_id || req.session.user.id) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_appr');
        const cur = await client.query(`SELECT status FROM private.payroll_runs WHERE run_id=$1 AND deleted_at IS NULL FOR UPDATE`, [id]);
        if (!cur.rows.length) { await client.query('ROLLBACK'); return res.redirect('/hr/payroll?err=' + encodeURIComponent('Run not found')); }
        if (cur.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return res.redirect('/hr/payroll/runs/' + id + '?err=' + encodeURIComponent('Only a draft run can be approved')); }
        await client.query(`UPDATE private.payroll_runs SET status='approved', approved_by=$1, approved_at=now() WHERE run_id=$2`, [by, id]);
        await client.query('RELEASE SAVEPOINT sp_appr'); await client.query('COMMIT');
        res.redirect('/hr/payroll/runs/' + id + '?msg=' + encodeURIComponent('Run approved — ready to pay'));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.redirect('/hr/payroll/runs/' + id + '?err=' + encodeURIComponent('Approve failed')); }
    finally { client.release(); }
});

// PAY: approved -> paid (super only). ATOMIC: finalize + mark snapshot incentives
// paid. Cannot skip approved. Any error rolls the whole thing back.
router.post('/payroll/runs/:id/pay', ensureHr, canApprove, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Invalid run id'));
    const by = (req.session.user.employee_id || req.session.user.id) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_pay');
        const cur = await client.query(`SELECT status FROM private.payroll_runs WHERE run_id=$1 AND deleted_at IS NULL FOR UPDATE`, [id]);
        if (!cur.rows.length) { await client.query('ROLLBACK'); return res.redirect('/hr/payroll?err=' + encodeURIComponent('Run not found')); }
        const st = cur.rows[0].status;
        if (st === 'draft') { await client.query('ROLLBACK'); return res.redirect('/hr/payroll/runs/' + id + '?err=' + encodeURIComponent('A run must be approved before it can be paid')); }
        if (st !== 'approved') { await client.query('ROLLBACK'); return res.redirect('/hr/payroll/runs/' + id + '?err=' + encodeURIComponent('Only an approved run can be paid')); }
        // collect the incentive entry ids frozen in each payslip snapshot
        const slips = await client.query(`SELECT snapshot FROM private.payslips WHERE run_id=$1 AND deleted_at IS NULL`, [id]);
        const entryIds = [];
        for (const s of slips.rows) { const ids = (s.snapshot && s.snapshot.incentiveEntryIds) || []; for (const x of ids) entryIds.push(x); }
        if (entryIds.length) {
            // mark ONLY still-payable ones (guard prevents double-pay); same txn.
            await client.query(
                `UPDATE private.incentive_entries SET status='paid', paid_at=now(), paid_by=$1
                  WHERE entry_id = ANY($2::uuid[]) AND status='payable' AND deleted_at IS NULL`, [by, entryIds]);
        }
        await client.query(`UPDATE private.payroll_runs SET status='paid', paid_by=$1, paid_at=now() WHERE run_id=$2`, [by, id]);
        await client.query('RELEASE SAVEPOINT sp_pay'); await client.query('COMMIT');
        res.redirect('/hr/payroll/runs/' + id + '?msg=' + encodeURIComponent('Run PAID — payslips final, incentives settled'));
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-payroll] pay failed (rolled back whole run):', e.message);
        res.redirect('/hr/payroll/runs/' + id + '?err=' + encodeURIComponent(userSafeError(e, 'Payment failed — the run was left approved and nothing was paid. Please try again.')));
    } finally { client.release(); }
});

// CANCEL a draft (payroll.run)
router.post('/payroll/runs/:id/cancel', ensureHr, canRun, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/hr/payroll?err=' + encodeURIComponent('Invalid run id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_can');
        const cur = await client.query(`SELECT status FROM private.payroll_runs WHERE run_id=$1 AND deleted_at IS NULL FOR UPDATE`, [id]);
        if (cur.rows.length && cur.rows[0].status === 'draft') {
            await client.query(`UPDATE private.payroll_runs SET status='cancelled' WHERE run_id=$1`, [id]);
        } else { await client.query('ROLLBACK'); return res.redirect('/hr/payroll/runs/' + id + '?err=' + encodeURIComponent('Only a draft run can be cancelled')); }
        await client.query('RELEASE SAVEPOINT sp_can'); await client.query('COMMIT');
        res.redirect('/hr/payroll?msg=' + encodeURIComponent('Draft run cancelled'));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.redirect('/hr/payroll?err=' + encodeURIComponent('Cancel failed')); }
    finally { client.release(); }
});

// ---------------------------------------------------------------------
// SALARY STRUCTURES (payroll.run)
// ---------------------------------------------------------------------
router.get('/payroll/structures', ensureHr, canRun, async (req, res) => {
    const rows = await safe(
        `SELECT e.employee_id, e.external_id, e.name,
                s.structure_id, s.basic, s.hra, s.allowances, s.ctc, s.monthly_tds_default,
                s.pan, s.pf_uan, s.esi_number, s.bank_account, s.bank_ifsc
           FROM private.employees e
           LEFT JOIN private.salary_structure s ON s.employee_id = e.employee_id AND s.deleted_at IS NULL
          WHERE e.status='active' AND ${REAL_STAFF}
          ORDER BY e.name`, [], []);
    const { sidebarHtml, topbarHtml } = await shell(req, 'Salary Structures');
    res.render('hr/salary-structures', {
        pageTitle: 'Salary Structures', user: req.session.user, sidebarHtml, topbarHtml, rows,
        flash: req.query.msg || null, err: req.query.err || null,
    });
});

router.post('/payroll/structures/:employeeId', ensureHr, canRun, async (req, res) => {
    const empId = req.params.employeeId;
    if (!UUID_RE.test(empId)) return res.redirect('/hr/payroll/structures?err=' + encodeURIComponent('Invalid employee'));
    const d = {
        basic: num(req.body.basic) || 0, hra: num(req.body.hra) || 0, allowances: num(req.body.allowances) || 0,
        ctc: num(req.body.ctc), monthly_tds_default: num(req.body.monthly_tds_default) || 0,
        pan: t(req.body.pan), pf_uan: t(req.body.pf_uan), esi_number: t(req.body.esi_number),
        bank_account: t(req.body.bank_account), bank_ifsc: t(req.body.bank_ifsc),
    };
    const by = (req.session.user.employee_id || req.session.user.id) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_str');
        const ex = await client.query(`SELECT structure_id FROM private.salary_structure WHERE employee_id=$1 AND deleted_at IS NULL`, [empId]);
        if (ex.rows.length) {
            await client.query(
                `UPDATE private.salary_structure SET basic=$1,hra=$2,allowances=$3,ctc=$4,monthly_tds_default=$5,
                    pan=$6,pf_uan=$7,esi_number=$8,bank_account=$9,bank_ifsc=$10,updated_at=now()
                  WHERE structure_id=$11`,
                [d.basic, d.hra, d.allowances, d.ctc, d.monthly_tds_default, d.pan, d.pf_uan, d.esi_number, d.bank_account, d.bank_ifsc, ex.rows[0].structure_id]);
        } else {
            await client.query(
                `INSERT INTO private.salary_structure (employee_id,basic,hra,allowances,ctc,monthly_tds_default,pan,pf_uan,esi_number,bank_account,bank_ifsc,created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [empId, d.basic, d.hra, d.allowances, d.ctc, d.monthly_tds_default, d.pan, d.pf_uan, d.esi_number, d.bank_account, d.bank_ifsc, by]);
        }
        await client.query('RELEASE SAVEPOINT sp_str'); await client.query('COMMIT');
        res.redirect('/hr/payroll/structures?msg=' + encodeURIComponent('Salary structure saved'));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.redirect('/hr/payroll/structures?err=' + encodeURIComponent(userSafeError(e, 'Could not save the structure. Please try again.'))); }
    finally { client.release(); }
});

// ---------------------------------------------------------------------
// STATUTORY RATES (view: payroll.run; edit: payroll.approve = super only)
// ---------------------------------------------------------------------
router.get('/payroll/rates', ensureHr, canRun, async (req, res) => {
    const rates = await safe(`SELECT rate_key, rate_type, value, effective_from, active FROM private.statutory_rates WHERE deleted_at IS NULL ORDER BY rate_key, effective_from DESC`, [], []);
    const slabs = await safe(`SELECT state, lower_gross, upper_gross, monthly_amount, feb_amount, effective_from, active FROM private.pt_slabs WHERE deleted_at IS NULL ORDER BY effective_from DESC, lower_gross`, [], []);
    const canEdit = (req.session.user.navPerms || []).some(k => k === '*' || k === 'payroll.approve');
    const { sidebarHtml, topbarHtml } = await shell(req, 'Statutory Rates');
    res.render('hr/statutory-rates', {
        pageTitle: 'Statutory Rates', user: req.session.user, sidebarHtml, topbarHtml, rates, slabs, canEdit,
        flash: req.query.msg || null, err: req.query.err || null,
    });
});

// Add a NEW effective-dated rate row (never hard-update). super only.
router.post('/payroll/rates', ensureHr, canApprove, async (req, res) => {
    const rate_key = t(req.body.rate_key);
    const rate_type = t(req.body.rate_type);
    const value = num(req.body.value);
    const effective_from = t(req.body.effective_from);
    const back = '/hr/payroll/rates';
    if (!rate_key || !['percent', 'amount', 'threshold'].includes(rate_type) || value === null || !effective_from)
        return res.redirect(back + '?err=' + encodeURIComponent('All fields required (valid type)'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_rate');
        await client.query(`INSERT INTO private.statutory_rates (rate_key,rate_type,value,effective_from,notes) VALUES ($1,$2,$3,$4,$5)`,
            [rate_key, rate_type, value, effective_from, 'added via rates editor']);
        await client.query('RELEASE SAVEPOINT sp_rate'); await client.query('COMMIT');
        res.redirect(back + '?msg=' + encodeURIComponent('New effective-dated rate added'));
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        const dup = /uq_statutory_rate_key_from/.test(e.message);
        res.redirect(back + '?err=' + encodeURIComponent(dup ? 'That rate already has a row for that date' : userSafeError(e, 'Could not add the rate. Please try again.')));
    } finally { client.release(); }
});

// Payslip PDF (HR side — payroll.run). Employee side is a separate sealed route.
router.get('/payroll/payslips/:psId/pdf', ensureHr, canRun, async (req, res) => {
    const id = req.params.psId;
    if (!UUID_RE.test(id)) return res.status(400).send('Bad request');
    try {
        const fp = await getOrRenderPayslipPdf(id);
        if (!fp) return res.status(404).send('Payslip not found');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.download(fp, 'payslip.pdf');
    } catch (e) { console.error('[hr-payroll] pdf failed:', e.message); return res.status(500).send('PDF failed'); }
});

module.exports = router;
