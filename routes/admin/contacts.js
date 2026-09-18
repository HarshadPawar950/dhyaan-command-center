// =====================================================================
// routes/admin/contacts.js — SUPER-ADMIN CONTACTS DIRECTORY (boss-only)
// Munish's private builder/broker rolodex. Migration 030: private.contacts.
// Mount: app.use('/admin', adminContactsRoutes)
// Routes:
//   GET  /admin/contacts             -> list + search/filter (builder/area)
//   GET  /admin/contacts/new         -> add form
//   POST /admin/contacts/new         -> create (SAVEPOINT)
//   GET  /admin/contacts/edit/:id    -> edit form (pre-filled)
//   POST /admin/contacts/edit/:id    -> update (SAVEPOINT)
//   POST /admin/contacts/delete/:id  -> SOFT delete (deleted_at = now())
// Soft-delete only — never hard-delete. Not a protected table, so the
// super-admin delete is a direct UPDATE (no approval engine).
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// READ-ONLY helper for SELECTs. Mutations below use pool.connect() + SAVEPOINT
// (BEGIN/SAVEPOINT/RELEASE/COMMIT/ROLLBACK) — never route a write through safe().
async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/contacts] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// Normalise form body -> clean values (null for blanks).
function cleanBody(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    return {
        builder_name: t(b.builder_name),
        contact_person_name: t(b.contact_person_name),
        area: t(b.area),
        project_name: t(b.project_name),
        contact_number: t(b.contact_number),
        email: t(b.email),
        designation: t(b.designation),
        alt_phone: t(b.alt_phone),
        alt_contact_name: t(b.alt_contact_name),
        alt_contact_phone: t(b.alt_contact_phone),
    };
}

// ---------------------------------------------------------------------
// LIST — with search (q) + filter by builder / area
// ---------------------------------------------------------------------
router.get('/contacts', ensureSuperAdmin, async (req, res) => {
    const f = {
        q: (req.query.q || '').trim(),
        builder: (req.query.builder || '').trim(),
        area: (req.query.area || '').trim(),
    };
    const conds = ['deleted_at IS NULL'];
    const params = [];
    let i = 1;
    if (f.q) {
        conds.push(`(LOWER(COALESCE(builder_name,'')) LIKE $${i} OR LOWER(COALESCE(project_name,'')) LIKE $${i}
                     OR LOWER(COALESCE(area,'')) LIKE $${i} OR LOWER(COALESCE(email,'')) LIKE $${i}
                     OR LOWER(COALESCE(contact_number,'')) LIKE $${i})`);
        params.push('%' + f.q.toLowerCase() + '%'); i++;
    }
    if (f.builder) { conds.push(`LOWER(COALESCE(builder_name,'')) = $${i++}`); params.push(f.builder.toLowerCase()); }
    if (f.area) { conds.push(`LOWER(COALESCE(area,'')) = $${i++}`); params.push(f.area.toLowerCase()); }
    const whereClause = 'WHERE ' + conds.join(' AND ');

    const contacts = await safe(
        `SELECT contact_id, builder_name, contact_person_name, area, project_name, contact_number, email,
                designation, alt_phone, alt_contact_name, alt_contact_phone
           FROM private.contacts ${whereClause}
          ORDER BY builder_name ASC, project_name ASC NULLS LAST`,
        params, []
    );
    const builderOpts = await safe(
        `SELECT DISTINCT builder_name FROM private.contacts
          WHERE deleted_at IS NULL AND builder_name IS NOT NULL AND builder_name <> ''
          ORDER BY builder_name`, [], []
    );
    const areaOpts = await safe(
        `SELECT DISTINCT area FROM private.contacts
          WHERE deleted_at IS NULL AND area IS NOT NULL AND area <> ''
          ORDER BY area`, [], []
    );
    const totalsRow = await safe(
        `SELECT COUNT(*)::int AS total FROM private.contacts WHERE deleted_at IS NULL`,
        [], [{ total: 0 }]
    );

    res.render('admin/contacts-list', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Contacts',
        user: req.session.user,
        contacts,
        filters: f,
        builderOpts: builderOpts.map(r => r.builder_name),
        areaOpts: areaOpts.map(r => r.area),
        totals: totalsRow[0],
        flash: req.query.msg || null,
    });
});

// ---------------------------------------------------------------------
// NEW (form)
// ---------------------------------------------------------------------
router.get('/contacts/new', ensureSuperAdmin, (req, res) => {
    res.render('admin/contacts-new', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Add Contact',
        user: req.session.user,
        err: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// NEW (create) — SAVEPOINT pattern
// ---------------------------------------------------------------------
router.post('/contacts/new', ensureSuperAdmin, async (req, res) => {
    const d = cleanBody(req.body);
    if (!d.builder_name) {
        return res.redirect('/admin/contacts/new?err=' + encodeURIComponent('Builder name is required'));
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_insert');
        await client.query(
            `INSERT INTO private.contacts (builder_name, contact_person_name, area, project_name, contact_number, email,
                designation, alt_phone, alt_contact_name, alt_contact_phone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [d.builder_name, d.contact_person_name, d.area, d.project_name, d.contact_number, d.email,
             d.designation, d.alt_phone, d.alt_contact_name, d.alt_contact_phone]
        );
        await client.query('RELEASE SAVEPOINT sp_insert');
        await client.query('COMMIT');
        res.redirect('/admin/contacts?msg=' + encodeURIComponent('Contact "' + d.builder_name + '" added'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/contacts] insert failed:', err.message);
        res.redirect('/admin/contacts/new?err=' + encodeURIComponent(userSafeError(err, 'Could not save the contact. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// EDIT (form)
// ---------------------------------------------------------------------
router.get('/contacts/edit/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/contacts?msg=' + encodeURIComponent('Invalid contact id'));
    const rows = await safe(
        `SELECT * FROM private.contacts WHERE contact_id = $1 AND deleted_at IS NULL`,
        [id], []
    );
    if (!rows.length) return res.redirect('/admin/contacts?msg=' + encodeURIComponent('Contact not found'));

    res.render('admin/contacts-edit', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Edit Contact',
        user: req.session.user,
        contact: rows[0],
        err: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// EDIT (update) — SAVEPOINT pattern
// ---------------------------------------------------------------------
router.post('/contacts/edit/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/contacts?msg=' + encodeURIComponent('Invalid contact id'));
    const d = cleanBody(req.body);
    if (!d.builder_name) {
        return res.redirect('/admin/contacts/edit/' + id + '?err=' + encodeURIComponent('Builder name is required'));
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_update');
        await client.query(
            `UPDATE private.contacts SET
                builder_name=$1, contact_person_name=$2, area=$3, project_name=$4, contact_number=$5, email=$6,
                designation=$7, alt_phone=$8, alt_contact_name=$9, alt_contact_phone=$10, updated_at=now()
              WHERE contact_id=$11 AND deleted_at IS NULL`,
            [d.builder_name, d.contact_person_name, d.area, d.project_name, d.contact_number, d.email,
             d.designation, d.alt_phone, d.alt_contact_name, d.alt_contact_phone, id]
        );
        await client.query('RELEASE SAVEPOINT sp_update');
        await client.query('COMMIT');
        res.redirect('/admin/contacts?msg=' + encodeURIComponent('Contact "' + d.builder_name + '" updated'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/contacts] update failed:', err.message);
        res.redirect('/admin/contacts/edit/' + id + '?err=' + encodeURIComponent(userSafeError(err, 'Could not update the contact. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// DELETE (soft) — never hard-delete
// ---------------------------------------------------------------------
router.post('/contacts/delete/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/contacts?msg=' + encodeURIComponent('Invalid contact id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_softdel');
        await client.query(
            `UPDATE private.contacts SET deleted_at = now()
              WHERE contact_id = $1 AND deleted_at IS NULL`,
            [id]
        );
        await client.query('RELEASE SAVEPOINT sp_softdel');
        await client.query('COMMIT');
        res.redirect('/admin/contacts?msg=' + encodeURIComponent('Contact removed (soft-deleted)'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/contacts] soft-delete failed:', err.message);
        res.redirect('/admin/contacts?msg=' + encodeURIComponent('Could not remove contact'));
    } finally {
        client.release();
    }
});

module.exports = router;
