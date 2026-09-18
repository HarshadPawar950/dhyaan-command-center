// =============================================================
// routes/admin/assign.js
// Day 2 Phase 3 — Lead Assignment admin pages
//
// Routes:
//   GET  /admin/assign                  → assignment dashboard
//   POST /admin/assign/bulk             → assign N leads to 1 employee
//   POST /admin/assign/single           → assign or reassign one lead
//   POST /admin/assign/unassign         → remove an assignment
//
// Real-schema notes:
//   - assignments(assignment_id, external_id, lead_id, employee_id, assigned_at)
//   - FK lead_id → leads, FK employee_id → employees
//   - external_id like 'A0001'
//   - Trigger lead_status_trigger_assignment AFTER INSERT updates lead.status
//   - We do NOT delete-then-insert (would trigger twice); we delete old
//     assignments first, then insert new, inside a transaction
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { logFromRequest } = require('../../middleware/historyLogger');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/assign] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate next external_id for assignments (A2000, A2001, ...).
 * Atomic + collision-proof via private.assignment_code_seq (migration 057).
 * Replaces MAX(digits of external_id)::int + 1, which string-concatenated
 * pg's bigint-as-string into repunit codes. nextval() never reads the
 * external_id column; ::text so we concatenate (no arithmetic). The
 * existence-check retry backstops the UNIQUE index on external_id.
 */
async function nextAssignmentCode(client) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const r = await client.query(`SELECT nextval('private.assignment_code_seq')::text AS n`);
        const code = 'A' + r.rows[0].n.padStart(4, '0');
        const hit = await client.query(
            `SELECT 1 FROM private.assignments WHERE external_id = $1 LIMIT 1`, [code]);
        if (hit.rowCount === 0) return code;
    }
    throw new Error('Could not allocate a unique assignment code after 50 attempts');
}

// =============================================================
// GET /admin/assign — dashboard view
// =============================================================
router.get('/assign', ensureAdmin, ensurePermission('leads.reassign'), async (req, res) => {

    // Employees with their current lead counts
    const employees = await safe(
        `SELECT
             e.employee_id,
             e.external_id,
             e.name,
             COALESCE(e.role, '') AS job_title,
             COALESCE(e.access_role, 'employee') AS access_role,
             COALESCE(COUNT(DISTINCT a.lead_id), 0)::int AS lead_count
           FROM private.employees e
      LEFT JOIN private.assignments a ON a.employee_id = e.employee_id
          WHERE e.status = 'active'::private.employee_status
            AND COALESCE(e.access_role, 'employee') = 'employee'
       GROUP BY e.employee_id, e.external_id, e.name, e.role, e.access_role
       ORDER BY lead_count DESC, e.name`,
        [],
        []
    );

    // Optional filter: ?show=unassigned | assigned | all  (default unassigned)
    const showFilter = (req.query.show || 'unassigned').toLowerCase();

    let leadsSql;
    if (showFilter === 'all') {
        leadsSql = `
            SELECT l.lead_id,
                   COALESCE(l.external_id, '')      AS external_id,
                   l.name,
                   COALESCE(l.phone, '')            AS phone,
                   COALESCE(l.location, '')         AS location,
                   COALESCE(l.budget, '')           AS budget,
                   COALESCE(l.status::text, 'cold') AS status,
                   l.created_at,
                   (SELECT e.name FROM private.assignments a
                      JOIN private.employees e ON e.employee_id = a.employee_id
                     WHERE a.lead_id = l.lead_id
                     ORDER BY a.assigned_at DESC LIMIT 1) AS assigned_to_name,
                   (SELECT e.external_id FROM private.assignments a
                      JOIN private.employees e ON e.employee_id = a.employee_id
                     WHERE a.lead_id = l.lead_id
                     ORDER BY a.assigned_at DESC LIMIT 1) AS assigned_to_code
              FROM private.leads l
          ORDER BY l.created_at DESC NULLS LAST
             LIMIT 500
        `;
    } else if (showFilter === 'assigned') {
        leadsSql = `
            SELECT l.lead_id,
                   COALESCE(l.external_id, '')      AS external_id,
                   l.name,
                   COALESCE(l.phone, '')            AS phone,
                   COALESCE(l.location, '')         AS location,
                   COALESCE(l.budget, '')           AS budget,
                   COALESCE(l.status::text, 'cold') AS status,
                   l.created_at,
                   e.name        AS assigned_to_name,
                   e.external_id AS assigned_to_code
              FROM private.leads l
              JOIN private.assignments a ON a.lead_id = l.lead_id
              JOIN private.employees e ON e.employee_id = a.employee_id
          ORDER BY l.created_at DESC NULLS LAST
             LIMIT 500
        `;
    } else {
        // unassigned (default)
        leadsSql = `
            SELECT l.lead_id,
                   COALESCE(l.external_id, '')      AS external_id,
                   l.name,
                   COALESCE(l.phone, '')            AS phone,
                   COALESCE(l.location, '')         AS location,
                   COALESCE(l.budget, '')           AS budget,
                   COALESCE(l.status::text, 'cold') AS status,
                   l.created_at,
                   NULL AS assigned_to_name,
                   NULL AS assigned_to_code
              FROM private.leads l
             WHERE NOT EXISTS (
                 SELECT 1 FROM private.assignments a WHERE a.lead_id = l.lead_id
             )
          ORDER BY l.created_at DESC NULLS LAST
             LIMIT 500
        `;
    }

    const leads = await safe(leadsSql, [], []);

    // Stats for the header
    const counts = await safe(
        `SELECT
             (SELECT COUNT(*)::int FROM private.leads) AS total_leads,
             (SELECT COUNT(*)::int FROM private.leads l
                WHERE NOT EXISTS (
                    SELECT 1 FROM private.assignments a WHERE a.lead_id = l.lead_id
                )) AS unassigned_leads,
             (SELECT COUNT(DISTINCT lead_id)::int FROM private.assignments) AS assigned_leads`,
        [],
        [{ total_leads: 0, unassigned_leads: 0, assigned_leads: 0 }]
    );

    res.render('admin/assign', {
        pageTitle: 'Lead Assignment',
        user: req.session.user,
        employees,
        leads,
        showFilter,
        stats: counts[0],
        flash: req.session.assignFlash || null,
    });

    // Clear flash after rendering
    if (req.session.assignFlash) {
        req.session.assignFlash = null;
    }
});

// =============================================================
// POST /admin/assign/bulk — assign multiple leads to one employee
//
// Body: { lead_ids: [uuid, uuid, ...], employee_id: uuid, mode: 'assign'|'reassign' }
// =============================================================
router.post('/assign/bulk', ensureAdmin, ensurePermission('leads.reassign'), async (req, res) => {
    const actor = req.session.user;
    const employeeId = (req.body && req.body.employee_id || '').trim();
    let leadIds = req.body && req.body.lead_ids;
    if (!Array.isArray(leadIds)) leadIds = leadIds ? [leadIds] : [];
    leadIds = leadIds.filter(id => typeof id === 'string' && UUID_RE.test(id));

    if (!UUID_RE.test(employeeId) || leadIds.length === 0) {
        req.session.assignFlash = {
            type: 'error',
            text: 'Please select at least one lead and a valid employee.'
        };
        return res.redirect('/admin/assign');
    }

    const client = await pool.connect();
    let assignedCount = 0;
    let employeeName = '';

    try {
        await client.query('BEGIN');

        // Verify employee exists & is an active sales employee
        const eRes = await client.query(
            `SELECT employee_id, external_id, name
               FROM private.employees
              WHERE employee_id = $1
                AND status = 'active'::private.employee_status
              LIMIT 1`,
            [employeeId]
        );
        if (eRes.rows.length === 0) {
            await client.query('ROLLBACK');
            req.session.assignFlash = { type: 'error', text: 'Employee not found or not active.' };
            return res.redirect('/admin/assign');
        }
        const emp = eRes.rows[0];
        employeeName = emp.name;

        // Process each lead one-by-one inside the transaction
        for (const leadId of leadIds) {
            // Look up the lead's current owner (if any)
            const curRes = await client.query(
                `SELECT a.assignment_id,
                        e.external_id AS prev_code,
                        e.name        AS prev_name
                   FROM private.assignments a
                   JOIN private.employees e ON e.employee_id = a.employee_id
                  WHERE a.lead_id = $1
                  ORDER BY a.assigned_at DESC
                  LIMIT 1`,
                [leadId]
            );
            const cur = curRes.rows[0] || null;

            // If already assigned to the SAME employee — skip silently
            if (cur && cur.prev_code === emp.external_id) {
                continue;
            }

            // If assigned to someone else — delete old assignments
            if (cur) {
                await client.query(
                    `DELETE FROM private.assignments WHERE lead_id = $1`,
                    [leadId]
                );
            }

            // Insert new assignment (this fires the lead_status trigger)
            const code = await nextAssignmentCode(client);
            await client.query(
                `INSERT INTO private.assignments (external_id, lead_id, employee_id)
                 VALUES ($1, $2, $3)`,
                [code, leadId, employeeId]
            );
            assignedCount++;

            // Audit log
            const leadRes = await client.query(
                `SELECT external_id, name FROM private.leads WHERE lead_id = $1 LIMIT 1`,
                [leadId]
            );
            const leadInfo = leadRes.rows[0] || {};
            await logFromRequest(req, {
                entityType: 'lead',
                entityId: leadInfo.external_id || leadId,
                action: cur ? 'reassign' : 'assign',
                fieldName: 'assigned_to',
                oldValue: cur ? cur.prev_code : null,
                newValue: emp.external_id,
                notes: `${actor.name} ${cur ? 'reassigned' : 'assigned'} lead "${leadInfo.name || leadId}" ${cur ? `from ${cur.prev_name} to` : 'to'} ${emp.name}`,
            });
        }

        await client.query('COMMIT');

        req.session.assignFlash = {
            type: 'success',
            text: `${assignedCount} lead${assignedCount === 1 ? '' : 's'} assigned to ${employeeName}.`
        };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin/assign] bulk error:', err);
        req.session.assignFlash = {
            type: 'error',
            text: userSafeError(err, 'Assignment failed. Please try again.')
        };
    } finally {
        client.release();
    }

    return res.redirect('/admin/assign');
});

// =============================================================
// POST /admin/assign/single — assign or reassign one lead
//
// Body: { lead_id, employee_id, return_to: '/admin/leads/...' | '/admin/assign' }
// Used from the lead detail page or quick action.
// =============================================================
router.post('/assign/single', ensureAdmin, ensurePermission('leads.reassign'), async (req, res) => {
    const actor = req.session.user;
    const leadId = (req.body && req.body.lead_id || '').trim();
    const employeeId = (req.body && req.body.employee_id || '').trim();
    const returnTo = (req.body && req.body.return_to) || '/admin/assign';

    if (!UUID_RE.test(leadId) || !UUID_RE.test(employeeId)) {
        req.session.assignFlash = { type: 'error', text: 'Invalid lead or employee.' };
        return res.redirect(returnTo);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const eRes = await client.query(
            `SELECT employee_id, external_id, name
               FROM private.employees
              WHERE employee_id = $1
                AND status = 'active'::private.employee_status
              LIMIT 1`,
            [employeeId]
        );
        if (eRes.rows.length === 0) {
            await client.query('ROLLBACK');
            req.session.assignFlash = { type: 'error', text: 'Employee not found or not active.' };
            return res.redirect(returnTo);
        }
        const emp = eRes.rows[0];

        const curRes = await client.query(
            `SELECT a.assignment_id,
                    e.external_id AS prev_code,
                    e.name        AS prev_name
               FROM private.assignments a
               JOIN private.employees e ON e.employee_id = a.employee_id
              WHERE a.lead_id = $1
              ORDER BY a.assigned_at DESC
              LIMIT 1`,
            [leadId]
        );
        const cur = curRes.rows[0] || null;

        if (cur && cur.prev_code === emp.external_id) {
            await client.query('COMMIT');
            req.session.assignFlash = { type: 'info', text: 'Lead is already assigned to that employee.' };
            return res.redirect(returnTo);
        }

        if (cur) {
            await client.query(`DELETE FROM private.assignments WHERE lead_id = $1`, [leadId]);
        }

        const code = await nextAssignmentCode(client);
        await client.query(
            `INSERT INTO private.assignments (external_id, lead_id, employee_id) VALUES ($1, $2, $3)`,
            [code, leadId, employeeId]
        );

        const leadRes = await client.query(
            `SELECT external_id, name FROM private.leads WHERE lead_id = $1 LIMIT 1`,
            [leadId]
        );
        const leadInfo = leadRes.rows[0] || {};

        await logFromRequest(req, {
            entityType: 'lead',
            entityId: leadInfo.external_id || leadId,
            action: cur ? 'reassign' : 'assign',
            fieldName: 'assigned_to',
            oldValue: cur ? cur.prev_code : null,
            newValue: emp.external_id,
            notes: `${actor.name} ${cur ? 'reassigned' : 'assigned'} lead "${leadInfo.name || leadId}" ${cur ? `from ${cur.prev_name} to` : 'to'} ${emp.name}`,
        });

        await client.query('COMMIT');
        req.session.assignFlash = {
            type: 'success',
            text: `Lead ${cur ? 'reassigned' : 'assigned'} to ${emp.name}.`
        };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin/assign] single error:', err);
        req.session.assignFlash = { type: 'error', text: userSafeError(err, 'Assignment failed. Please try again.') };
    } finally {
        client.release();
    }

    return res.redirect(returnTo);
});

// =============================================================
// POST /admin/assign/unassign — remove a lead's assignment
//
// Body: { lead_id, return_to }
// =============================================================
router.post('/assign/unassign', ensureAdmin, ensurePermission('leads.reassign'), async (req, res) => {
    const actor = req.session.user;
    const leadId = (req.body && req.body.lead_id || '').trim();
    const returnTo = (req.body && req.body.return_to) || '/admin/assign';

    if (!UUID_RE.test(leadId)) {
        req.session.assignFlash = { type: 'error', text: 'Invalid lead.' };
        return res.redirect(returnTo);
    }

    try {
        // Find current owner for logging
        const curRes = await pool.query(
            `SELECT e.external_id AS prev_code, e.name AS prev_name,
                    l.external_id AS lead_code, l.name AS lead_name
               FROM private.assignments a
               JOIN private.employees e ON e.employee_id = a.employee_id
               JOIN private.leads l     ON l.lead_id = a.lead_id
              WHERE a.lead_id = $1
              ORDER BY a.assigned_at DESC
              LIMIT 1`,
            [leadId]
        );

        if (curRes.rows.length === 0) {
            req.session.assignFlash = { type: 'info', text: 'Lead was already unassigned.' };
            return res.redirect(returnTo);
        }
        const cur = curRes.rows[0];

        await pool.query(`DELETE FROM private.assignments WHERE lead_id = $1`, [leadId]);

        await logFromRequest(req, {
            entityType: 'lead',
            entityId: cur.lead_code || leadId,
            action: 'unassign',
            fieldName: 'assigned_to',
            oldValue: cur.prev_code,
            newValue: null,
            notes: `${actor.name} unassigned lead "${cur.lead_name}" from ${cur.prev_name}`,
        });

        req.session.assignFlash = {
            type: 'success',
            text: `Lead unassigned from ${cur.prev_name}.`
        };
    } catch (err) {
        console.error('[admin/assign] unassign error:', err);
        req.session.assignFlash = { type: 'error', text: userSafeError(err, 'Unassign failed. Please try again.') };
    }

    return res.redirect(returnTo);
});

module.exports = router;
