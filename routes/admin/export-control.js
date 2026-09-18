// =====================================================================
// routes/admin/export-control.js — EXPORT CONTROL (super admin only)
// Mount: app.use('/admin', adminExportRoutes)
// Routes:
//   GET  /admin/super/export             -> export hub page (boss only)
//   GET  /admin/super/export/leads       -> download leads.csv     (+ audit log)
//   GET  /admin/super/export/clients     -> download clients.csv   (+ audit log)
//   GET  /admin/super/export/projects  -> download properties.csv(+ audit log)
// Blueprint: Super Admin "control exports". Anti-loophole: "No exports without
//            authorization." Every export is logged to history_log (who/when/count).
// Soft-delete aware (only exports active records). private. schema throughout.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');
const ejs = require('ejs');
const path = require('path');

// safe query wrapper
async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/export] query failed:', err.message);
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

// turn an array of row-objects into a CSV string (quotes + escapes safe)
function toCSV(rows) {
    if (!rows || rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        // wrap in quotes if it has comma, quote, or newline; double internal quotes
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };
    const lines = [headers.join(',')];
    rows.forEach(r => lines.push(headers.map(h => esc(r[h])).join(',')));
    return lines.join('\r\n');
}

// best-effort audit row for an export action
async function logExport(req, entityType, count) {
    try {
        const u = req.session.user || {};
        await pool.query(
            `INSERT INTO private.history_log
                (entity_type, entity_id, action, field_name, old_value, new_value,
                 changed_by_code, changed_by_name, changed_by_role, ip_address, user_agent, notes)
             VALUES ($1,'-','export','csv', NULL, $2, $3,$4,$5,$6,$7,$8)`,
            [
                entityType, String(count),
                u.external_id || u.code || null,
                u.name || null,
                u.access_role || u.role || null,
                req.ip || (req.connection && req.connection.remoteAddress) || null,
                req.headers['user-agent'] || null,
                'Exported ' + count + ' ' + entityType + ' record(s) to CSV'
            ]
        );
    } catch (e) {
        console.error('[admin/export] history log failed:', e.message);
    }
}

// send a CSV as a file download
function sendCSV(res, filenameBase, rows) {
    const csv = toCSV(rows);
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.csv"`);
    res.send('\uFEFF' + csv); // BOM so Excel reads UTF-8 (₹, names) correctly
}

// ---------------------------------------------------------------------
// HUB PAGE — counts + download buttons (boss only)
// ---------------------------------------------------------------------
router.get('/super/export', ensureSuperAdmin, async (req, res) => {
    const counts = await safe(
        `SELECT
            (SELECT COUNT(*) FROM private.leads      WHERE deleted_at IS NULL)::int AS leads,
            (SELECT COUNT(*) FROM private.clients    WHERE deleted_at IS NULL)::int AS clients,
            (SELECT COUNT(*) FROM private.projects WHERE deleted_at IS NULL)::int AS properties`,
        [], [{ leads: 0, clients: 0, properties: 0 }]
    );

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Export Control' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Export Control' });

    res.render('admin/super-export', {
        pageTitle: 'Export Control',
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        counts: counts[0],
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// LEADS CSV
// ---------------------------------------------------------------------
router.get('/super/export/leads', ensureSuperAdmin, async (req, res) => {
    const rows = await safe(
        `SELECT name, phone, email, status::text AS status, source::text AS source,
                next_action, next_action_date, closure_probability, created_at
           FROM private.leads
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC`,
        [], []
    );
    await logExport(req, 'leads', rows.length);
    sendCSV(res, 'dhyaan_leads', rows);
});

// ---------------------------------------------------------------------
// CLIENTS CSV  (columns confirmed via recon — adjust if needed)
// ---------------------------------------------------------------------
router.get('/super/export/clients', ensureSuperAdmin, async (req, res) => {
    const rows = await safe(
        `SELECT name, phone, status::text AS status, client_type::text AS client_type, created_at
           FROM private.clients
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC`,
        [], []
    );
    await logExport(req, 'clients', rows.length);
    sendCSV(res, 'dhyaan_clients', rows);
});

// ---------------------------------------------------------------------
// PROPERTIES CSV
// ---------------------------------------------------------------------
router.get('/super/export/projects', ensureSuperAdmin, async (req, res) => {
    const rows = await safe(
        `SELECT title, array_to_string(status_of_property, ', ') AS status_of_property
           FROM private.projects
          WHERE deleted_at IS NULL
          ORDER BY title ASC`,
        [], []
    );
    await logExport(req, 'properties', rows.length);
    sendCSV(res, 'dhyaan_properties', rows);
});

module.exports = router;
