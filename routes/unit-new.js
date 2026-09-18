// =============================================================
// routes/unit-new.js
// Add New Property — SINGULAR standalone listing (migration 026 sheet).
//
// Routes:
//   GET  /properties/new   → blank sheet-style form
//   POST /properties/new   → INSERT new standalone property
//
// DECOUPLED (021): a property is standalone; project_id is optional/legacy.
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAuthenticated } = require('../middleware/auth');
const { logFromRequest } = require('../middleware/historyLogger');
const { ensurePermission } = require('../middleware/permissions');
const { ensureAdminOrRole } = require('../middleware/ensureAdminOrRole');
const { buildUnitData, validateUnit, UNIT_INSERT_SQL, unitInsertParams } = require('../lib/unitForm');
const sheet = require('../lib/propertySheet');
const { amenitiesMaster } = require('../lib/projectExtras');

// D4 fix: adding inventory is a manager action (matches /admin/projects gate).
const propsManageGate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// owner email/notes visible to managers only (name+phone are public elsewhere)
function canSeeOwner(u) {
    return !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'
        || (Array.isArray(u.navPerms) && u.navPerms.indexOf('properties.manage') !== -1));
}

// =============================================================
// GET /properties/new — blank sheet form
// =============================================================
router.get('/new', ensureAuthenticated, propsManageGate, async (req, res) => {
    const amen = await amenitiesMaster();
    const fd = req.session.unitFormData || {};

    res.render('unit-new', {
        pageTitle: 'Add Property',
        user: req.session.user,
        sheet,
        isEdit: false,
        amenityGroups: amen.byCategory,
        selectedAmen: Array.isArray(fd.amenities) ? fd.amenities : [],
        canSeeOwnerInternal: canSeeOwner(req.session.user),
        flash: req.session.unitFlash || null,
        formData: fd,
        csrfToken: req.csrfToken(),
    });

    req.session.unitFlash = null;
    req.session.unitFormData = null;
});

// =============================================================
// POST /properties/new — create the standalone property
// =============================================================
router.post('/new', ensureAuthenticated, propsManageGate, async (req, res) => {
    const user = req.session.user;
    const body = req.body || {};

    const rawPid = (body.project_id || '').trim();
    const projectId = UUID_RE.test(rawPid) ? rawPid : null;

    const data = buildUnitData(body);
    const errors = validateUnit(data);
    if (errors.length > 0) {
        req.session.unitFlash = { type: 'error', text: errors.join(' ') };
        req.session.unitFormData = data;
        return res.redirect('/properties/new');
    }

    // SAVEPOINT-safe INSERT: if an enum/numeric cast trips, roll back to the
    // savepoint and save the core fields so the manager never loses the row.
    const client = await pool.connect();
    let result, firstError = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT before_insert');
        try {
            result = await client.query(UNIT_INSERT_SQL, unitInsertParams(data, projectId));
        } catch (err) {
            firstError = err.message;
            await client.query('ROLLBACK TO SAVEPOINT before_insert');
            result = await client.query(
                `INSERT INTO private.properties
                    (project_id, title, category)
                 VALUES ($1, NULLIF($2,''), NULLIF($3,'')::private.property_category)
                 RETURNING property_id, title, config`,
                [projectId, data.title, data.category]
            );
        }
        const created = result.rows[0];
        await client.query('COMMIT');

        try {
            await logFromRequest(req, {
                entityType: 'property_unit',
                entityId: created.property_id,
                action: 'create',
                newValue: created.title || created.config,
                notes: `${user.name} added property "${created.title || created.config}"`,
            });
        } catch (logErr) { console.warn('[units/new] audit log failed:', logErr.message); }

        let msg = `Property "${created.title || created.config}" added successfully.`;
        if (firstError) msg += ` [Note: some detailed fields were skipped — ${firstError}]`;
        req.session.propertiesListFlash = { type: 'success', text: msg };
        return res.redirect(`/properties/${created.property_id}`);

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[units/new] insert error:', err);
        req.session.unitFlash = { type: 'error', text: userSafeError(err, 'Could not add the property. Please try again.') };
        req.session.unitFormData = data;
        return res.redirect('/properties/new');
    } finally {
        client.release();
    }
});

module.exports = router;
