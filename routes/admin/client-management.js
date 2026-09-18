// =====================================================================
// routes/admin/client-management.js — CUSTOMER MGMT (Phase 2)
// Client documents (A), loans (B), goals (C), referral (D).
// Mount: app.use('/admin', ...). All routes admin+super only (gated per key).
//
// DOCUMENTS SECURITY MODEL (Capability A):
//   - Files stored OUTSIDE public/ at storage/client-docs/<client_id>/<random>.<ext>
//     (gitignored) so express.static NEVER serves them.
//   - Whitelist pdf/jpg/png (mime + ext), 10 MB cap, ONE file per upload.
//   - Disk filename is fully synthesized (never the client filename).
//   - Download is a GATED route: permission check + doc-belongs-to-client check,
//     path built ONLY from the stored disk_name, streamed with
//     Content-Disposition: attachment + X-Content-Type-Options: nosniff.
//   - Soft-delete (deleted_at); the on-disk file is left in place, recoverable.
//   - CSRF: multipart bodies bypass body-parser, so the upload form passes _csrf
//     in the action query (csurf also checks req.query).
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'client-docs');
const DOC_TYPES = ['kyc', 'agreement', 'loan', 'other'];
const ALLOWED = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const MAX_BYTES = 10 * 1024 * 1024;

async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('[client-mgmt] query failed:', err.message); return fallback; }
}

// --- multer: synthesized disk name under storage/client-docs/<client_id>/ ---
const storage = multer.diskStorage({
    destination(req, file, cb) {
        const id = req.params.id;
        if (!UUID_RE.test(id)) return cb(new Error('Invalid client id'));
        const dir = path.join(STORAGE_ROOT, id);
        try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); } catch (e) { cb(e); }
    },
    filename(req, file, cb) {
        const ext = ALLOWED[file.mimetype] || '.bin';
        cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
    },
});
const uploadDoc = multer({
    storage,
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter(req, file, cb) {
        const extOk = /\.(pdf|jpe?g|png)$/i.test(file.originalname);
        cb(null, !!ALLOWED[file.mimetype] && extOk);   // drop anything not pdf/jpg/png
    },
}).single('document');

// Sanitize a client-supplied filename for use only inside a header value.
function safeHeaderName(name) {
    return String(name || 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
}

// ---------------------------------------------------------------------
// A. UPLOAD a document
// ---------------------------------------------------------------------
router.post('/clients/:id/documents', ensureAdmin, ensurePermission('clients.documents.manage'), (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));
    uploadDoc(req, res, async (err) => {
        const back = (m) => '/admin/clients/view/' + id + '?err=' + encodeURIComponent(m) + '#documents';
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 10 MB limit' : userSafeError(err, 'Upload failed. Please try again.');
            return res.redirect(back(msg));
        }
        if (!req.file) return res.redirect(back('Only PDF, JPG or PNG files up to 10 MB are allowed'));

        // Confirm the client exists (and isn't deleted) BEFORE recording the row.
        const cli = await safe(`SELECT client_id FROM private.clients WHERE client_id=$1 AND deleted_at IS NULL`, [id], []);
        if (!cli.length) {
            fs.unlink(req.file.path, () => {});   // orphan cleanup
            return res.redirect('/admin/clients?msg=' + encodeURIComponent('Client not found'));
        }
        const dtype = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';
        const notes = (req.body.notes || '').trim() || null;
        const u = req.session.user;
        const uploadedBy = (u && (u.employee_id || u.id)) || null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SAVEPOINT sp_doc');
            await client.query(
                `INSERT INTO private.client_documents
                   (client_id, doc_type, original_name, disk_name, mime_type, file_size_bytes, uploaded_by, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [id, dtype, req.file.originalname.slice(0, 255), req.file.filename, req.file.mimetype, req.file.size, uploadedBy, notes]);
            await client.query('RELEASE SAVEPOINT sp_doc');
            await client.query('COMMIT');
            res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Document uploaded') + '#documents');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            fs.unlink(req.file.path, () => {});   // don't leave a file with no DB row
            console.error('[client-mgmt] doc insert failed:', e.message);
            res.redirect(back(userSafeError(e, 'Could not save the document. Please try again.')));
        } finally { client.release(); }
    });
});

// ---------------------------------------------------------------------
// A. DOWNLOAD (gated stream) — never static, never client path input
// ---------------------------------------------------------------------
router.get('/clients/:id/documents/:docId/download', ensureAdmin, ensurePermission('clients.documents.manage'), async (req, res) => {
    const { id, docId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(docId)) return res.status(400).send('Bad request');
    const rows = await safe(
        `SELECT original_name, disk_name, mime_type FROM private.client_documents
          WHERE doc_id=$1 AND client_id=$2 AND deleted_at IS NULL`, [docId, id], []);
    if (!rows.length) return res.status(404).send('Document not found');
    const doc = rows[0];
    // disk_name comes ONLY from the DB (synthesized at upload); basename() is a
    // belt-and-braces guard so no path segment can escape the client's dir.
    const filePath = path.join(STORAGE_ROOT, id, path.basename(doc.disk_name));
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing on disk');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeHeaderName(doc.original_name)}"`);
    fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

// ---------------------------------------------------------------------
// A. DELETE (soft) — file stays on disk, recoverable
// ---------------------------------------------------------------------
router.post('/clients/:id/documents/:docId/delete', ensureAdmin, ensurePermission('clients.documents.manage'), async (req, res) => {
    const { id, docId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(docId)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_ddel');
        await client.query(`UPDATE private.client_documents SET deleted_at=now() WHERE doc_id=$1 AND client_id=$2 AND deleted_at IS NULL`, [docId, id]);
        await client.query('RELEASE SAVEPOINT sp_ddel');
        await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Document removed (soft-deleted)') + '#documents');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[client-mgmt] doc delete failed:', e.message);
        res.redirect('/admin/clients/view/' + id + '?err=' + encodeURIComponent('Could not remove document') + '#documents');
    } finally { client.release(); }
});

// =====================================================================
// B. LOANS — home-loan progress (gated clients.finance.manage)
// =====================================================================
const LOAN_STAGES = ['applied', 'sanctioned', 'disbursed', 'rejected'];
function cleanLoan(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    const num = (v) => { const n = t(v); return n === null ? null : Number(n); };
    const st = t(b.stage);
    return {
        bank_name: t(b.bank_name),
        loan_amount: num(b.loan_amount),
        sanctioned_amount: num(b.sanctioned_amount),
        stage: LOAN_STAGES.includes(st) ? st : 'applied',
        applied_on: t(b.applied_on),
        sanctioned_on: t(b.sanctioned_on),
        disbursed_on: t(b.disbursed_on),
        notes: t(b.notes),
    };
}

router.post('/clients/:id/loans', ensureAdmin, ensurePermission('clients.finance.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));
    const d = cleanLoan(req.body);
    const back = (m) => '/admin/clients/view/' + id + '?err=' + encodeURIComponent(m) + '#loan';
    if (d.loan_amount !== null && d.loan_amount < 0) return res.redirect(back('Loan amount cannot be negative'));
    const u = req.session.user; const by = (u && (u.employee_id || u.id)) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_loan');
        await client.query(
            `INSERT INTO private.client_loans
               (client_id, bank_name, loan_amount, sanctioned_amount, stage, applied_on, sanctioned_on, disbursed_on, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [id, d.bank_name, d.loan_amount, d.sanctioned_amount, d.stage, d.applied_on, d.sanctioned_on, d.disbursed_on, d.notes, by]);
        await client.query('RELEASE SAVEPOINT sp_loan'); await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Loan record added') + '#loan');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not save the loan. Please try again.')));
    } finally { client.release(); }
});

router.post('/clients/:id/loans/:loanId/edit', ensureAdmin, ensurePermission('clients.finance.manage'), async (req, res) => {
    const { id, loanId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(loanId)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid id'));
    const d = cleanLoan(req.body);
    const back = (m) => '/admin/clients/view/' + id + '?err=' + encodeURIComponent(m) + '#loan';
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_loanu');
        await client.query(
            `UPDATE private.client_loans SET
               bank_name=$1, loan_amount=$2, sanctioned_amount=$3, stage=$4,
               applied_on=$5, sanctioned_on=$6, disbursed_on=$7, notes=$8, updated_at=now()
             WHERE loan_id=$9 AND client_id=$10 AND deleted_at IS NULL`,
            [d.bank_name, d.loan_amount, d.sanctioned_amount, d.stage, d.applied_on, d.sanctioned_on, d.disbursed_on, d.notes, loanId, id]);
        await client.query('RELEASE SAVEPOINT sp_loanu'); await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Loan updated') + '#loan');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not update the loan. Please try again.')));
    } finally { client.release(); }
});

router.post('/clients/:id/loans/:loanId/delete', ensureAdmin, ensurePermission('clients.finance.manage'), async (req, res) => {
    const { id, loanId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(loanId)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_loand');
        await client.query(`UPDATE private.client_loans SET deleted_at=now() WHERE loan_id=$1 AND client_id=$2 AND deleted_at IS NULL`, [loanId, id]);
        await client.query('RELEASE SAVEPOINT sp_loand'); await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Loan removed') + '#loan');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect('/admin/clients/view/' + id + '?err=' + encodeURIComponent('Could not remove loan') + '#loan');
    } finally { client.release(); }
});

// =====================================================================
// C. INVESTMENT GOALS — 1:1 structured successor (gated clients.finance.manage)
// =====================================================================
const PROPERTY_TYPES = ['Apartment', 'Villa', 'Plot', 'Row House', 'Commercial', 'Office'];
const PURPOSES = ['end_use', 'investment'];
function cleanGoals(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    const num = (v) => { const n = t(v); return n === null ? null : Number(n); };
    let types = b.property_type;
    if (typeof types === 'string') types = [types];
    if (!Array.isArray(types)) types = [];
    types = types.filter((x) => PROPERTY_TYPES.includes(x));
    const purpose = t(b.purpose);
    return {
        budget_min: num(b.budget_min),
        budget_max: num(b.budget_max),
        property_type: types,
        preferred_locations: t(b.preferred_locations),
        timeline: t(b.timeline),
        purpose: PURPOSES.includes(purpose) ? purpose : null,
        notes: t(b.notes),
    };
}

router.post('/clients/:id/goals', ensureAdmin, ensurePermission('clients.finance.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));
    const d = cleanGoals(req.body);
    const back = (m) => '/admin/clients/view/' + id + '?err=' + encodeURIComponent(m) + '#goals';
    if (d.budget_min !== null && d.budget_max !== null && d.budget_max < d.budget_min)
        return res.redirect(back('Max budget cannot be less than min budget'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_goal');
        const existing = await client.query(`SELECT goal_id FROM private.client_goals WHERE client_id=$1 AND deleted_at IS NULL`, [id]);
        if (existing.rows.length) {
            await client.query(
                `UPDATE private.client_goals SET budget_min=$1, budget_max=$2, property_type=$3,
                   preferred_locations=$4, timeline=$5, purpose=$6, notes=$7, updated_at=now()
                 WHERE goal_id=$8`,
                [d.budget_min, d.budget_max, d.property_type, d.preferred_locations, d.timeline, d.purpose, d.notes, existing.rows[0].goal_id]);
        } else {
            await client.query(
                `INSERT INTO private.client_goals (client_id, budget_min, budget_max, property_type, preferred_locations, timeline, purpose, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [id, d.budget_min, d.budget_max, d.property_type, d.preferred_locations, d.timeline, d.purpose, d.notes]);
        }
        await client.query('RELEASE SAVEPOINT sp_goal'); await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Investment goals saved') + '#goals');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not save the goals. Please try again.')));
    } finally { client.release(); }
});

// =====================================================================
// D. REFERRAL — who referred this client (gated clients.manage — relationship
//    data, not financial/document). Self-FK + free-text fallback + notes.
// =====================================================================
router.post('/clients/:id/referral', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    let refId = t(req.body.referred_by_client_id);
    if (refId && !UUID_RE.test(refId)) refId = null;
    if (refId === id) refId = null;                       // a client can't refer themselves
    const refName = t(req.body.referred_by_name);
    const refNotes = t(req.body.referral_notes);
    const back = (m) => '/admin/clients/view/' + id + '?err=' + encodeURIComponent(m) + '#referrals';
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_ref');
        // Guard against a referral cycle (A refers B, B refers A).
        if (refId) {
            const cyc = await client.query(`SELECT 1 FROM private.clients WHERE client_id=$1 AND referred_by_client_id=$2`, [refId, id]);
            if (cyc.rows.length) { await client.query('ROLLBACK'); return res.redirect(back('That client was referred BY this client — cycle blocked')); }
        }
        await client.query(
            `UPDATE private.clients SET referred_by_client_id=$1, referred_by_name=$2, referral_notes=$3
              WHERE client_id=$4 AND deleted_at IS NULL`,
            [refId, refName, refNotes, id]);
        await client.query('RELEASE SAVEPOINT sp_ref'); await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Referral saved') + '#referrals');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not save the referral. Please try again.')));
    } finally { client.release(); }
});

module.exports = router;
