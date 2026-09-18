// =============================================================
// routes/lead-edit.js
// Edit Lead — admin + employee
//
// Routes:
//   GET  /leads/:id/edit   → pre-filled edit form
//   POST /leads/:id/edit   → UPDATE lead
//
// Day 6 — mirrors lead-new.js pattern. Uses SAVEPOINT safety
// (learned Day 5) for enum-cast resilience. Soft-delete aware:
// won't edit a lead where deleted_at IS NOT NULL.
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAuthenticated } = require('../middleware/auth');
const { logFromRequest } = require('../middleware/historyLogger');
const { amenitiesMaster } = require('../lib/projectExtras');
const { cpData, cpErrors, cpEcho, saveClientProfile, cpFormData } = require('../lib/clientProfile');

const PHONE_RE = /^[+\d][\d\s\-()]{6,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[leads/edit] query failed:', err.message);
        return fallback;
    }
}

// =============================================================
// Ownership guard — an employee may edit ONLY a lead assigned to them.
// Lead ownership lives in private.assignments (never on the leads row).
// super_admin + admin bypass (they manage any lead). Fail-CLOSED: a DB
// error yields [] (via safe's fallback) → treated as "not owner" → deny.
// =============================================================
async function ownsLead(user, leadId) {
    if (user && (user.access_role === 'super_admin' || user.access_role === 'admin')) {
        return true;
    }
    const rows = await safe(
        `SELECT 1 FROM private.assignments WHERE lead_id = $1 AND employee_id = $2 LIMIT 1`,
        [leadId, user && user.id],
        []
    );
    return rows.length > 0;
}

// =============================================================
// GET /leads/:id/edit — show pre-filled form
// =============================================================
router.get('/:id/edit', ensureAuthenticated, async (req, res) => {
    const leadId = req.params.id;

    if (!UUID_RE.test(leadId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    // Ownership gate — employees can only edit their own assigned leads.
    if (!(await ownsLead(req.session.user, leadId))) {
        req.flash('error_msg', 'You can only edit your own leads');
        return res.redirect('/leads');
    }

    // Fetch the lead (only if not soft-deleted)
    const rows = await safe(
        `SELECT lead_id,
                COALESCE(external_id, '')      AS external_id,
                name,
                COALESCE(phone, '')            AS phone,
                COALESCE(email, '')            AS email,
                COALESCE(location, '')         AS location,
                COALESCE(budget, '')           AS budget,
                COALESCE(requirement, '')      AS requirement,
                COALESCE(source::text, '')     AS source,
                COALESCE(status::text, 'cold') AS status,
                COALESCE(next_action, '')      AS next_action,
                next_action_date,
                site_visit_date,
                cp_configuration, COALESCE(cp_use,'') AS cp_use, cp_possession_pref,
                COALESCE(cp_funding,'') AS cp_funding, cp_down_payment,
                COALESCE(cp_budget_tag,'') AS cp_budget_tag, cp_amenities,
                COALESCE(cp_visit_pref,'') AS cp_visit_pref, COALESCE(cp_urgency_note,'') AS cp_urgency_note,
                -- 029 v2 profile cols — MUST be fetched or an edit would NULL them out
                COALESCE(cp_budget_other,'') AS cp_budget_other,
                COALESCE(cp_layout_pref,'') AS cp_layout_pref,
                COALESCE(cp_occupation,'') AS cp_occupation,
                COALESCE(cp_amenities_pref,'') AS cp_amenities_pref,
                COALESCE(cp_community_pref,'') AS cp_community_pref,
                cp_floor_pref,
                COALESCE(cp_purchase_timeline,'') AS cp_purchase_timeline,
                COALESCE(cp_projects_visited,'') AS cp_projects_visited,
                COALESCE(cp_current_residence,'') AS cp_current_residence
           FROM private.leads
          WHERE lead_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [leadId],
        []
    );

    if (rows.length === 0) {
        return res.status(404).render('404', { pageTitle: 'Lead Not Found' });
    }
    const lead = rows[0];

    // Format dates for HTML date inputs (yyyy-mm-dd)
    const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        if (isNaN(dt)) return '';
        return dt.toISOString().slice(0, 10);
    };

    // Source dropdown values
    const sources = await safe(
        `SELECT DISTINCT source::text AS s FROM private.leads
          WHERE source IS NOT NULL ORDER BY s`,
        [], []
    );
    const locations = await safe(
        `SELECT location, COUNT(*)::int AS c FROM private.leads
          WHERE location IS NOT NULL AND location <> ''
       GROUP BY location ORDER BY c DESC LIMIT 10`,
        [], []
    );

    // Build formData from existing lead (so the shared form pre-fills)
    const formData = {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        location: lead.location,
        budget: lead.budget,
        requirement: lead.requirement,
        status: lead.status,
        source: lead.source,
        next_action: lead.next_action,
        next_action_date: fmtDate(lead.next_action_date),
        site_visit_date: fmtDate(lead.site_visit_date),
        // 027 + 029 Client Profile
        ...cpFormData(lead),
    };
    // Preserve a blocked edit's profile edits (e.g. urgency < 50) over DB values.
    const formDataMerged = { ...formData, ...(req.session.leadEditFormData || {}) };
    req.session.leadEditFormData = null;

    const amen = await amenitiesMaster();

    res.render('lead-edit', {
        pageTitle: 'Edit Lead — ' + lead.name,
        user: req.session.user,
        leadId: lead.lead_id,
        externalId: lead.external_id,
        sources: sources.map(r => r.s).filter(Boolean),
        locations: locations.map(r => r.location),
        amenityGroups: amen.byCategory,
        flash: req.session.leadEditFlash || null,
        formData: formDataMerged,
        csrfToken: req.csrfToken(),
    });

    req.session.leadEditFlash = null;
});

// =============================================================
// POST /leads/:id/edit — update the lead
// =============================================================
router.post('/:id/edit', ensureAuthenticated, async (req, res) => {
    const user = req.session.user;
    const leadId = req.params.id;
    const body = req.body || {};

    if (!UUID_RE.test(leadId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    // Ownership gate — employees can only save their own assigned leads.
    if (!(await ownsLead(user, leadId))) {
        req.flash('error_msg', 'You can only edit your own leads');
        return res.redirect('/leads');
    }

    const data = {
        name:             (body.name || '').trim(),
        phone:            (body.phone || '').trim(),
        email:            (body.email || '').trim(),
        location:         (body.location || '').trim(),
        budget:           (body.budget || '').trim(),
        requirement:      (body.requirement || '').trim(),
        status:           (body.status || 'cold').trim().toLowerCase(),
        source:           (body.source || '').trim(),
        site_visit_date:  (body.site_visit_date || '').trim(),
        next_action:      (body.next_action || '').trim(),
        next_action_date: (body.next_action_date || '').trim(),
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
    // Client Profile — Urgency Note required (min 50 chars): the discipline field.
    errors.push(...cpErrors(body));

    if (errors.length > 0) {
        req.session.leadEditFlash = { type: 'error', text: errors.join(' ') };
        req.session.leadEditFormData = cpEcho(body);
        return res.redirect(`/leads/${leadId}/edit`);
    }

    // Phone uniqueness — but allow keeping own phone (exclude self)
    const dup = await safe(
        `SELECT lead_id, name FROM private.leads
          WHERE phone = $1 AND lead_id <> $2 AND deleted_at IS NULL
          LIMIT 1`,
        [data.phone, leadId],
        []
    );
    if (dup.length > 0) {
        req.session.leadEditFlash = {
            type: 'error',
            text: `Another lead with phone ${data.phone} already exists (${dup[0].name}).`
        };
        return res.redirect(`/leads/${leadId}/edit`);
    }

    // -------- UPDATE IN TRANSACTION WITH SAVEPOINT --------
    const client = await pool.connect();
    let firstError = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT before_update');

        let result;
        try {
            result = await client.query(
                `UPDATE private.leads SET
                    name = $1,
                    phone = NULLIF($2, ''),
                    email = NULLIF($3, ''),
                    location = NULLIF($4, ''),
                    budget = NULLIF($5, ''),
                    requirement = NULLIF($6, ''),
                    source = NULLIF($7, '')::private.lead_source,
                    status = $8::private.lead_status,
                    next_action = NULLIF($9, ''),
                    next_action_date = NULLIF($10, '')::date,
                    site_visit_date = NULLIF($11, '')::date
                 WHERE lead_id = $12 AND deleted_at IS NULL
                 RETURNING lead_id, external_id, name`,
                [
                    data.name, data.phone, data.email, data.location, data.budget,
                    data.requirement, data.source, data.status, data.next_action,
                    data.next_action_date, data.site_visit_date, leadId,
                ]
            );
        } catch (err) {
            firstError = err.message;
            console.warn('[leads/edit] full UPDATE failed, rolling back to savepoint:', err.message);
            await client.query('ROLLBACK TO SAVEPOINT before_update');

            // Fallback: update without source enum (common culprit)
            result = await client.query(
                `UPDATE private.leads SET
                    name = $1,
                    phone = NULLIF($2, ''),
                    email = NULLIF($3, ''),
                    location = NULLIF($4, ''),
                    budget = NULLIF($5, ''),
                    requirement = NULLIF($6, ''),
                    status = $7::private.lead_status,
                    next_action = NULLIF($8, ''),
                    next_action_date = NULLIF($9, '')::date,
                    site_visit_date = NULLIF($10, '')::date
                 WHERE lead_id = $11 AND deleted_at IS NULL
                 RETURNING lead_id, external_id, name`,
                [
                    data.name, data.phone, data.email, data.location, data.budget,
                    data.requirement, data.status, data.next_action,
                    data.next_action_date, data.site_visit_date, leadId,
                ]
            );
        }

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            req.session.leadEditFlash = { type: 'error', text: 'Lead not found or already deleted.' };
            return res.redirect('/admin/leads');
        }

        // 027: persist the Client Profile in the same transaction.
        await saveClientProfile(client, cpData(body), leadId);

        const updated = result.rows[0];
        await client.query('COMMIT');

        // Audit log (best-effort)
        try {
            await logFromRequest(req, {
                entityType: 'lead',
                entityId: updated.external_id,
                action: 'update',
                fieldName: null,
                oldValue: null,
                newValue: updated.name,
                notes: `${user.name} edited lead "${updated.name}"`,
            });
        } catch (logErr) {
            console.warn('[leads/edit] audit log failed (non-fatal):', logErr.message);
        }

        let msg = `Lead "${updated.name}" updated successfully.`;
        if (firstError) {
            msg += ' (Note: the source field was skipped due to a formatting issue — re-select it and save again.)';
        }
        req.session.leadEditFlash = { type: 'success', text: msg };
        return res.redirect(`/admin/leads/${leadId}`);

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[leads/edit] update error:', err);
        req.session.leadEditFlash = {
            type: 'error',
            text: userSafeError(err, 'Could not update the lead. Please check your entries and try again.')
        };
        return res.redirect(`/leads/${leadId}/edit`);
    } finally {
        client.release();
    }
});

module.exports = router;
