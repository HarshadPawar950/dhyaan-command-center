// =====================================================================
// routes/admin/restore-archive.js — RESTORE ARCHIVE (super admin only)
// Mount: app.use('/admin', adminRestoreRoutes)
// Routes:
//   GET  /admin/super/restore                  -> list all soft-deleted records
//   POST /admin/super/restore/lead/:id         -> un-delete a lead     (SAVEPOINT + history)
//   POST /admin/super/restore/property/:id     -> un-delete a property (SAVEPOINT + history)
//   POST /admin/super/restore/unit/:id         -> un-delete a unit     (SAVEPOINT + history)
// Blueprint: Super Admin "restore archived data". Anti-loophole: no hard deletes,
//            every restore is logged to history_log.
// Soft-delete only. private. schema throughout.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');
const ejs = require('ejs');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// safe query wrapper
async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/restore] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// render a layout partial to an HTML string (nuclear include-bypass pattern)
async function renderPartial(name, data) {
    try {
        return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data);
    } catch (e) {
        console.error('partial ' + name + ' failed:', e.message);
        return '';
    }
}

// write a row into the audit trail (best-effort; never blocks the restore)
async function logRestore(client, req, entityType, entityId, label) {
    try {
        const u = req.session.user || {};
        await client.query(
            `INSERT INTO private.history_log
                (entity_type, entity_id, action, field_name, old_value, new_value,
                 changed_by_code, changed_by_name, changed_by_role, ip_address, user_agent, notes)
             VALUES ($1,$2,'restore','deleted_at', 'archived', 'active', $3,$4,$5,$6,$7,$8)`,
            [
                entityType, String(entityId),
                u.external_id || u.code || null,
                u.name || null,
                u.access_role || u.role || null,
                req.ip || (req.connection && req.connection.remoteAddress) || null,
                req.headers['user-agent'] || null,
                'Restored ' + entityType + ' "' + label + '" from archive'
            ]
        );
    } catch (e) {
        console.error('[admin/restore] history log failed:', e.message);
    }
}

// ---------------------------------------------------------------------
// LIST — every soft-deleted record across leads, properties, units
// ---------------------------------------------------------------------
router.get('/super/restore', ensureSuperAdmin, async (req, res) => {
    const leads = await safe(
        `SELECT lead_id AS id, name AS label, phone, status::text AS status, deleted_at
           FROM private.leads
          WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC`,
        [], []
    );

    const properties = await safe(
        `SELECT project_id AS id, title AS label,
                array_to_string(status_of_property, ', ') AS status, deleted_at
           FROM private.projects
          WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC`,
        [], []
    );

    // units: show the unit config + which property it belongs to
    const units = await safe(
        `SELECT u.property_id AS id,
                COALESCE(u.config, 'Unit') AS label,
                u.price_lakhs,
                p.title AS property_title,
                u.deleted_at
           FROM private.properties u
           LEFT JOIN private.projects p ON p.project_id = u.project_id
          WHERE u.deleted_at IS NOT NULL
          ORDER BY u.deleted_at DESC`,
        [], []
    );

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Restore Archive' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Restore Archive' });

    res.render('admin/super-restore', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Restore Archive',
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        leads,
        properties,
        units,
        total: leads.length + properties.length + units.length,
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// Generic restore helper (one place for the SAVEPOINT pattern)
// ---------------------------------------------------------------------
async function doRestore(req, res, { table, pk, labelCol, entityType }) {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
        return res.redirect('/admin/super/restore?msg=' + encodeURIComponent('Invalid id'));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_restore');

        // grab a label for the audit note before we flip it back
        const lookup = await client.query(
            `SELECT ${labelCol} AS label FROM private.${table}
              WHERE ${pk} = $1 AND deleted_at IS NOT NULL`,
            [id]
        );
        if (lookup.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.redirect('/admin/super/restore?msg=' + encodeURIComponent('Record not found or already active'));
        }
        const label = lookup.rows[0].label || entityType;

        await client.query(
            `UPDATE private.${table} SET deleted_at = NULL
              WHERE ${pk} = $1 AND deleted_at IS NOT NULL`,
            [id]
        );

        await logRestore(client, req, entityType, id, label);

        await client.query('RELEASE SAVEPOINT sp_restore');
        await client.query('COMMIT');
        res.redirect('/admin/super/restore?msg=' + encodeURIComponent('Restored "' + label + '"'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/restore] restore failed:', err.message);
        res.redirect('/admin/super/restore?msg=' + encodeURIComponent(userSafeError(err, 'Could not restore. Please try again.')));
    } finally {
        client.release();
    }
}

router.post('/super/restore/lead/:id', ensureSuperAdmin, (req, res) =>
    doRestore(req, res, { table: 'leads', pk: 'lead_id', labelCol: 'name', entityType: 'lead' }));

router.post('/super/restore/property/:id', ensureSuperAdmin, (req, res) =>
    doRestore(req, res, { table: 'projects', pk: 'project_id', labelCol: 'title', entityType: 'property' }));

router.post('/super/restore/unit/:id', ensureSuperAdmin, (req, res) =>
    doRestore(req, res, { table: 'properties', pk: 'property_id', labelCol: 'config', entityType: 'unit' }));

module.exports = router;
