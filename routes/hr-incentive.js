// =====================================================================
// routes/hr-incentive.js — HR incentive dashboard + slab editor
// Mount: app.use('/hr', require('./routes/hr-incentive'))  (after routes/hr.js)
//   GET  /hr/incentives                 -> per-exec accrued/payable/paid + gating
//   POST /hr/incentives/:id/pay         -> mark payable -> paid (HR/admin)
//   GET  /hr/incentive-slabs            -> slab editor (ADMIN)
//   POST /hr/incentive-slabs            -> add a slab (ADMIN, history-logged)
//   POST /hr/incentive-slabs/:id/toggle -> activate/deactivate a slab (ADMIN)
// Dashboard/mark-paid: ensureRole('hr_manager'). Slab editor: ensureAdmin (money math).
// Real staff only (E[0-9]{3,}).
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const pool = require('../db');
const { ensureRole } = require('../middleware/roleGate');
const { ensureAdmin } = require('../middleware/adminAuth');
const { logFromRequest } = require('../middleware/historyLogger');

const ensureHr = ensureRole('hr_manager', 'HR Manager');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[hr-incentive] query failed:', err.message); return fallback; }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', 'views', 'hr', 'layout', name + '.ejs'), data); }
    catch (e) { console.error('[hr-incentive] partial ' + name + ' failed:', e.message); return ''; }
}
async function shell(req, pageTitle) {
    const data = { user: req.session.user, pageTitle };
    return {
        sidebarHtml: await renderPartial('sidebar', data),
        topbarHtml: await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', 'topbar.ejs'), data),
    };
}

// ---------------------------------------------------------------------
// GET /hr/incentives — per-exec dashboard
// ---------------------------------------------------------------------
router.get('/incentives', ensureHr, async (req, res) => {
    const perExec = await safe(
        `SELECT e.employee_id, e.name, e.external_id,
                COALESCE(SUM(ie.incentive_amount) FILTER (WHERE ie.status='accrued'),0)::numeric AS accrued,
                COALESCE(SUM(ie.incentive_amount) FILTER (WHERE ie.status='payable'),0)::numeric AS payable,
                COALESCE(SUM(ie.incentive_amount) FILTER (WHERE ie.status='paid'),0)::numeric    AS paid
           FROM private.employees e
           LEFT JOIN private.incentive_entries ie
                  ON ie.employee_id = e.employee_id AND ie.deleted_at IS NULL
          WHERE e.status='active' AND e.external_id ~ '^E[0-9]{3,}$'
            AND e.email NOT LIKE '%@dhyaan.local'
          GROUP BY e.employee_id, e.name, e.external_id
          ORDER BY e.name`,
        [], []
    );

    // Entry list with the gating (receivable) status visible.
    const entries = await safe(
        `SELECT ie.entry_id, e.name AS emp_name, e.external_id AS emp_code,
                cl.external_id AS commission_ref, ie.base_amount, ie.slab_rate,
                ie.incentive_amount, ie.status::text AS status, ie.payable_at, ie.paid_at,
                r.status::text AS receivable_status
           FROM private.incentive_entries ie
           JOIN private.employees e ON e.employee_id = ie.employee_id
           JOIN private.commission_ledger cl ON cl.commission_id = ie.commission_id
           LEFT JOIN private.commission_receivables r
                  ON r.commission_id = ie.commission_id AND r.deleted_at IS NULL
          WHERE ie.deleted_at IS NULL AND e.external_id ~ '^E[0-9]{3,}$'
            AND e.email NOT LIKE '%@dhyaan.local'
          ORDER BY (ie.status='payable') DESC, ie.created_at DESC`,
        [], []
    );

    const totals = perExec.reduce((t, r) => {
        t.accrued += Number(r.accrued); t.payable += Number(r.payable); t.paid += Number(r.paid);
        return t;
    }, { accrued: 0, payable: 0, paid: 0 });

    const { sidebarHtml, topbarHtml } = await shell(req, 'Incentive Dashboard');
    res.render('hr/incentives', {
        pageTitle: 'Incentive Dashboard', user: req.session.user,
        sidebarHtml, topbarHtml, perExec, entries, totals,
        isAdmin: (req.session.user.access_role === 'admin' || req.session.user.access_role === 'super_admin'),
        messages: { success: req.flash('success_msg'), error: req.flash('error_msg') },
    });
});

// ---------------------------------------------------------------------
// POST /hr/incentives/:id/pay — mark payable -> paid (manual, guarded)
// ---------------------------------------------------------------------
router.post('/incentives/:id/pay', ensureHr, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { req.flash('error_msg', 'Invalid entry.'); return res.redirect('/hr/incentives'); }
    const payerId = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;

    const client = await pool.connect();
    let paid = false, amt = 0, who = '';
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_pay');
        // Only a 'payable' entry (guardrail already passed) can be paid.
        const upd = await client.query(
            `UPDATE private.incentive_entries
                SET status='paid', paid_at=NOW(), paid_by=$1
              WHERE entry_id=$2 AND status='payable' AND deleted_at IS NULL
              RETURNING incentive_amount,
                        (SELECT name FROM private.employees WHERE employee_id = incentive_entries.employee_id) AS emp`,
            [payerId, id]
        );
        if (upd.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error_msg', 'Only a payable entry can be marked paid (check the gating status).');
            return res.redirect('/hr/incentives');
        }
        amt = Number(upd.rows[0].incentive_amount); who = upd.rows[0].emp;
        await client.query('RELEASE SAVEPOINT sp_pay');
        await client.query('COMMIT');
        paid = true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-incentive] pay failed:', err.message);
        req.flash('error_msg', 'Could not mark paid — see server log.');
        return res.redirect('/hr/incentives');
    } finally {
        client.release();
    }
    if (paid) {
        try {
            await logFromRequest(req, {
                entityType: 'incentive_entry', entityId: id, action: 'pay',
                fieldName: 'status', oldValue: 'payable', newValue: 'paid',
                notes: `Incentive ₹${amt} paid to ${who} by ${req.session.user.name}`,
            });
        } catch (e) { /* logging never blocks */ }
        req.flash('success_msg', `Incentive ₹${amt} marked paid to ${who}.`);
    }
    return res.redirect('/hr/incentives');
});

// ---------------------------------------------------------------------
// GET /hr/incentive-slabs — slab editor (ADMIN)
// ---------------------------------------------------------------------
router.get('/incentive-slabs', ensureAdmin, async (req, res) => {
    const slabs = await safe(
        `SELECT slab_id, min_amount, max_amount, rate_percent, active, created_at
           FROM private.incentive_slabs WHERE deleted_at IS NULL
          ORDER BY min_amount`, [], []
    );
    const { sidebarHtml, topbarHtml } = await shell(req, 'Incentive Slabs');
    res.render('hr/incentive-slabs', {
        pageTitle: 'Incentive Slabs', user: req.session.user,
        sidebarHtml, topbarHtml, slabs,
        messages: { success: req.flash('success_msg'), error: req.flash('error_msg') },
    });
});

// POST /hr/incentive-slabs — add a slab (ADMIN)
router.post('/incentive-slabs', ensureAdmin, async (req, res) => {
    const min = Number(req.body.min_amount);
    const maxRaw = (req.body.max_amount || '').trim();
    const max = maxRaw === '' ? null : Number(maxRaw);
    const rate = Number(req.body.rate_percent);
    if (!(min >= 0) || !(rate >= 0 && rate <= 100) || (max !== null && !(max > min))) {
        req.flash('error_msg', 'Invalid slab: min≥0, 0≤rate≤100, max>min (or blank for open top).');
        return res.redirect('/hr/incentive-slabs');
    }
    const client = await pool.connect();
    let slabId = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_slab');
        const ins = await client.query(
            `INSERT INTO private.incentive_slabs (min_amount, max_amount, rate_percent, active)
             VALUES ($1, $2, $3, true) RETURNING slab_id`,
            [min, max, rate]
        );
        slabId = ins.rows[0].slab_id;
        await client.query('RELEASE SAVEPOINT sp_slab');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-incentive] slab add failed:', err.message);
        req.flash('error_msg', 'Could not add slab — see server log.');
        return res.redirect('/hr/incentive-slabs');
    } finally { client.release(); }
    try {
        await logFromRequest(req, {
            entityType: 'incentive_slab', entityId: slabId, action: 'create',
            newValue: `${min}-${max === null ? '∞' : max} @ ${rate}%`,
            notes: `Slab added by ${req.session.user.name}`,
        });
    } catch (e) { /* */ }
    req.flash('success_msg', `Slab added: ${min}–${max === null ? 'open' : max} @ ${rate}%.`);
    return res.redirect('/hr/incentive-slabs');
});

// POST /hr/incentive-slabs/:id/toggle — activate/deactivate (ADMIN)
router.post('/incentive-slabs/:id/toggle', ensureAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { req.flash('error_msg', 'Invalid slab.'); return res.redirect('/hr/incentive-slabs'); }
    const client = await pool.connect();
    let newActive = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_toggle');
        const upd = await client.query(
            `UPDATE private.incentive_slabs SET active = NOT active
              WHERE slab_id=$1 AND deleted_at IS NULL RETURNING active`,
            [id]
        );
        if (upd.rows.length === 0) { await client.query('ROLLBACK'); req.flash('error_msg', 'Slab not found.'); return res.redirect('/hr/incentive-slabs'); }
        newActive = upd.rows[0].active;
        await client.query('RELEASE SAVEPOINT sp_toggle');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[hr-incentive] toggle failed:', err.message);
        req.flash('error_msg', 'Could not toggle slab.');
        return res.redirect('/hr/incentive-slabs');
    } finally { client.release(); }
    try {
        await logFromRequest(req, {
            entityType: 'incentive_slab', entityId: id, action: 'update',
            fieldName: 'active', newValue: String(newActive),
            notes: `Slab ${newActive ? 'activated' : 'deactivated'} by ${req.session.user.name}`,
        });
    } catch (e) { /* */ }
    req.flash('success_msg', `Slab ${newActive ? 'activated' : 'deactivated'}.`);
    return res.redirect('/hr/incentive-slabs');
});

module.exports = router;
