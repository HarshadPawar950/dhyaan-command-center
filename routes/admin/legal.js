// =====================================================================
// routes/admin/legal.js — PHASE 3 · A — LEGAL VAULT (super+admin, legal.manage)
// Polymorphic legal docs on a client / builder / project. Mount: '/admin'.
//
// SECURITY (same discipline as Phase 2 client docs, generalized):
//   - multer MEMORY storage: the file is held in RAM; we VALIDATE the entity
//     exists live BEFORE writing anything to disk (ruling §1 — validate first,
//     write second). entity_id has no DB FK (polymorphic), so this in-route
//     check is the integrity guard.
//   - Files land OUTSIDE public/ at storage/legal-docs/<entity_type>/<entity_id>/
//     <synthesized>.<ext> (gitignored), never express.static-served.
//   - Download is gated: legal.manage + belongs-to (doc_id AND entity_type AND
//     entity_id) + path from stored disk_name only (basename guard) +
//     Content-Disposition attachment + X-Content-Type-Options nosniff.
//   - Soft-delete; file kept on disk.
//   - CSRF: multipart passes _csrf in the action query.
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const ejs = require('ejs');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'legal-docs');
const ENTITY = {
    client:  { tbl: 'clients',  id: 'client_id',  name: 'name'  },
    builder: { tbl: 'builders', id: 'builder_id', name: 'name'  },
    project: { tbl: 'projects', id: 'project_id', name: 'title' },
};
const DOC_KINDS = ['agreement', 'mou', 'rera', 'noc', 'kyc'];
const STATUSES = ['draft', 'executed', 'expired'];
const ALLOWED = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const MAX_BYTES = 10 * 1024 * 1024;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[legal] query failed:', err.message); return fallback; }
}
async function renderPartial(name, data) {
    try { return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data); }
    catch (e) { console.error('partial ' + name + ' failed:', e.message); return ''; }
}
function safeHeaderName(name) { return String(name || 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 120); }

// entity exists live in its table? (table/col are from the fixed ENTITY map — not user input)
async function entityExists(type, id) {
    const e = ENTITY[type];
    if (!e || !UUID_RE.test(id)) return false;
    const r = await safe(`SELECT 1 FROM private.${e.tbl} WHERE ${e.id}=$1 AND deleted_at IS NULL`, [id], []);
    return r.length > 0;
}

// MEMORY storage so we can validate the entity BEFORE touching disk.
const uploadMem = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter(req, file, cb) {
        const extOk = /\.(pdf|jpe?g|png)$/i.test(file.originalname);
        cb(null, !!ALLOWED[file.mimetype] && extOk);
    },
}).single('document');

function cleanLegal(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    const kind = t(b.doc_kind); const st = t(b.status);
    return {
        entity_type: t(b.entity_type),
        entity_id: t(b.entity_id),
        doc_kind: DOC_KINDS.includes(kind) ? kind : 'agreement',
        party: t(b.party),
        execution_date: t(b.execution_date),
        expiry_date: t(b.expiry_date),
        status: STATUSES.includes(st) ? st : 'draft',
        notes: t(b.notes),
    };
}

// ---------------------------------------------------------------------
// LIST + upload form
// ---------------------------------------------------------------------
router.get('/legal', ensureAdmin, ensurePermission('legal.manage'), async (req, res) => {
    const f = { entity_type: (req.query.entity_type || '').trim(), doc_kind: (req.query.doc_kind || '').trim(), q: (req.query.q || '').trim() };
    const conds = ['ld.deleted_at IS NULL']; const params = []; let i = 1;
    if (ENTITY[f.entity_type]) { conds.push(`ld.entity_type = $${i++}`); params.push(f.entity_type); }
    if (DOC_KINDS.includes(f.doc_kind)) { conds.push(`ld.doc_kind = $${i++}`); params.push(f.doc_kind); }
    if (f.q) { conds.push(`(LOWER(COALESCE(ld.party,'')) LIKE $${i} OR LOWER(COALESCE(ld.original_name,'')) LIKE $${i})`); params.push('%' + f.q.toLowerCase() + '%'); i++; }
    const where = 'WHERE ' + conds.join(' AND ');

    const docs = await safe(
        `SELECT ld.doc_id, ld.entity_type, ld.entity_id, ld.doc_kind, ld.party, ld.execution_date,
                ld.expiry_date, ld.status, ld.original_name, ld.file_size_bytes, ld.created_at,
                COALESCE(c.name, b.name, p.title) AS entity_name,
                CASE WHEN ld.expiry_date IS NOT NULL AND ld.expiry_date < CURRENT_DATE THEN true ELSE false END AS is_past
           FROM private.legal_documents ld
           LEFT JOIN private.clients  c ON ld.entity_type='client'  AND c.client_id  = ld.entity_id
           LEFT JOIN private.builders b ON ld.entity_type='builder' AND b.builder_id = ld.entity_id
           LEFT JOIN private.projects p ON ld.entity_type='project' AND p.project_id = ld.entity_id
           ${where}
          ORDER BY ld.created_at DESC`, params, []);

    const clients = await safe(`SELECT client_id AS id, name FROM private.clients WHERE deleted_at IS NULL ORDER BY name`, [], []);
    const builders = await safe(`SELECT builder_id AS id, name FROM private.builders WHERE deleted_at IS NULL ORDER BY name`, [], []);
    const projects = await safe(`SELECT project_id AS id, title AS name FROM private.projects WHERE deleted_at IS NULL ORDER BY title`, [], []);

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Legal Vault' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Legal Vault' });
    res.render('admin/legal-list', {
        csrfToken: req.csrfToken(), pageTitle: 'Legal Vault', user: req.session.user,
        sidebarHtml, topbarHtml, docs, filters: f,
        entityLists: { client: clients, builder: builders, project: projects },
        docKinds: DOC_KINDS, statuses: STATUSES,
        flash: req.query.msg || null, err: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// UPLOAD — validate entity FIRST, then write file, then insert row
// ---------------------------------------------------------------------
router.post('/legal', ensureAdmin, ensurePermission('legal.manage'), (req, res) => {
    uploadMem(req, res, async (err) => {
        const back = (m) => '/admin/legal?err=' + encodeURIComponent(m);
        if (err) return res.redirect(back(err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 10 MB limit' : userSafeError(err, 'Upload failed. Please try again.')));
        const d = cleanLegal(req.body);
        if (!ENTITY[d.entity_type]) return res.redirect(back('Pick a valid entity type'));
        if (!d.entity_id || !UUID_RE.test(d.entity_id)) return res.redirect(back('Pick the entity to attach to'));
        if (!req.file) return res.redirect(back('Only PDF, JPG or PNG files up to 10 MB are allowed'));
        // VALIDATE FIRST — entity must exist live before anything hits disk.
        if (!(await entityExists(d.entity_type, d.entity_id))) return res.redirect(back('That ' + d.entity_type + ' does not exist'));

        // WRITE SECOND — synthesized name, off-public dir.
        const ext = ALLOWED[req.file.mimetype] || '.bin';
        const diskName = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
        const dir = path.join(STORAGE_ROOT, d.entity_type, d.entity_id);
        const diskPath = path.join(dir, diskName);
        const u = req.session.user; const by = (u && (u.employee_id || u.id)) || null;
        const client = await pool.connect();
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(diskPath, req.file.buffer);
            await client.query('BEGIN'); await client.query('SAVEPOINT sp_leg');
            await client.query(
                `INSERT INTO private.legal_documents
                   (entity_type, entity_id, doc_kind, party, execution_date, expiry_date, status,
                    original_name, disk_name, mime_type, file_size_bytes, notes, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [d.entity_type, d.entity_id, d.doc_kind, d.party, d.execution_date, d.expiry_date, d.status,
                 req.file.originalname.slice(0, 255), diskName, req.file.mimetype, req.file.size, d.notes, by]);
            await client.query('RELEASE SAVEPOINT sp_leg'); await client.query('COMMIT');
            res.redirect('/admin/legal?msg=' + encodeURIComponent('Legal document uploaded'));
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            fs.existsSync(diskPath) && fs.unlink(diskPath, () => {});   // no file without a row
            console.error('[legal] insert failed:', e.message);
            res.redirect(back(userSafeError(e, 'Could not save the document. Please try again.')));
        } finally { client.release(); }
    });
});

// ---------------------------------------------------------------------
// DOWNLOAD (gated) — belongs-to = doc_id AND entity_type AND entity_id
// ---------------------------------------------------------------------
router.get('/legal/:entityType/:entityId/:docId/download', ensureAdmin, ensurePermission('legal.manage'), async (req, res) => {
    const { entityType, entityId, docId } = req.params;
    if (!ENTITY[entityType] || !UUID_RE.test(entityId) || !UUID_RE.test(docId)) return res.status(400).send('Bad request');
    const rows = await safe(
        `SELECT original_name, disk_name, mime_type FROM private.legal_documents
          WHERE doc_id=$1 AND entity_type=$2 AND entity_id=$3 AND deleted_at IS NULL`, [docId, entityType, entityId], []);
    if (!rows.length) return res.status(404).send('Document not found');
    const doc = rows[0];
    const filePath = path.join(STORAGE_ROOT, entityType, entityId, path.basename(doc.disk_name));
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing on disk');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeHeaderName(doc.original_name)}"`);
    fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

// ---------------------------------------------------------------------
// DELETE (soft)
// ---------------------------------------------------------------------
router.post('/legal/:docId/delete', ensureAdmin, ensurePermission('legal.manage'), async (req, res) => {
    const id = req.params.docId;
    if (!UUID_RE.test(id)) return res.redirect('/admin/legal?err=' + encodeURIComponent('Invalid id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_legd');
        await client.query(`UPDATE private.legal_documents SET deleted_at=now() WHERE doc_id=$1 AND deleted_at IS NULL`, [id]);
        await client.query('RELEASE SAVEPOINT sp_legd'); await client.query('COMMIT');
        res.redirect('/admin/legal?msg=' + encodeURIComponent('Document removed (soft-deleted)'));
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect('/admin/legal?err=' + encodeURIComponent('Could not remove document'));
    } finally { client.release(); }
});

module.exports = router;
