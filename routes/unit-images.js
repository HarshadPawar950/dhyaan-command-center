// =============================================================
// routes/unit-images.js — MEDIA for a SINGULAR standalone property.
// Parallel to property-images.js (which is project-keyed). Here rows carry
// property_images.property_id (migration 026); files live under
// public/uploads/properties/<property_id>/. ADMIN / hr_manager + properties.manage.
//
//   Photos      : jpg/png/webp, ≤ 10 GB, ≤ 10 live
//   Floor plans : jpg/png/webp, ≤ 10 GB, ≤ 10 live
//   Videos      : mp4/webm/mov, ≤ 10 GB, ≤ 10 live
//
// Soft-delete only (deleted_at); the file stays on disk. CSRF token rides in
// the action query (?_csrf=…) because multipart bodies aren't body-parsed.
// =============================================================

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAdminOrRole } = require('../middleware/ensureAdminOrRole');
const { ensurePermission } = require('../middleware/permissions');
const { logFromRequest } = require('../middleware/historyLogger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'properties');

const MEDIA = {
    photo:      { allowed: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }, field: 'images',     maxBytes: 10 * 1024 * 1024 * 1024, max: 10, label: 'image',      human: '10 GB', accept: 'JPG, PNG or WebP' },
    video:      { allowed: { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' }, field: 'videos', maxBytes: 10 * 1024 * 1024 * 1024, max: 10, label: 'video',      human: '10 GB', accept: 'MP4, WebM or MOV' },
    floor_plan: { allowed: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }, field: 'floorplans', maxBytes: 10 * 1024 * 1024 * 1024, max: 10, label: 'floor plan', human: '10 GB', accept: 'JPG, PNG or WebP' },
};

function makeUploader(kind) {
    const cfg = MEDIA[kind];
    const storage = multer.diskStorage({
        destination(req, file, cb) {
            const id = req.params.id;
            if (!UUID_RE.test(id)) return cb(new Error('Invalid property id'));
            const dir = path.join(UPLOAD_ROOT, id);
            try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); } catch (e) { cb(e); }
        },
        filename(req, file, cb) {
            const ext = cfg.allowed[file.mimetype] || '.bin';
            cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
        },
    });
    return multer({
        storage,
        limits: { fileSize: cfg.maxBytes, files: cfg.max },
        fileFilter(req, file, cb) { cb(null, !!cfg.allowed[file.mimetype]); },
    }).array(cfg.field, cfg.max);
}

const uploaders = { photo: makeUploader('photo'), video: makeUploader('video'), floor_plan: makeUploader('floor_plan') };

function handleUpload(kind) {
    const cfg = MEDIA[kind];
    return function (req, res) {
        const id = req.params.id;
        if (!UUID_RE.test(id)) return res.status(404).render('404', { pageTitle: 'Not Found' });

        uploaders[kind](req, res, async function (err) {
            if (err) {
                const text = err.code === 'LIMIT_FILE_SIZE'
                    ? `Each ${cfg.label} must be ${cfg.human} or smaller.`
                    : userSafeError(err, 'Upload failed. Please try again.');
                req.session.unitFlash = { type: 'error', text };
                return res.redirect(`/properties/${id}/edit`);
            }
            const files = req.files || [];
            if (!files.length) {
                req.session.unitFlash = { type: 'error', text: `No valid ${cfg.label}s uploaded — ${cfg.accept} only, ≤ ${cfg.human} each.` };
                return res.redirect(`/properties/${id}/edit`);
            }
            // Confirm the property exists (and isn't deleted) before writing rows.
            try {
                const r = await pool.query('SELECT property_id FROM private.properties WHERE property_id=$1 AND deleted_at IS NULL', [id]);
                if (!r.rows.length) {
                    for (const f of files) { try { fs.unlinkSync(f.path); } catch (_) {} }
                    req.session.unitFlash = { type: 'error', text: 'Property not found.' };
                    return res.redirect('/admin/projects');
                }
            } catch (e) { console.error('[unit-images] prop lookup failed:', e.message); }

            const actor = (req.session.user && (req.session.user.external_id || req.session.user.employee_code || req.session.user.name)) || null;

            let sort = 0, existing = 0;
            try {
                const r = await pool.query(
                    `SELECT COUNT(*)::int AS n, COALESCE(MAX(sort_order),-1)+1 AS next
                       FROM private.property_images
                      WHERE property_id=$1 AND COALESCE(media_type,'photo')=$2 AND deleted_at IS NULL`,
                    [id, kind]);
                existing = r.rows[0].n; sort = r.rows[0].next;
            } catch (_) {}

            const remaining = Math.max(0, cfg.max - existing);
            const toSave = files.slice(0, remaining);
            const excess = files.slice(remaining);
            for (const f of excess) { try { fs.unlinkSync(f.path); } catch (_) {} }
            if (!toSave.length) {
                req.session.unitFlash = { type: 'error', text: `This property already has the maximum of ${cfg.max} ${cfg.label}s.` };
                return res.redirect(`/properties/${id}/edit`);
            }

            let saved = 0;
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const f of toSave) {
                    const webPath = '/uploads/properties/' + id + '/' + f.filename;
                    await client.query('SAVEPOINT sp_media');
                    try {
                        await client.query(
                            `INSERT INTO private.property_images
                                (property_id, file_path, sort_order, uploaded_by, media_type, mime_type, file_size_bytes, original_name)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                            [id, webPath, sort++, actor, kind, f.mimetype || null, f.size || null, f.originalname || null]);
                        await client.query('RELEASE SAVEPOINT sp_media');
                        saved++;
                    } catch (e) {
                        await client.query('ROLLBACK TO SAVEPOINT sp_media');
                        console.error('[unit-images] insert failed:', e.message);
                    }
                }
                await client.query('COMMIT');
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (_) {}
                console.error('[unit-images] upload tx failed:', e.message);
            } finally { client.release(); }

            try { await logFromRequest(req, { entityType: 'property_unit', entityId: id, action: 'update', notes: `Uploaded ${saved} property ${cfg.label}(s)` }); } catch (_) {}
            let flashText = `${saved} ${cfg.label}${saved === 1 ? '' : 's'} uploaded.`;
            if (excess.length) flashText += ` (${excess.length} skipped — max ${cfg.max}.)`;
            req.session.unitFlash = { type: 'success', text: flashText };
            res.redirect(`/properties/${id}/edit`);
        });
    };
}

const gate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

router.post('/:id/images', ...gate, handleUpload('photo'));
router.post('/:id/videos', ...gate, handleUpload('video'));
router.post('/:id/floorplans', ...gate, handleUpload('floor_plan'));

// Soft-delete any media item on THIS property.
router.post('/:id/images/:imageId/delete', ...gate, async (req, res) => {
    const { id, imageId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(imageId)) return res.status(404).render('404', { pageTitle: 'Not Found' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_del');
        await client.query('UPDATE private.property_images SET deleted_at=NOW() WHERE image_id=$1 AND property_id=$2 AND deleted_at IS NULL', [imageId, id]);
        await client.query('RELEASE SAVEPOINT sp_del');
        await client.query('COMMIT');
        try { await logFromRequest(req, { entityType: 'property_unit', entityId: id, action: 'update', notes: 'Removed a property media item' }); } catch (_) {}
        req.session.unitFlash = { type: 'success', text: 'Media item removed.' };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[unit-images] delete failed:', e.message);
        req.session.unitFlash = { type: 'error', text: 'Could not remove the media item.' };
    } finally { client.release(); }
    res.redirect(`/properties/${id}/edit`);
});

module.exports = router;
