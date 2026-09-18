// =============================================================
// routes/lead-new.js
// Add New Lead — for employees (and admin)
//
// Routes:
//   GET  /leads/new       → show beautiful form
//   POST /leads/new       → create lead + auto-assign to creator
//
// Schema notes:
//   - leads PK = lead_id (uuid), external_id = 'L0001'+
//   - assignments table links lead → employee
//   - Lead trigger auto-updates status on assignment
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAuthenticated } = require('../middleware/auth');
const { backFor } = require('../lib/navHome');
const { logFromRequest } = require('../middleware/historyLogger');
const {
    normalizePhone, findActiveDuplicate, eligibleExecs, roundRobinPick,
} = require('../middleware/leadAssignment');
const { amenitiesMaster } = require('../lib/projectExtras');
const { cpData, cpErrors, cpEcho, saveClientProfile } = require('../lib/clientProfile');

const PHONE_RE = /^[+\d][\d\s\-()]{6,20}$/;

// Admin-only capability (dedup override). Mirrors adminAuth's role check.
function isAdminRole(user) {
    const r = user && (user.role || user.access_role);
    return r === 'admin' || r === 'super_admin';
}

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[leads/new] query failed:', err.message);
        return fallback;
    }
}

// Atomic, collision-proof code allocation via dedicated sequences
// (migration 057: private.lead_code_seq / private.assignment_code_seq, each START 2000).
//
// The old generators did MAX(digits of external_id)::bigint + 1 in JS, but pg returns
// bigint as a STRING so `(max || 0) + 1` CONCATENATED — every create appended a '1',
// growing an all-1s repunit code until the 20th overflowed bigint and blocked all
// creation. On leads it was worse: a phone-number poison row (8826949899, mutated to
// L88269498991) was being read as the "highest lead code". nextval() sidesteps all of
// it: atomic (concurrency-safe — two creates can never get the same number) and never
// reads the poisoned external_id column. ::text so we CONCATENATE (no arithmetic → no
// repeat of the string-concat bug). Seed 2000 sits in the repunit-free corridor
// (1111 < 2000 < 11111); the existence-check retry is a backstop against any code
// already taken (leads.external_id / assignments.external_id are UNIQUE).
async function nextLeadCode(client) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const r = await client.query(`SELECT nextval('private.lead_code_seq')::text AS n`);
        const code = 'L' + r.rows[0].n.padStart(4, '0');
        const hit = await client.query(
            `SELECT 1 FROM private.leads WHERE external_id = $1 LIMIT 1`, [code]);
        if (hit.rowCount === 0) return code;
    }
    throw new Error('Could not allocate a unique lead code after 50 attempts');
}

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
// GET /leads/new — show the form
// =============================================================
router.get('/new', ensureAuthenticated, async (req, res) => {

    // Pull existing dropdown values from DB for source
    const sources = await safe(
        `SELECT DISTINCT source::text AS s FROM private.leads
          WHERE source IS NOT NULL ORDER BY s`,
        [], []
    );

    // Common locations (top 10 most-used)
    const locations = await safe(
        `SELECT location, COUNT(*)::int AS c FROM private.leads
          WHERE location IS NOT NULL AND location <> ''
       GROUP BY location ORDER BY c DESC LIMIT 10`,
        [], []
    );

    // Eligible round-robin execs for the "Assign to" selector (Auto default).
    const execs = await safe(
        `SELECT employee_id, external_id, name FROM private.employees
          WHERE access_role = 'employee' AND external_id ~ '^E[0-9]{3,}$' AND status = 'active'
            AND email NOT LIKE '%@dhyaan.local'
          ORDER BY external_id`, [], []
    );

    const amen = await amenitiesMaster();

    res.render('lead-new', {
        pageTitle: 'Add New Lead',
        user: req.session.user,
        sources: sources.map(r => r.s).filter(Boolean),
        locations: locations.map(r => r.location),
        amenityGroups: amen.byCategory,
        flash: req.session.leadNewFlash || null,
        formData: req.session.leadNewFormData || {},
        csrfToken: req.csrfToken(),
        execs,
        isAdmin: isAdminRole(req.session.user),
        // Dedup block panel: existing active lead + owner when the last submit hit a duplicate.
        duplicate: req.session.leadNewDuplicate || null,
    });

    // Clear flash + one-shot dedup panel after render
    req.session.leadNewFlash = null;
    req.session.leadNewFormData = null;
    req.session.leadNewDuplicate = null;
});

// =============================================================
// POST /leads/new — create the lead
// =============================================================
router.post('/new', ensureAuthenticated, async (req, res) => {
    const user = req.session.user;
    const body = req.body || {};

    // Trim + collect form data
    const data = {
        name:               (body.name || '').trim(),
        phone:              (body.phone || '').trim(),
        email:              (body.email || '').trim(),
        location:           (body.location || '').trim(),
        budget:             (body.budget || '').trim(),
        requirement:        (body.requirement || '').trim(),
        status:             (body.status || 'cold').trim().toLowerCase(),
        source:             (body.source || '').trim(),
        site_visit_date:    (body.site_visit_date || '').trim(),
        next_action:        (body.next_action || '').trim(),
        next_action_date:   (body.next_action_date || '').trim(),
        initial_feedback:   (body.initial_feedback || '').trim(),
        assignee:           (body.assignee || 'auto').trim(),
    };

    // -------- VALIDATION --------
    const errors = [];
    if (!data.name || data.name.length < 2) {
        errors.push('Name is required (at least 2 characters).');
    }
    if (!data.phone) {
        errors.push('Phone number is required.');
    } else if (!PHONE_RE.test(data.phone)) {
        errors.push('Phone number format looks invalid.');
    }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        errors.push('Email format looks invalid.');
    }
    if (!['cold', 'warm', 'hot'].includes(data.status)) {
        data.status = 'cold';
    }
    // Client Profile — Urgency Note is required (min 50 chars): the discipline field.
    errors.push(...cpErrors(body));

    if (errors.length > 0) {
        req.session.leadNewFlash = { type: 'error', text: errors.join(' ') };
        req.session.leadNewFormData = { ...data, ...cpEcho(body) };
        return res.redirect('/leads/new');
    }

    // -------- DEDUP: block against ACTIVE leads only (soft-deleted never block).
    // Admin may override via the block-panel checkbox (history-logged).
    const normalizedPhone = normalizePhone(data.phone);
    const wantsOverride = isAdminRole(user) && (body.override_dup === '1' || body.override_dup === 'on');
    if (!wantsOverride) {
        const existing = await findActiveDuplicate(pool, normalizedPhone);
        if (existing) {
            req.session.leadNewDuplicate = existing;   // drives the block panel
            req.session.leadNewFlash = {
                type: 'error',
                text: `Possible duplicate — an active lead with this phone already exists: "${existing.name}" (${existing.external_id})${existing.owner_name ? ', owned by ' + existing.owner_name : ' (unassigned)'}.`
            };
            req.session.leadNewFormData = { ...data, ...cpEcho(body) };
            return res.redirect('/leads/new');
        }
    }

    // -------- INSERT IN TRANSACTION --------
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const leadCode = await nextLeadCode(client);

        // Try INSERT with the source column as enum cast; fallback if enum mismatch.
        // SAVEPOINT so the enum-fail catch isn't running inside an aborted txn
        // (mirrors lead-edit.js) — reviewer W1.
        let insertResult;
        await client.query('SAVEPOINT before_insert');
        try {
            insertResult = await client.query(
                `INSERT INTO private.leads
                    (external_id, name, phone, email, location, budget,
                     requirement, source, status, last_feedback,
                     next_action, next_action_date, site_visit_date)
                 VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
                         NULLIF($7, ''), NULLIF($8, '')::private.lead_source,
                         $9::private.lead_status, NULLIF($10, ''),
                         NULLIF($11, ''), NULLIF($12, '')::date, NULLIF($13, '')::date)
                 RETURNING lead_id, external_id, name`,
                [
                    leadCode, data.name, data.phone, data.email, data.location, data.budget,
                    data.requirement, data.source, data.status, data.initial_feedback,
                    data.next_action, data.next_action_date, data.site_visit_date,
                ]
            );
        } catch (err) {
            // Fallback: if source enum value isn't valid, try without source
            console.warn('[leads/new] source enum failed, retrying without:', err.message);
            await client.query('ROLLBACK TO SAVEPOINT before_insert');
            insertResult = await client.query(
                `INSERT INTO private.leads
                    (external_id, name, phone, email, location, budget,
                     requirement, status, last_feedback,
                     next_action, next_action_date, site_visit_date)
                 VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
                         NULLIF($7, ''), $8::private.lead_status, NULLIF($9, ''),
                         NULLIF($10, ''), NULLIF($11, '')::date, NULLIF($12, '')::date)
                 RETURNING lead_id, external_id, name`,
                [
                    leadCode, data.name, data.phone, data.email, data.location, data.budget,
                    data.requirement, data.status, data.initial_feedback,
                    data.next_action, data.next_action_date, data.site_visit_date,
                ]
            );
        }

        const newLead = insertResult.rows[0];

        // 027: persist the Client Profile in the same transaction.
        await saveClientProfile(client, cpData(body), newLead.lead_id);

        // -------- ASSIGNMENT: manual pick wins; else round-robin; else unassigned.
        let assignedTo = null;   // { employeeId, name } or null
        const chosen = (body.assignee || 'auto').toString().trim();
        if (chosen && chosen !== 'auto') {
            // Manual — must be one of the eligible execs (matches the dropdown).
            const eeq = await client.query(
                `SELECT employee_id, name FROM private.employees
                  WHERE employee_id = $1 AND access_role = 'employee'
                    AND external_id ~ '^E[0-9]{3,}$' AND status = 'active'
                    AND email NOT LIKE '%@dhyaan.local'`,
                [chosen]
            );
            if (eeq.rows.length) {
                assignedTo = { employeeId: eeq.rows[0].employee_id, name: eeq.rows[0].name };
            }
        }
        if (!assignedTo) {
            // Auto (or an invalid manual value) -> round-robin from the pointer.
            const pick = await roundRobinPick(client);   // null when zero eligible
            if (pick) assignedTo = { employeeId: pick.employeeId, name: pick.name };
        }
        if (assignedTo) {
            const assignCode = await nextAssignmentCode(client);
            await client.query(
                `INSERT INTO private.assignments (external_id, lead_id, employee_id)
                 VALUES ($1, $2, $3)`,
                [assignCode, newLead.lead_id, assignedTo.employeeId]
            );
        }

        await client.query('COMMIT');

        // Audit: creation
        await logFromRequest(req, {
            entityType: 'lead', entityId: newLead.external_id, action: 'create',
            newValue: newLead.name,
            notes: `${user.name} created lead "${newLead.name}" (${data.phone})` +
                   (assignedTo ? ` — assigned to ${assignedTo.name}` : ' — UNASSIGNED (no eligible exec)'),
        });
        // Audit: dedup override (admin-only), with the ruling's reason string.
        if (wantsOverride) {
            await logFromRequest(req, {
                entityType: 'lead', entityId: newLead.external_id, action: 'update',
                fieldName: 'duplicate_override', newValue: normalizedPhone || data.phone,
                notes: 'duplicate override',
            });
        }

        req.session.leadNewFlash = assignedTo
            ? { type: 'success', text: `Lead "${newLead.name}" created — assigned to ${assignedTo.name}.` }
            : { type: 'warning', text: `Lead "${newLead.name}" created but left UNASSIGNED — no eligible executive to round-robin to.` };
        // World-correct landing: an admin who created the lead returns to
        // /admin/leads, an employee to their own /leads — never cross-world.
        return res.redirect(backFor(req.session.user, 'leads'));

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[leads/new] insert error:', err);
        req.session.leadNewFlash = {
            type: 'error',
            text: userSafeError(err, 'Could not create the lead. Please check your entries and try again.')
        };
        req.session.leadNewFormData = { ...data, ...cpEcho(body) };
        return res.redirect('/leads/new');
    } finally {
        client.release();
    }
});

module.exports = router;
