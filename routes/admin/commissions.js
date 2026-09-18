// =====================================================================
// routes/admin/commissions.js — COMMISSION RECEIVABLES (builder-owed AR)
// Mount: app.use('/admin', adminCommissionsRoutes)
// Routes (built across slices 2-4; slice 5 wires the live booking flow):
//   GET /admin/commissions        -> receivables list, filters, summary+ageing
// Reads private.commission_receivables + commission_receipts (both soft-delete).
// received = SUM(receipts.amount WHERE deleted_at IS NULL).
// Q1: TDS counts toward "received" for the outstanding calc, so
//     outstanding = expected_amount - (received + tds_deducted).
// Ageing clock = days since accrued_at. Parameterized queries only.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { logFromRequest } = require('../../middleware/historyLogger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTITY = 'commission_receivable';   // history_log entity_type for the whole timeline

// Receivable lifecycle statuses (mirror the DB enum private.commission_recv_status).
const STATUSES = ['accrued', 'builder_confirmed', 'invoice_raised', 'partially_received', 'fully_received'];

// partially_received / fully_received are set ONLY by receipt math — never by hand.
const SYSTEM_STATUSES = ['partially_received', 'fully_received'];

const STATUS_LABELS = {
    accrued: 'Accrued',
    builder_confirmed: 'Builder Confirmed',
    invoice_raised: 'Invoice Raised',
    partially_received: 'Partially Received',
    fully_received: 'Fully Received',
};

function cleanStr(v) {
    return (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
}
function numVal(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
}

// Valid MANUAL targets from `current`: forward is one step to the next
// non-system status; backward is any earlier non-system status (needs a reason).
// System statuses are never manual targets.
function computeManualTargets(current) {
    const ci = STATUSES.indexOf(current);
    const out = [];
    STATUSES.forEach((s, i) => {
        if (SYSTEM_STATUSES.includes(s) || i === ci) return;
        if (i === ci + 1) out.push({ value: s, label: STATUS_LABELS[s], backward: false });
        else if (i < ci) out.push({ value: s, label: STATUS_LABELS[s], backward: true });
    });
    return out;
}

// Receipt math authority: given expected + settled (received + tds), decide the
// system status. Only ever advances into a system status; never downgrades here.
function settledStatus(expected, settled, current) {
    const exp = Number(expected) || 0;
    if (settled > 0 && settled >= exp) return 'fully_received';
    if (settled > 0) return 'partially_received';
    return current;
}

// Ageing buckets -> inclusive day bounds ([lo, hi]; hi=null means open-ended).
const AGEING_BUCKETS = {
    '0-30':  [0, 30],
    '31-60': [31, 60],
    '61-90': [61, 90],
    '90+':   [91, null],
};

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/commissions] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// ---------------------------------------------------------------------
// GET /admin/commissions — receivables list, newest first, with filters.
// (Summary tiles + ageing-by-builder are layered on in slice 4.)
// ---------------------------------------------------------------------
router.get('/commissions', ensureAdmin, ensurePermission('commissions.view'), async (req, res) => {
    const q = req.query || {};

    // Sanitise filters — bad input degrades to "no filter", never to SQL.
    const fStatus  = STATUSES.includes(q.status) ? q.status : null;
    const fBuilder = UUID_RE.test(q.builder_id || '') ? q.builder_id : null;
    const fBucket  = Object.prototype.hasOwnProperty.call(AGEING_BUCKETS, q.ageing) ? q.ageing : null;

    const where = ['r.deleted_at IS NULL'];
    const params = [];
    if (fStatus) {
        params.push(fStatus);
        where.push(`r.status = $${params.length}::private.commission_recv_status`);
    }
    if (fBuilder) {
        params.push(fBuilder);
        where.push(`r.builder_id = $${params.length}`);
    }
    if (fBucket) {
        const [lo, hi] = AGEING_BUCKETS[fBucket];
        params.push(lo);
        where.push(`(CURRENT_DATE - r.accrued_at::date) >= $${params.length}`);
        if (hi !== null) {
            params.push(hi);
            where.push(`(CURRENT_DATE - r.accrued_at::date) <= $${params.length}`);
        }
    }
    const whereSql = where.join(' AND ');

    const receivables = await safe(
        `SELECT r.receivable_id, r.external_id, r.booking_ref, r.status,
                r.expected_amount, r.tds_deducted, r.gst_on_invoice,
                r.invoice_number, r.invoice_date, r.accrued_at,
                r.builder_id, COALESCE(b.name, '—') AS builder_name,
                COALESCE(rc.received, 0) AS received,
                (r.expected_amount - (COALESCE(rc.received, 0) + r.tds_deducted)) AS outstanding,
                (CURRENT_DATE - r.accrued_at::date) AS ageing_days
           FROM private.commission_receivables r
           LEFT JOIN private.builders b ON b.builder_id = r.builder_id
           LEFT JOIN LATERAL (
               SELECT SUM(rp.amount) AS received
                 FROM private.commission_receipts rp
                WHERE rp.receivable_id = r.receivable_id AND rp.deleted_at IS NULL
           ) rc ON true
          WHERE ${whereSql}
          ORDER BY r.accrued_at DESC, r.created_at DESC`,
        params, []
    );

    // Builder options for the filter dropdown: only builders that actually
    // own a receivable (keeps the list short + relevant).
    const builders = await safe(
        `SELECT DISTINCT b.builder_id, b.name
           FROM private.commission_receivables r
           JOIN private.builders b ON b.builder_id = r.builder_id
          WHERE r.deleted_at IS NULL AND b.name IS NOT NULL
          ORDER BY b.name ASC`,
        [], []
    );

    // ---- Summary + ageing (slice 4). Unfiltered: reflects the whole book. ----
    // Indian FY runs Apr 1 -> Mar 31.
    const now = new Date();
    const fyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = fyStartYear + '-04-01';

    const summaryRow = await safe(
        `SELECT
            COALESCE(SUM(GREATEST(r.expected_amount - (COALESCE(rc.received,0) + r.tds_deducted), 0)), 0) AS total_outstanding,
            COALESCE(MAX(CASE WHEN r.status <> 'fully_received'
                              THEN (CURRENT_DATE - r.accrued_at::date) END), 0) AS worst_ageing,
            COUNT(*)::int AS total_count
           FROM private.commission_receivables r
           LEFT JOIN LATERAL (
               SELECT SUM(rp.amount) AS received FROM private.commission_receipts rp
                WHERE rp.receivable_id = r.receivable_id AND rp.deleted_at IS NULL
           ) rc ON true
          WHERE r.deleted_at IS NULL`,
        [], [{ total_outstanding: 0, worst_ageing: 0, total_count: 0 }]
    );

    const fyRow = await safe(
        `SELECT COALESCE(SUM(amount), 0) AS fy_received
           FROM private.commission_receipts
          WHERE deleted_at IS NULL AND received_on >= $1::date`,
        [fyStart], [{ fy_received: 0 }]
    );

    const statusRows = await safe(
        `SELECT r.status, COUNT(*)::int AS n
           FROM private.commission_receivables r
          WHERE r.deleted_at IS NULL
          GROUP BY r.status`,
        [], []
    );
    const statusCounts = {};
    STATUSES.forEach(s => { statusCounts[s] = 0; });
    statusRows.forEach(row => { statusCounts[row.status] = row.n; });

    // Ageing-by-builder: outstanding money bucketed by age, worst first.
    const ageingByBuilder = await safe(
        `SELECT COALESCE(b.name, '—') AS builder_name,
                SUM(CASE WHEN x.age BETWEEN 0 AND 30  THEN x.outstanding ELSE 0 END) AS b0_30,
                SUM(CASE WHEN x.age BETWEEN 31 AND 60 THEN x.outstanding ELSE 0 END) AS b31_60,
                SUM(CASE WHEN x.age BETWEEN 61 AND 90 THEN x.outstanding ELSE 0 END) AS b61_90,
                SUM(CASE WHEN x.age > 90              THEN x.outstanding ELSE 0 END) AS b90p,
                SUM(x.outstanding) AS total_out,
                MAX(x.age) AS worst_age
           FROM (
               SELECT r.builder_id,
                      (CURRENT_DATE - r.accrued_at::date) AS age,
                      GREATEST(r.expected_amount - (COALESCE(rc.received,0) + r.tds_deducted), 0) AS outstanding
                 FROM private.commission_receivables r
                 LEFT JOIN LATERAL (
                     SELECT SUM(rp.amount) AS received FROM private.commission_receipts rp
                      WHERE rp.receivable_id = r.receivable_id AND rp.deleted_at IS NULL
                 ) rc ON true
                WHERE r.deleted_at IS NULL
           ) x
           LEFT JOIN private.builders b ON b.builder_id = x.builder_id
          WHERE x.outstanding > 0
          GROUP BY b.name
          ORDER BY b90p DESC, total_out DESC`,
        [], []
    );

    res.render('admin/commissions-list', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Commission Receivables',
        user: req.session.user,
        receivables,
        builders,
        statuses: STATUSES,
        statusLabels: STATUS_LABELS,
        ageingBuckets: Object.keys(AGEING_BUCKETS),
        filters: { status: fStatus || '', builder_id: fBuilder || '', ageing: fBucket || '' },
        summary: summaryRow[0],
        fyReceived: fyRow[0].fy_received,
        fyLabel: 'FY ' + fyStartYear + '-' + String((fyStartYear + 1) % 100).padStart(2, '0'),
        statusCounts,
        ageingByBuilder,
        flash: req.query.msg || null,
    });
});

// Single receivable + computed money fields. Returns null if not found/deleted.
async function loadReceivable(id) {
    const rows = await safe(
        `SELECT r.receivable_id, r.external_id, r.commission_id, r.booking_ref, r.status,
                r.expected_amount, r.tds_deducted, r.gst_on_invoice,
                r.invoice_number, r.invoice_date, r.accrued_at, r.notes,
                r.builder_id, COALESCE(b.name, '—') AS builder_name,
                COALESCE(rc.received, 0) AS received,
                (r.expected_amount - (COALESCE(rc.received, 0) + r.tds_deducted)) AS outstanding,
                (CURRENT_DATE - r.accrued_at::date) AS ageing_days
           FROM private.commission_receivables r
           LEFT JOIN private.builders b ON b.builder_id = r.builder_id
           LEFT JOIN LATERAL (
               SELECT SUM(rp.amount) AS received
                 FROM private.commission_receipts rp
                WHERE rp.receivable_id = r.receivable_id AND rp.deleted_at IS NULL
           ) rc ON true
          WHERE r.receivable_id = $1 AND r.deleted_at IS NULL
          LIMIT 1`,
        [id], []
    );
    return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------
// GET /admin/commissions/:id — detail + status timeline + receipt history
// ---------------------------------------------------------------------
router.get('/commissions/:id', ensureAdmin, ensurePermission('commissions.view'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(404).render('404', { pageTitle: 'Not Found' });

    const receivable = await loadReceivable(id);
    if (!receivable) return res.status(404).render('404', { pageTitle: 'Receivable Not Found' });

    const receipts = await safe(
        `SELECT receipt_id, amount, received_on, mode, reference, notes, created_at
           FROM private.commission_receipts
          WHERE receivable_id = $1 AND deleted_at IS NULL
          ORDER BY received_on DESC, created_at DESC`,
        [id], []
    );

    const timeline = await safe(
        `SELECT action, field_name, old_value, new_value,
                changed_by_name, changed_by_role, notes, created_at
           FROM private.history_log
          WHERE entity_type = $1 AND entity_id = $2
          ORDER BY created_at DESC`,
        [ENTITY, id], []
    );

    res.render('admin/commissions-detail', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Commission — ' + (receivable.external_id || receivable.booking_ref || 'Receivable'),
        user: req.session.user,
        r: receivable,
        receipts,
        timeline,
        statusLabels: STATUS_LABELS,
        manualTargets: computeManualTargets(receivable.status),
        systemStatuses: SYSTEM_STATUSES,
        flash: req.query.msg || null,
        errmsg: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// POST /admin/commissions/:id/status — manual status transition
// (forward one step, or backward with a reason; system statuses barred)
// ---------------------------------------------------------------------
router.post('/commissions/:id/status', ensureAdmin, ensurePermission('commissions.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/commissions?msg=' + encodeURIComponent('Invalid receivable id'));
    const back = (m) => res.redirect('/admin/commissions/' + id + '?err=' + encodeURIComponent(m));

    const target = cleanStr(req.body.status);
    const reason = cleanStr(req.body.reason);
    if (!target || !STATUSES.includes(target)) return back('Unknown status.');
    if (SYSTEM_STATUSES.includes(target)) return back('“' + STATUS_LABELS[target] + '” is set automatically by receipts — it cannot be set by hand.');

    const r = await loadReceivable(id);
    if (!r) return back('Receivable not found.');
    if (target === r.status) return back('Already in that status.');

    const ci = STATUSES.indexOf(r.status);
    const ti = STATUSES.indexOf(target);
    let backward;
    if (ti > ci) {
        if (ti !== ci + 1) return back('You can only advance one step at a time.');
        backward = false;
        if (target === 'invoice_raised' && (!r.invoice_number || !r.invoice_date)) {
            return back('Add the invoice number and date before marking “Invoice Raised”.');
        }
    } else {
        backward = true;
        if (!reason) return back('A reason is required to move a receivable backward.');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_status');
        await client.query(
            `UPDATE private.commission_receivables SET status = $1::private.commission_recv_status
              WHERE receivable_id = $2 AND deleted_at IS NULL`,
            [target, id]
        );
        await client.query('RELEASE SAVEPOINT sp_status');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/commissions] status update failed:', err.message);
        return back(userSafeError(err, 'Could not update the status. Please try again.'));
    } finally {
        client.release();
    }

    try {
        await logFromRequest(req, {
            entityType: ENTITY, entityId: id, action: 'status',
            fieldName: 'status', oldValue: r.status, newValue: target,
            notes: (backward ? 'Moved BACKWARD — reason: ' + reason : 'Advanced status'),
        });
    } catch (e) { console.warn('[admin/commissions] status log failed:', e.message); }

    return res.redirect('/admin/commissions/' + id + '?msg=' + encodeURIComponent('Status → ' + STATUS_LABELS[target]));
});

// ---------------------------------------------------------------------
// POST /admin/commissions/:id/receipt — record a partial payment, then
// recompute SUM(receipts)+tds vs expected and auto-set partially/fully
// IN THE SAME TRANSACTION.
// ---------------------------------------------------------------------
router.post('/commissions/:id/receipt', ensureAdmin, ensurePermission('commissions.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/commissions?msg=' + encodeURIComponent('Invalid receivable id'));
    const back = (m) => res.redirect('/admin/commissions/' + id + '?err=' + encodeURIComponent(m));

    const amount = numVal(req.body.amount);
    if (amount === null || amount <= 0) return back('Receipt amount must be greater than zero.');
    let receivedOn = cleanStr(req.body.received_on);
    if (receivedOn && !DATE_RE.test(receivedOn)) return back('Received-on date is not a valid date.');
    const mode = cleanStr(req.body.mode);
    const reference = cleanStr(req.body.reference);
    const notes = cleanStr(req.body.notes);

    const client = await pool.connect();
    let oldStatus = null, newStatus = null, commissionId = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_receipt');

        // lock the receivable row; read the frozen expected + tds (+ commission_id
        // for the §18.2 incentive promotion below)
        const rr = await client.query(
            `SELECT expected_amount, tds_deducted, status, commission_id
               FROM private.commission_receivables
              WHERE receivable_id = $1 AND deleted_at IS NULL
              FOR UPDATE`,
            [id]
        );
        if (rr.rows.length === 0) {
            await client.query('ROLLBACK');
            return back('Receivable not found.');
        }
        oldStatus = rr.rows[0].status;
        commissionId = rr.rows[0].commission_id;
        const expected = Number(rr.rows[0].expected_amount) || 0;
        const tds = Number(rr.rows[0].tds_deducted) || 0;

        await client.query(
            `INSERT INTO private.commission_receipts
                (receivable_id, amount, received_on, mode, reference, notes, created_by)
             VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7)`,
            [id, amount, receivedOn, mode, reference, notes,
             (req.session.user && req.session.user.employee_id) || null]
        );

        // recompute settled = live receipts + tds (Q1), decide system status
        const sumRow = await client.query(
            `SELECT COALESCE(SUM(amount), 0) AS received
               FROM private.commission_receipts
              WHERE receivable_id = $1 AND deleted_at IS NULL`,
            [id]
        );
        const settled = (Number(sumRow.rows[0].received) || 0) + tds;
        newStatus = settledStatus(expected, settled, oldStatus);

        if (newStatus !== oldStatus) {
            await client.query(
                `UPDATE private.commission_receivables SET status = $1::private.commission_recv_status
                  WHERE receivable_id = $2 AND deleted_at IS NULL`,
                [newStatus, id]
            );
        }

        // §18.2 guardrail — promote the linked incentive to 'payable' ONLY when the
        // receivable reaches fully_received (builder money actually in). Idempotent:
        // the status='accrued' guard means a re-receipt never double-promotes.
        if (newStatus === 'fully_received' && oldStatus !== 'fully_received' && commissionId) {
            await client.query(
                `UPDATE private.incentive_entries
                    SET status = 'payable', payable_at = NOW()
                  WHERE commission_id = $1 AND status = 'accrued' AND deleted_at IS NULL`,
                [commissionId]
            );
        }

        await client.query('RELEASE SAVEPOINT sp_receipt');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/commissions] receipt insert failed:', err.message);
        return back(userSafeError(err, 'Could not record the receipt. Please try again.'));
    } finally {
        client.release();
    }

    try {
        await logFromRequest(req, {
            entityType: ENTITY, entityId: id, action: 'receipt',
            fieldName: null, oldValue: null, newValue: String(amount),
            notes: 'Receipt ₹' + amount + (mode ? ' via ' + mode : '') + (reference ? ' (ref ' + reference + ')' : ''),
        });
        if (newStatus && newStatus !== oldStatus) {
            await logFromRequest(req, {
                entityType: ENTITY, entityId: id, action: 'status',
                fieldName: 'status', oldValue: oldStatus, newValue: newStatus,
                notes: 'Auto-set by receipt math (received + TDS vs expected).',
            });
        }
    } catch (e) { console.warn('[admin/commissions] receipt log failed:', e.message); }

    return res.redirect('/admin/commissions/' + id + '?msg=' + encodeURIComponent('Receipt of ₹' + amount + ' recorded.'));
});

// ---------------------------------------------------------------------
// POST /admin/commissions/:id/invoice — edit invoice number + date
// ---------------------------------------------------------------------
router.post('/commissions/:id/invoice', ensureAdmin, ensurePermission('commissions.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/commissions?msg=' + encodeURIComponent('Invalid receivable id'));
    const back = (m) => res.redirect('/admin/commissions/' + id + '?err=' + encodeURIComponent(m));

    const invNo = cleanStr(req.body.invoice_number);
    let invDate = cleanStr(req.body.invoice_date);
    if (invDate && !DATE_RE.test(invDate)) return back('Invoice date is not a valid date.');

    const r = await loadReceivable(id);
    if (!r) return back('Receivable not found.');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_invoice');
        await client.query(
            `UPDATE private.commission_receivables
                SET invoice_number = $1, invoice_date = $2::date
              WHERE receivable_id = $3 AND deleted_at IS NULL`,
            [invNo, invDate, id]
        );
        await client.query('RELEASE SAVEPOINT sp_invoice');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/commissions] invoice update failed:', err.message);
        return back(userSafeError(err, 'Could not update the invoice details. Please try again.'));
    } finally {
        client.release();
    }

    try {
        const oldRow = { invoice_number: r.invoice_number, invoice_date: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null };
        const newRow = { invoice_number: invNo, invoice_date: invDate };
        for (const f of ['invoice_number', 'invoice_date']) {
            const o = oldRow[f] === null || oldRow[f] === undefined ? '' : String(oldRow[f]);
            const n = newRow[f] === null || newRow[f] === undefined ? '' : String(newRow[f]);
            if (o !== n) {
                await logFromRequest(req, {
                    entityType: ENTITY, entityId: id, action: 'update',
                    fieldName: f, oldValue: oldRow[f], newValue: newRow[f], notes: 'Invoice details edited',
                });
            }
        }
    } catch (e) { console.warn('[admin/commissions] invoice log failed:', e.message); }

    return res.redirect('/admin/commissions/' + id + '?msg=' + encodeURIComponent('Invoice details saved.'));
});

module.exports = router;
module.exports._STATUSES = STATUSES;          // exposed for tests
module.exports._AGEING_BUCKETS = AGEING_BUCKETS;
module.exports._computeManualTargets = computeManualTargets;
module.exports._settledStatus = settledStatus;
