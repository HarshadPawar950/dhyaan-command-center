// =====================================================================
// routes/admin/bookings.js â€” BOOKING & COMMISSION (admin + boss)
// Mount: app.use('/admin', adminBookingsRoutes)
// Routes:
//   GET  /admin/bookings                 -> list bookings + commission summary
//   GET  /admin/bookings/new             -> record booking form
//   POST /admin/bookings/new             -> create payment (booking)
//   POST /admin/bookings/:id/commission  -> log commission for a paid booking
// Schema: payments(status enum pending/partial/paid/overdue), commission_ledger(employee_id NOT NULL)
// Chain: booking(payment) -> lead -> assignment -> employee (commission) ; lead.campaign_id -> ROAS
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { createApprovalTicket, executeDirect } = require('../../middleware/approvalEngine');
const { logFromRequest } = require('../../middleware/historyLogger');

function isSuper(u) { return !!u && (u.role === 'super_admin' || u.access_role === 'super_admin'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/bookings] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// ---------------------------------------------------------------------
// LIST + COMMISSION SUMMARY
// ---------------------------------------------------------------------
router.get('/bookings', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {

    const bookings = await safe(
        `SELECT
            p.payment_id, p.external_id, p.amount, p.method, p.status::text AS status, p.paid_at,
            p.booking_stage::text AS booking_stage,
            l.name AS lead_name, l.lead_id,
            pr.title AS property_title
           FROM private.payments p
           LEFT JOIN private.leads l ON l.lead_id = p.lead_id
           LEFT JOIN private.projects pr ON pr.project_id = p.project_id
          WHERE p.deleted_at IS NULL
          ORDER BY p.paid_at DESC
          LIMIT 200`,
        [], []
    );

    // headline KPIs
    const kRow = await safe(
        `SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'partial')::int AS partial,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::numeric AS paid_value,
            COALESCE(SUM(amount), 0)::numeric AS total_value
           FROM private.payments
          WHERE deleted_at IS NULL`,
        [], [{ total:0, paid:0, pending:0, partial:0, paid_value:0, total_value:0 }]
    );
    const k = kRow[0];

    // commission summary
    const commRow = await safe(
        `SELECT
            COALESCE(SUM(commission_amount), 0)::numeric AS total_commission,
            COALESCE(SUM(company_share), 0)::numeric     AS company_total,
            COALESCE(SUM(employee_share), 0)::numeric    AS employee_total,
            COUNT(*)::int AS entries
           FROM private.commission_ledger`,
        [], [{ total_commission:0, company_total:0, employee_total:0, entries:0 }]
    );
    const comm = commRow[0];

    res.render('admin/bookings-list', {
        pageTitle: 'Bookings & Commission',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        bookings,
        kpis: {
            total: k.total, paid: k.paid, pending: k.pending, partial: k.partial,
            paidValue: Number(k.paid_value) || 0,
            totalValue: Number(k.total_value) || 0,
            totalCommission: Number(comm.total_commission) || 0,
            companyTotal: Number(comm.company_total) || 0,
            employeeTotal: Number(comm.employee_total) || 0,
            commEntries: comm.entries
        },
        // flash confirmations (stage advance / receipt errors redirect here)
        messages: { success: req.flash('success'), error: req.flash('error') }
    });
});

// ---------------------------------------------------------------------
// RECORD BOOKING (form)
// ---------------------------------------------------------------------
router.get('/bookings/new', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const leads = await safe(
        `SELECT lead_id, name FROM private.leads
          WHERE deleted_at IS NULL ORDER BY name LIMIT 500`,
        [], []
    );
    const properties = await safe(
        `SELECT project_id, title FROM private.projects
          WHERE deleted_at IS NULL ORDER BY title LIMIT 300`,
        [], []
    );
    res.render('admin/bookings-new', {
        pageTitle: 'Record Booking',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        leads, properties
    });
});

// ---------------------------------------------------------------------
// RECORD BOOKING (create)
// ---------------------------------------------------------------------
router.post('/bookings/new', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const { lead_id, project_id, amount, method, status } = req.body;
    const validStatus = ['pending', 'partial', 'paid', 'overdue'];

    if (!amount || Number(amount) < 0) {
        req.flash('error', 'A valid booking amount is required.');
        return res.redirect('/admin/bookings/new');
    }
    const st = validStatus.includes(status) ? status : 'pending';

    // generate a booking reference (external_id)
    const ref = 'BKG-' + Date.now().toString(36).toUpperCase();

    try {
        await pool.query(
            `INSERT INTO private.payments
                (external_id, lead_id, project_id, amount, method, status, paid_at)
             VALUES ($1, $2, $3, $4, $5, $6::private.payment_status, NOW())`,
            [ref,
             lead_id && UUID_RE.test(lead_id) ? lead_id : null,
             project_id && UUID_RE.test(project_id) ? project_id : null,
             Number(amount), method || null, st]
        );

        // best-effort history log
        try {
            await pool.query(
                `INSERT INTO private.history_log (entity_type, action, changed_by_name, notes, created_at)
                 VALUES ('booking', 'create', $1, $2, NOW())`,
                [(req.session.user && req.session.user.name) || 'Admin',
                 `Booking ${ref} recorded â€” amount ${amount}, status ${st}`]
            );
        } catch (e) { /* ignore */ }

        req.flash('success', `Booking ${ref} recorded (${st}).`);
        res.redirect('/admin/bookings');
    } catch (err) {
        console.error('[bookings/new] failed:', err.message);
        req.flash('error', 'Could not record booking â€” see server log.');
        res.redirect('/admin/bookings/new');
    }
});

// ---------------------------------------------------------------------
// LOG COMMISSION for a booking (boss/admin)
// Finds the lead's assigned employee, creates a commission_ledger row.
// ---------------------------------------------------------------------
router.post('/bookings/:id/commission', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const paymentId = req.params.id;
    const { commission_amount, employee_share, company_share } = req.body;

    if (!UUID_RE.test(paymentId)) {
        req.flash('error', 'Invalid booking.');
        return res.redirect('/admin/bookings');
    }
    if (!commission_amount || Number(commission_amount) < 0) {
        req.flash('error', 'A valid commission amount is required.');
        return res.redirect('/admin/bookings');
    }

    try {
        // get the booking + its lead
        const payRows = await pool.query(
            `SELECT p.external_id, p.lead_id, p.project_id FROM private.payments p WHERE p.payment_id = $1`,
            [paymentId]
        );
        if (payRows.rows.length === 0) {
            req.flash('error', 'Booking not found.');
            return res.redirect('/admin/bookings');
        }
        const booking = payRows.rows[0];

        // find the employee assigned to that lead (most recent assignment)
        let employeeId = null;
        if (booking.lead_id) {
            const asg = await pool.query(
                `SELECT employee_id FROM private.assignments
                  WHERE lead_id = $1 ORDER BY assigned_at DESC LIMIT 1`,
                [booking.lead_id]
            );
            if (asg.rows.length > 0) employeeId = asg.rows[0].employee_id;
        }
        // fallback: if no assignment, attribute to the current admin user
        if (!employeeId) {
            employeeId = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;
        }
        if (!employeeId) {
            req.flash('error', 'No employee found to credit â€” assign the lead first.');
            return res.redirect('/admin/bookings');
        }

        const total = Number(commission_amount);
        const empShare = employee_share ? Number(employee_share) : 0;
        const compShare = company_share ? Number(company_share) : (total - empShare);
        const _suffix = Date.now().toString(36).toUpperCase();
        const ref = 'COM-' + _suffix;
        const rcvRef = 'RCV-' + _suffix;
        const createdBy = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;

        // Q3 / Slice 5 — the commission_ledger row and its commission_receivable
        // are created in ONE atomic transaction (never one without the other).
        // The receivable insert is idempotent: it is a no-op when a live
        // receivable already exists for this commission_id, backstopped by the
        // uq_recv_commission_live partial-unique index. Ledger insert values,
        // validation, flash and redirects are unchanged from before.
        const _client = await pool.connect();
        try {
            await _client.query('BEGIN');
            await _client.query('SAVEPOINT sp_commission');
            const _led = await _client.query(
                `INSERT INTO private.commission_ledger
                    (external_id, employee_id, deal_id, commission_amount, company_share, employee_share, earned_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 RETURNING commission_id, earned_at`,
                [ref, employeeId, booking.external_id, total, compShare, empShare]
            );
            const _commissionId = _led.rows[0].commission_id;
            const _earnedAt = _led.rows[0].earned_at;
            await _client.query(
                `INSERT INTO private.commission_receivables
                    (external_id, commission_id, booking_ref, builder_id, status,
                     expected_amount, accrued_at, notes, created_by)
                 SELECT $1, $2, $3,
                        (SELECT pr.builder_id FROM private.projects pr
                          WHERE pr.project_id = $4 AND pr.deleted_at IS NULL),
                        'accrued', $5, $6, $7, $8
                  WHERE NOT EXISTS (
                        SELECT 1 FROM private.commission_receivables r
                         WHERE r.commission_id = $2 AND r.deleted_at IS NULL)`,
                [rcvRef, _commissionId, booking.external_id, booking.project_id,
                 total, _earnedAt, 'Auto-created with commission ' + ref, createdBy]
            );
            // §18.2 auto-accrual — the exec's incentive from employee_share × the
            // matching active slab, born at 'accrued' 1:1 with this commission.
            // Idempotent: ON CONFLICT DO NOTHING via uq_incentive_commission_live,
            // so re-logging never duplicates. No matching slab -> no entry (harmless).
            await _client.query(
                `INSERT INTO private.incentive_entries
                    (employee_id, commission_id, base_amount, slab_rate, incentive_amount, status, notes)
                 SELECT $1, $2, $3::numeric, s.rate_percent,
                        ROUND($3::numeric * s.rate_percent / 100.0, 2), 'accrued',
                        'Auto-accrued with ' || $4
                   FROM private.incentive_slabs s
                  WHERE s.active AND s.deleted_at IS NULL
                    AND $3::numeric > 0
                    AND $3::numeric >= s.min_amount
                    AND ($3::numeric < s.max_amount OR s.max_amount IS NULL)
                  ORDER BY s.min_amount DESC
                  LIMIT 1
                 ON CONFLICT (commission_id) WHERE deleted_at IS NULL DO NOTHING`,
                [employeeId, _commissionId, empShare, ref]
            );
            await _client.query('RELEASE SAVEPOINT sp_commission');
            await _client.query('COMMIT');
        } catch (_txErr) {
            await _client.query('ROLLBACK').catch(() => {});
            throw _txErr;
        } finally {
            _client.release();
        }

        try {
            await pool.query(
                `INSERT INTO private.history_log (entity_type, action, changed_by_name, notes, created_at)
                 VALUES ('commission', 'create', $1, $2, NOW())`,
                [(req.session.user && req.session.user.name) || 'Admin',
                 `Commission ${ref} logged for booking ${booking.external_id} â€” amount ${total}`]
            );
        } catch (e) { /* ignore */ }

        req.flash('success', `Commission ${ref} logged (â‚¹${total}).`);
        res.redirect('/admin/bookings');
    } catch (err) {
        console.error('[bookings/:id/commission] failed:', err.message);
        req.flash('error', 'Could not log commission â€” see server log.');
        res.redirect('/admin/bookings');
    }
});

// ---------------------------------------------------------------------
// ADVANCE BOOKING STAGE (confirmation workflow)
// pending -> builder_confirmed -> allotted. Forward-only, manual,
// history-logged. booking_stage is distinct from payment_status (money).
// ---------------------------------------------------------------------
const STAGE_NEXT = { pending: 'builder_confirmed', builder_confirmed: 'allotted' };
const STAGE_STAMP = { builder_confirmed: 'builder_confirmed_at', allotted: 'allotted_at' };

router.post('/bookings/:id/stage', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const paymentId = req.params.id;
    if (!UUID_RE.test(paymentId)) {
        req.flash('error', 'Invalid booking.');
        return res.redirect('/admin/bookings');
    }
    const to = (req.body.to || '').toString().trim();

    const client = await pool.connect();
    let fromStage = null, toStage = null, bookingRef = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_stage');

        const cur = await client.query(
            `SELECT booking_stage::text AS stage, external_id FROM private.payments WHERE payment_id = $1`,
            [paymentId]
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error', 'Booking not found.');
            return res.redirect('/admin/bookings');
        }
        fromStage = cur.rows[0].stage;
        bookingRef = cur.rows[0].external_id;
        const expected = STAGE_NEXT[fromStage];

        if (!expected) {
            await client.query('ROLLBACK');
            req.flash('error', `Booking ${bookingRef} is already allotted — no further stage.`);
            return res.redirect('/admin/bookings');
        }
        // if the form sent an explicit target, it must match the only legal next step
        if (to && to !== expected) {
            await client.query('ROLLBACK');
            req.flash('error', `Invalid transition ${fromStage} → ${to}. Only ${fromStage} → ${expected} is allowed.`);
            return res.redirect('/admin/bookings');
        }
        toStage = expected;

        const employeeId = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;
        const stampCol = STAGE_STAMP[toStage]; // fixed identifier, not user input

        await client.query(
            `UPDATE private.payments
                SET booking_stage = $1::private.booking_stage,
                    ${stampCol} = NOW(),
                    stage_updated_by = $2
              WHERE payment_id = $3`,
            [toStage, employeeId, paymentId]
        );

        await client.query('RELEASE SAVEPOINT sp_stage');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[bookings/:id/stage] failed:', err.message);
        req.flash('error', 'Could not advance booking stage — see server log.');
        return res.redirect('/admin/bookings');
    } finally {
        client.release();
    }

    try {
        await pool.query(
            `INSERT INTO private.history_log (entity_type, entity_id, action, field_name, old_value, new_value, changed_by_name, notes, created_at)
             VALUES ('booking', $1, 'stage', 'booking_stage', $2, $3, $4, $5, NOW())`,
            [paymentId, fromStage, toStage,
             (req.session.user && req.session.user.name) || 'Admin',
             `Booking ${bookingRef} stage ${fromStage} → ${toStage}`]
        );
    } catch (e) { /* logging never blocks */ }

    req.flash('success', `Booking ${bookingRef} advanced to ${toStage.replace(/_/g, ' ')}.`);
    res.redirect('/admin/bookings');
});

// ---------------------------------------------------------------------
// DELETE BOOKING (ruling #3) — super_admin = direct soft-delete (no ticket);
// admin = FROZEN approval ticket for super_admin. Mirrors property/unit delete.
// ---------------------------------------------------------------------
router.post('/bookings/:id/delete', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const user = req.session.user;
    const paymentId = req.params.id;
    const reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();

    if (!UUID_RE.test(paymentId)) {
        req.flash('error', 'Invalid booking.');
        return res.redirect('/admin/bookings');
    }

    const rows = await safe(
        `SELECT payment_id, external_id, amount FROM private.payments
          WHERE payment_id = $1 AND deleted_at IS NULL`, [paymentId], []);
    if (rows.length === 0) {
        req.flash('error', 'Booking not found or already deleted.');
        return res.redirect('/admin/bookings');
    }
    const booking = rows[0];

    // SUPER ADMIN GOD MODE — immediate soft-delete, no ticket.
    if (isSuper(user)) {
        const r = await executeDirect('booking_delete', booking.payment_id);
        if (!r.ok) { req.flash('error', 'Could not delete booking: ' + r.error); return res.redirect('/admin/bookings'); }
        try {
            await logFromRequest(req, {
                entityType: 'booking', entityId: booking.external_id, action: 'delete',
                notes: `${user.name} (super_admin) directly deleted booking "${booking.external_id}" — direct super_admin action`,
            });
        } catch (_) {}
        req.flash('success', `Booking "${booking.external_id}" deleted (direct super_admin action).`);
        return res.redirect('/admin/bookings');
    }

    // ADMIN — raise a FROZEN approval ticket (don't duplicate a pending one).
    const dup = await safe(
        `SELECT 1 FROM private.approvals
          WHERE target_table = 'payments' AND target_id = $1
            AND action_type = 'booking_delete' AND status = 'pending'`, [paymentId], []);
    if (dup.length > 0) {
        req.flash('error', `A deletion request for booking "${booking.external_id}" is already awaiting Super Admin approval.`);
        return res.redirect('/admin/bookings');
    }
    try {
        await createApprovalTicket({
            actionType: 'booking_delete', targetTable: 'payments',
            targetId: booking.payment_id, targetLabel: booking.external_id,
            requestedBy: user.employee_id || user.id, requestedByName: user.name || 'Unknown',
            reason: reason || null, oldValue: { external_id: booking.external_id, amount: booking.amount }, newValue: null,
        });
        req.flash('success', `Deletion request for booking "${booking.external_id}" sent to Super Admin. It stays active until approved.`);
    } catch (err) {
        req.flash('error', userSafeError(err, 'Could not submit the deletion request. Please try again.'));
    }
    return res.redirect('/admin/bookings');
});

// ---------------------------------------------------------------------
// PHASE 3 · D — POSSESSION on a booking (payments row). Rides bookings.manage.
// Ruling: possession_status='completed' REQUIRES possession_date (enforced here,
// not a DB constraint — historical rows may lack a date).
// ---------------------------------------------------------------------
const POSSESSION_STATUSES = ['pending', 'offered', 'completed'];
router.post('/bookings/:id/possession', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const paymentId = req.params.id;
    const back = (req.body.back && String(req.body.back).trim()) || '/admin/bookings';
    if (!UUID_RE.test(paymentId)) { req.flash('error', 'Invalid booking.'); return res.redirect(back); }
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    const status = t(req.body.possession_status);
    const pdate = t(req.body.possession_date);
    if (status !== null && !POSSESSION_STATUSES.includes(status)) { req.flash('error', 'Invalid possession status.'); return res.redirect(back); }
    if (status === 'completed' && !pdate) { req.flash('error', 'A completed possession needs a possession date.'); return res.redirect(back); }
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_poss');
        const r = await client.query(
            `UPDATE private.payments SET possession_status=$1, possession_date=$2
              WHERE payment_id=$3 AND deleted_at IS NULL`, [status, pdate, paymentId]);
        await client.query('RELEASE SAVEPOINT sp_poss'); await client.query('COMMIT');
        req.flash(r.rowCount ? 'success' : 'error', r.rowCount ? 'Possession updated.' : 'Booking not found.');
        res.redirect(back);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[bookings] possession update failed:', e.message);
        req.flash('error', 'Could not update possession.');
        res.redirect(back);
    } finally { client.release(); }
});

module.exports = router;

