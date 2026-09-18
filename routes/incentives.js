// =====================================================================
// routes/incentives.js — EMPLOYEE incentive ledger (read-only, self-scoped)
// Mount: app.use('/incentives', require('./routes/incentives'))
//   GET /incentives -> my incentive entries + accrued/payable/paid totals
// ensureAuthenticated. Shows the transparent §18.2 incentive: accrued on
// booking, payable once the builder commission is fully received, paid by HR.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[incentives] query failed:', err.message); return fallback; }
}
function myEmployeeId(user) {
    const cand = (user && (user.employee_id || user.id)) || null;
    return cand && UUID_RE.test(String(cand)) ? cand : null;
}

router.get('/', ensureAuthenticated, async (req, res) => {
    const empId = myEmployeeId(req.session.user);

    const entries = empId ? await safe(
        `SELECT ie.entry_id, ie.base_amount, ie.slab_rate, ie.incentive_amount,
                ie.status::text AS status, ie.payable_at, ie.paid_at, ie.created_at, ie.notes,
                cl.external_id AS commission_ref, cl.earned_at,
                r.status::text AS receivable_status
           FROM private.incentive_entries ie
           JOIN private.commission_ledger cl ON cl.commission_id = ie.commission_id
           LEFT JOIN private.commission_receivables r
                  ON r.commission_id = ie.commission_id AND r.deleted_at IS NULL
          WHERE ie.employee_id = $1 AND ie.deleted_at IS NULL
          ORDER BY ie.created_at DESC`,
        [empId], []
    ) : [];

    const totals = entries.reduce((t, e) => {
        t[e.status] = (t[e.status] || 0) + Number(e.incentive_amount || 0);
        return t;
    }, { accrued: 0, payable: 0, paid: 0 });

    res.render('incentives', {
        pageTitle: 'My Incentives',
        user: req.session.user,
        entries, totals,
        noEmp: !empId,
    });
});

module.exports = router;
