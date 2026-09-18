// =============================================================
// routes/admin/leads-import.js — bulk lead import from Excel/CSV (Δ6).
// Admin + leads.capture gated.
//
// Flow (every row is ACCOUNTED FOR — never silently skipped/mutated):
//   GET  /admin/leads/import               -> upload page
//   GET  /admin/leads/import/template.xlsx -> downloadable template
//   POST /admin/leads/import               -> parse + validate + dedup -> PREVIEW
//                                             (NO DB writes; stashes valid rows in session)
//   POST /admin/leads/import/commit        -> insert valid rows in ONE txn, per-row
//                                             SAVEPOINT, round-robin auto-assign each,
//                                             bulk history log -> SUMMARY
//
// Dedup is against normalized_phone (active leads) AND within the sheet itself.
// Reuses the single-lead intake primitives so bulk == same rules as manual.
// =============================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { logFromRequest } = require('../../middleware/historyLogger');
const { normalizePhone, findActiveDuplicate, roundRobinPick } = require('../../middleware/leadAssignment');

// Expected template columns (header row). name is required; phone strongly advised.
const TEMPLATE_COLUMNS = ['name', 'phone', 'email', 'source', 'budget', 'location', 'requirement'];
const ALLOWED_SOURCES = ['website', 'referral', 'walk_in', 'social_media', 'campaign', 'other'];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter(req, file, cb) {
        const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname || '');
        cb(null, ok);
    },
}).single('sheet');

// Map a source cell to a valid enum value (or null when blank).
function normalizeSource(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!s) return null;
    if (ALLOWED_SOURCES.includes(s)) return s;
    // common friendly aliases
    if (s === 'walkin' || s === 'walk_in_') return 'walk_in';
    if (s === 'facebook' || s === 'instagram' || s === 'meta' || s === 'social') return 'social_media';
    if (s === 'web' || s === 'site') return 'website';
    return 'other';
}

// Pull a field from a sheet row regardless of header case / surrounding spaces.
function pick(row, key) {
    for (const k of Object.keys(row)) {
        if (String(k).trim().toLowerCase() === key) return row[k];
    }
    return undefined;
}

function parseSheet(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return json.map((row) => ({
        name:        String(pick(row, 'name') ?? '').trim(),
        phone:       String(pick(row, 'phone') ?? '').trim(),
        email:       String(pick(row, 'email') ?? '').trim(),
        source:      String(pick(row, 'source') ?? '').trim(),
        budget:      String(pick(row, 'budget') ?? '').trim(),
        location:    String(pick(row, 'location') ?? '').trim(),
        requirement: String(pick(row, 'requirement') ?? '').trim(),
    }));
}

// Atomic, collision-proof code allocation via dedicated sequences
// (migration 057: private.lead_code_seq / private.assignment_code_seq, START 2000).
// Replaces the old startCode() MAX(digits of external_id)::bigint read, which shared
// the string-concat/overflow defect and read the phone-number poison row on leads.
// nextval() never reads external_id; ::text so we concatenate (no arithmetic). Called
// per-row inside the import txn — the existence-check retry (leads/assignments
// external_id are UNIQUE) also catches rows inserted earlier in this same txn.
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

// -------------------------------------------------------------
// GET /admin/leads/import — upload page
// -------------------------------------------------------------
router.get('/leads/import', ensureAdmin, ensurePermission('leads.capture'), (req, res) => {
    const preview = req.session.leadImportPreview || null;
    const summary = req.session.leadImportSummary || null;
    req.session.leadImportSummary = null; // summary is one-shot
    res.render('admin/leads-import', {
        pageTitle: 'Import Leads',
        user: req.session.user,
        templateColumns: TEMPLATE_COLUMNS,
        allowedSources: ALLOWED_SOURCES,
        preview,
        summary,
        csrfToken: req.csrfToken(),
    });
});

// -------------------------------------------------------------
// GET /admin/leads/import/template.xlsx — downloadable template
// -------------------------------------------------------------
router.get('/leads/import/template.xlsx', ensureAdmin, ensurePermission('leads.capture'), (req, res) => {
    const rows = [
        TEMPLATE_COLUMNS,
        ['Rahul Sharma', '9820012345', 'rahul@example.com', 'website', '1.5 Cr', 'Vashi', '3BHK sea-facing'],
        ['Priya Nair', '9769987654', '', 'referral', '80 Lakh', 'Kharghar', '2BHK'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = TEMPLATE_COLUMNS.map(() => ({ wch: 18 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="dhyaan-leads-template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});

// -------------------------------------------------------------
// POST /admin/leads/import — parse + validate + dedup -> PREVIEW (no writes)
// -------------------------------------------------------------
router.post('/leads/import', ensureAdmin, ensurePermission('leads.capture'), (req, res) => {
    upload(req, res, async function (err) {
        if (err) {
            req.session.leadImportSummary = { type: 'error', text: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5 MB).' : userSafeError(err, 'Upload failed. Please try again.') };
            return res.redirect('/admin/leads/import');
        }
        if (!req.file) {
            req.session.leadImportSummary = { type: 'error', text: 'No file — upload an .xlsx, .xls or .csv sheet.' };
            return res.redirect('/admin/leads/import');
        }

        let parsed;
        try { parsed = parseSheet(req.file.buffer); }
        catch (e) {
            req.session.leadImportSummary = { type: 'error', text: userSafeError(e, 'Could not read the sheet. Please check the file and try again.') };
            return res.redirect('/admin/leads/import');
        }

        const rows = [];
        const validRows = [];
        const seenPhones = new Set();
        let nImported = 0, nDup = 0, nInvalid = 0;

        for (let idx = 0; idx < parsed.length; idx++) {
            const r = parsed[idx];
            const rowNo = idx + 2; // +2 = header row + 1-based
            const norm = normalizePhone(r.phone);

            // fully blank line — skip but count as invalid/empty so nothing is hidden
            if (!r.name && !r.phone && !r.email && !r.location && !r.budget && !r.requirement) {
                rows.push({ rowNo, ...r, status: 'invalid', reason: 'Empty row' });
                nInvalid++; continue;
            }
            if (!r.name) {
                rows.push({ rowNo, ...r, status: 'invalid', reason: 'Missing name' });
                nInvalid++; continue;
            }
            if (!norm) {
                rows.push({ rowNo, ...r, status: 'invalid', reason: 'Invalid phone (need 10 digits)' });
                nInvalid++; continue;
            }
            if (seenPhones.has(norm)) {
                rows.push({ rowNo, ...r, status: 'duplicate', reason: 'Duplicate phone within this sheet' });
                nDup++; continue;
            }
            let dbDup = null;
            try { dbDup = await findActiveDuplicate({ query: (sql, p) => pool.query(sql, p) }, norm); } catch (_) {}
            if (dbDup) {
                rows.push({ rowNo, ...r, status: 'duplicate', reason: 'Already in system' + (dbDup.owner_name ? ' (owner: ' + dbDup.owner_name + ')' : '') });
                nDup++; continue;
            }

            seenPhones.add(norm);
            const clean = {
                name: r.name,
                phone: r.phone,
                email: r.email,
                source: normalizeSource(r.source),
                budget: r.budget,
                location: r.location,
                requirement: r.requirement,
            };
            validRows.push(clean);
            rows.push({ rowNo, ...r, status: 'valid', reason: 'Will import + auto-assign' });
            nImported++;
        }

        req.session.leadImportPreview = {
            fileName: req.file.originalname,
            rows,
            validRows,
            counts: { total: parsed.length, valid: nImported, duplicate: nDup, invalid: nInvalid },
        };
        req.session.leadImportSummary = null;
        return res.redirect('/admin/leads/import');
    });
});

// -------------------------------------------------------------
// POST /admin/leads/import/commit — insert valid rows (ONE txn)
// -------------------------------------------------------------
router.post('/leads/import/commit', ensureAdmin, ensurePermission('leads.capture'), async (req, res) => {
    const preview = req.session.leadImportPreview;
    if (!preview || !preview.validRows || !preview.validRows.length) {
        req.session.leadImportSummary = { type: 'error', text: 'Nothing to import — upload a sheet first.' };
        req.session.leadImportPreview = null;
        return res.redirect('/admin/leads/import');
    }

    const validRows = preview.validRows;
    let imported = 0, skippedAtCommit = 0, failed = 0;
    const assignedTo = {};
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const row of validRows) {
            await client.query('SAVEPOINT sp_row');
            try {
                // Re-check dedup INSIDE the txn (state may have moved since preview).
                const norm = normalizePhone(row.phone);
                const dup = await findActiveDuplicate(client, norm);
                if (dup) { skippedAtCommit++; await client.query('RELEASE SAVEPOINT sp_row'); continue; }

                const leadCode = await nextLeadCode(client);
                const ins = await client.query(
                    `INSERT INTO private.leads
                        (external_id, name, phone, email, source, requirement, budget, location, status, created_at)
                     VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),
                             NULLIF($5,'')::private.lead_source,
                             NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),'cold',NOW())
                     RETURNING lead_id, external_id`,
                    [leadCode, row.name, row.phone, row.email, row.source || '', row.requirement, row.budget, row.location]
                );
                const leadId = ins.rows[0].lead_id;

                // Round-robin auto-assign (advances the shared cursor atomically).
                const pick = await roundRobinPick(client);
                if (pick) {
                    const asgCode = await nextAssignmentCode(client);
                    await client.query(
                        `INSERT INTO private.assignments (external_id, lead_id, employee_id, assigned_at)
                         VALUES ($1,$2,$3,NOW())`,
                        [asgCode, leadId, pick.employeeId]
                    );
                    assignedTo[pick.name] = (assignedTo[pick.name] || 0) + 1;
                }
                await client.query('RELEASE SAVEPOINT sp_row');
                imported++;
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT sp_row');
                console.error('[leads-import] row failed:', e.message);
                failed++;
            }
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[leads-import] commit tx failed:', e.message);
        req.session.leadImportSummary = { type: 'error', text: userSafeError(e, 'The import failed and was rolled back. Please try again.') };
        req.session.leadImportPreview = null;
        client.release();
        return res.redirect('/admin/leads/import');
    } finally {
        client.release();
    }

    const previewCounts = preview.counts;
    try {
        await logFromRequest(req, {
            entityType: 'lead',
            entityId: 'BULK-IMPORT',
            action: 'import',
            notes: `Bulk import "${preview.fileName}": ${imported} imported, ${previewCounts.duplicate + skippedAtCommit} duplicates skipped, ${previewCounts.invalid} invalid, ${failed} failed`,
        });
    } catch (_) {}

    req.session.leadImportSummary = {
        type: 'success',
        text: `Import complete — ${imported} leads imported & auto-assigned, ${previewCounts.duplicate + skippedAtCommit} duplicates skipped, ${previewCounts.invalid} invalid rows, ${failed} failed.`,
        assignedTo,
    };
    req.session.leadImportPreview = null;
    return res.redirect('/admin/leads/import');
});

module.exports = router;
