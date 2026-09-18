// =====================================================================
// routes/admin/project-cost-sheets.js — INTERNAL builder cost sheets (mig 055)
// Per-PROJECT cost-sheet attachments (Excel/PDF). NOT the finance commission
// "cost sheet" (routes/admin/cost-sheet.js, finance.costsheet.manage).
// Mount: app.use('/admin', ...). Gate: properties.manage (super+admin+hr_manager)
// — same as all other project media, per Boss ruling: whoever manages project
// inventory needs the builder's cost sheet to do the job.
//
// SECURITY MODEL (mirrors client_documents, Phase 2):
//   - Files stored OUTSIDE public/ at
//     storage/project-cost-sheets/<project_id>/<random>.<ext> (gitignored) so
//     express.static NEVER serves them. Reachable only via the gated route below.
//   - Whitelist keyed on EXTENSION (xlsx/xls/pdf/csv), NOT the browser MIME:
//     browsers send .xlsx as application/octet-stream or application/zip, so the
//     supplied Content-Type is untrustworthy. The extension is the source of truth.
//   - mime_type stored in the DB is the CANONICAL type resolved from the
//     extension — never the browser value — and that canonical value is what the
//     download route streams back.
//   - Disk filename is fully synthesized (never the client filename).
//   - Download is a GATED stream: perm check + sheet-belongs-to-project check,
//     path built ONLY from the stored disk_name via path.basename(), served with
//     Content-Disposition: attachment + X-Content-Type-Options: nosniff.
//   - Soft-delete (deleted_at); the on-disk file is left in place, recoverable.
//   - CSRF: multipart bypasses body-parser, so the upload form passes _csrf in the
//     action query (csurf also checks req.query).
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdminOrRole } = require('../../middleware/ensureAdminOrRole');
const { ensurePermission } = require('../../middleware/permissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'project-cost-sheets');
const MAX_BYTES = 10 * 1024 * 1024 * 1024;   // 10 GB — same ceiling as all other project media (Boss ruling)

// Extension → CANONICAL mime. The extension is the trusted source of truth; the
// browser-supplied file.mimetype is deliberately ignored (xlsx often arrives as
// application/octet-stream or application/zip).
const EXT_MIME = {
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls':  'application/vnd.ms-excel',
    '.pdf':  'application/pdf',
    '.csv':  'text/csv',
};
function extOf(name) {
    return path.extname(String(name || '')).toLowerCase();
}

const gate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[project-cost-sheets] query failed:', err.message); return fallback; }
}

// --- multer: synthesized disk name under storage/project-cost-sheets/<project_id>/ ---
const storage = multer.diskStorage({
    destination(req, file, cb) {
        const id = req.params.id;
        if (!UUID_RE.test(id)) return cb(new Error('Invalid project id'));
        const dir = path.join(STORAGE_ROOT, id);
        try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); } catch (e) { cb(e); }
    },
    filename(req, file, cb) {
        // Use the validated extension from the ORIGINAL name (already passed
        // fileFilter). Never trust file.mimetype for the extension.
        const ext = extOf(file.originalname);
        cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
    },
});
const uploadSheet = multer({
    storage,
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter(req, file, cb) {
        // Accept purely on extension — the browser MIME is ignored on purpose.
        cb(null, Object.prototype.hasOwnProperty.call(EXT_MIME, extOf(file.originalname)));
    },
}).single('cost_sheet');

// Sanitize a client-supplied filename for use only inside a header value.
function safeHeaderName(name) {
    return String(name || 'cost-sheet').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
}

// ---------------------------------------------------------------------
// UPLOAD a cost sheet
// ---------------------------------------------------------------------
router.post('/projects/:id/cost-sheets', ...gate, (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/projects?msg=' + encodeURIComponent('Invalid project id'));
    uploadSheet(req, res, async (err) => {
        const back = (m) => '/admin/projects/' + id + '?err=' + encodeURIComponent(m) + '#cost-sheets';
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 10 GB limit' : userSafeError(err, 'Upload failed. Please try again.');
            return res.redirect(back(msg));
        }
        if (!req.file) return res.redirect(back('Only Excel (.xlsx/.xls), PDF or CSV files up to 10 GB are allowed'));

        const ext = extOf(req.file.originalname);
        const canonicalMime = EXT_MIME[ext] || null;   // canonical, from extension only
        if (!canonicalMime) {                            // defensive: fileFilter should have blocked
            fs.unlink(req.file.path, () => {});
            return res.redirect(back('Unsupported file type'));
        }

        // Confirm the project exists (and isn't deleted) BEFORE recording the row.
        const proj = await safe(`SELECT project_id FROM private.projects WHERE project_id=$1 AND deleted_at IS NULL`, [id], []);
        if (!proj.length) {
            fs.unlink(req.file.path, () => {});   // orphan cleanup
            return res.redirect('/admin/projects?msg=' + encodeURIComponent('Project not found'));
        }
        const notes = (req.body.notes || '').trim() || null;
        const u = req.session.user;
        const uploadedBy = (u && (u.employee_id || u.id)) || null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SAVEPOINT sp_cs');
            await client.query(
                `INSERT INTO private.project_cost_sheets
                   (project_id, original_name, disk_name, mime_type, file_size_bytes, uploaded_by, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [id, req.file.originalname.slice(0, 255), req.file.filename, canonicalMime, req.file.size, uploadedBy, notes]);
            await client.query('RELEASE SAVEPOINT sp_cs');
            await client.query('COMMIT');
            res.redirect('/admin/projects/' + id + '?msg=' + encodeURIComponent('Cost sheet uploaded') + '#cost-sheets');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            fs.unlink(req.file.path, () => {});   // don't leave a file with no DB row
            console.error('[project-cost-sheets] insert failed:', e.message);
            res.redirect(back(userSafeError(e, 'Could not save the cost sheet. Please try again.')));
        } finally { client.release(); }
    });
});

// ---------------------------------------------------------------------
// DOWNLOAD (gated stream) — never static, never client path input
// ---------------------------------------------------------------------
router.get('/projects/:id/cost-sheets/:sheetId/download', ...gate, async (req, res) => {
    const { id, sheetId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(sheetId)) return res.status(400).send('Bad request');
    const rows = await safe(
        `SELECT original_name, disk_name, mime_type FROM private.project_cost_sheets
          WHERE sheet_id=$1 AND project_id=$2 AND deleted_at IS NULL`, [sheetId, id], []);
    if (!rows.length) return res.status(404).send('Cost sheet not found');
    const sh = rows[0];
    // disk_name comes ONLY from the DB (synthesized at upload); basename() is a
    // belt-and-braces guard so no path segment can escape the project's dir.
    const filePath = path.join(STORAGE_ROOT, id, path.basename(sh.disk_name));
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing on disk');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', sh.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeHeaderName(sh.original_name)}"`);
    fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

// ---------------------------------------------------------------------
// DELETE (soft) — file stays on disk, recoverable
// ---------------------------------------------------------------------
router.post('/projects/:id/cost-sheets/:sheetId/delete', ...gate, async (req, res) => {
    const { id, sheetId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(sheetId)) return res.redirect('/admin/projects?msg=' + encodeURIComponent('Invalid id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_csdel');
        await client.query(`UPDATE private.project_cost_sheets SET deleted_at=now() WHERE sheet_id=$1 AND project_id=$2 AND deleted_at IS NULL`, [sheetId, id]);
        await client.query('RELEASE SAVEPOINT sp_csdel');
        await client.query('COMMIT');
        res.redirect('/admin/projects/' + id + '?msg=' + encodeURIComponent('Cost sheet removed (soft-deleted)') + '#cost-sheets');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[project-cost-sheets] delete failed:', e.message);
        res.redirect('/admin/projects/' + id + '?err=' + encodeURIComponent('Could not remove cost sheet') + '#cost-sheets');
    } finally { client.release(); }
});

module.exports = router;
