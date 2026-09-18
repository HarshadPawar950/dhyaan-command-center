// =====================================================================
// routes/admin/builders.js — BUILDER MASTER + COMMISSION TERMS (boss-only)
// Mount: app.use('/admin', adminBuildersRoutes)
// Routes:
//   GET  /admin/builders            -> list builders + project counts
//   GET  /admin/builders/new        -> add builder form
//   POST /admin/builders/new        -> create builder (SAVEPOINT)
//   GET  /admin/builders/edit/:id   -> edit builder form (pre-filled)
//   POST /admin/builders/edit/:id   -> update builder (SAVEPOINT)
//   POST /admin/builders/delete/:id -> SOFT delete (deleted_at = now())
// Schema: private.builders (16 cols, blueprint-aligned). Linked from
//   private.projects.builder_id (nullable FK).
// Soft-delete only — never hard-delete (buddy contract).
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');
const sheet = require('../../lib/projectSheet');
const { can } = require('../../middleware/permissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMISSION_TYPES = ['percentage', 'flat', 'slab'];

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/builders] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// Normalise form body -> clean values (null for blanks).
function cleanBody(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    let ctype = t(b.commission_type) || 'percentage';
    if (!COMMISSION_TYPES.includes(ctype)) ctype = 'percentage';
    let rate = parseFloat(b.commission_rate);
    if (isNaN(rate) || rate < 0) rate = 0;
    return {
        name: t(b.name),
        rera_number: t(b.rera_number),
        gst_number: t(b.gst_number),
        contact_person: t(b.contact_person),
        phone: t(b.phone),
        email: t(b.email),
        commission_type: ctype,
        commission_rate: rate,
        payment_terms: t(b.payment_terms),
        tie_up_date: t(b.tie_up_date),         // 'YYYY-MM-DD' or null
        is_exclusive: (b.is_exclusive === 'on' || b.is_exclusive === 'true' || b.is_exclusive === true),
        notes: t(b.notes),
        status: t(b.status) || 'active'
    };
}

// ---------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------
router.get('/builders', ensureSuperAdmin, async (req, res) => {
    const builders = await safe(
        `SELECT b.builder_id, b.name, b.rera_number, b.gst_number,
                b.contact_person, b.phone, b.email,
                b.commission_type, b.commission_rate, b.payment_terms,
                b.tie_up_date, b.is_exclusive, b.status,
                COUNT(p.project_id) FILTER (WHERE p.deleted_at IS NULL) AS project_count
           FROM private.builders b
           LEFT JOIN private.projects p ON p.builder_id = b.builder_id
          WHERE b.deleted_at IS NULL
          GROUP BY b.builder_id
          ORDER BY project_count DESC, b.name ASC`,
        [], []
    );

    const totalsRow = await safe(
        `SELECT
            COUNT(*)::int AS total_builders,
            COUNT(*) FILTER (WHERE is_exclusive)::int AS exclusive_count,
            COUNT(*) FILTER (WHERE commission_rate > 0)::int AS terms_set
           FROM private.builders WHERE deleted_at IS NULL`,
        [], [{ total_builders: 0, exclusive_count: 0, terms_set: 0 }]
    );

    res.render('admin/builders-list', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Builder Master',
        user: req.session.user,
        builders,
        totals: totalsRow[0],
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// NEW (form)
// ---------------------------------------------------------------------
router.get('/builders/new', ensureSuperAdmin, (req, res) => {
    res.render('admin/builders-new', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Add Builder',
        user: req.session.user,
        commissionTypes: COMMISSION_TYPES
    });
});

// ---------------------------------------------------------------------
// NEW (create) — SAVEPOINT pattern
// ---------------------------------------------------------------------
router.post('/builders/new', ensureSuperAdmin, async (req, res) => {
    const d = cleanBody(req.body);
    if (!d.name) {
        return res.redirect('/admin/builders/new?err=' + encodeURIComponent('Builder name is required'));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_insert');
        await client.query(
            `INSERT INTO private.builders
                (name, rera_number, gst_number, contact_person, phone, email,
                 commission_type, commission_rate, payment_terms, tie_up_date,
                 is_exclusive, notes, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [d.name, d.rera_number, d.gst_number, d.contact_person, d.phone, d.email,
             d.commission_type, d.commission_rate, d.payment_terms, d.tie_up_date,
             d.is_exclusive, d.notes, d.status]
        );
        await client.query('RELEASE SAVEPOINT sp_insert');
        await client.query('COMMIT');
        res.redirect('/admin/builders?msg=' + encodeURIComponent('Builder "' + d.name + '" added'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/builders] insert failed:', err.message);
        res.redirect('/admin/builders/new?err=' + encodeURIComponent(userSafeError(err, 'Could not save the builder. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// EDIT (form)
// ---------------------------------------------------------------------
router.get('/builders/edit/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Invalid builder id'));

    const rows = await safe(
        `SELECT * FROM private.builders WHERE builder_id = $1 AND deleted_at IS NULL`,
        [id], []
    );
    if (!rows.length) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Builder not found'));

    res.render('admin/builders-edit', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Edit Builder',
        user: req.session.user,
        builder: rows[0],
        commissionTypes: COMMISSION_TYPES
    });
});

// ---------------------------------------------------------------------
// EDIT (update) — SAVEPOINT pattern
// ---------------------------------------------------------------------
router.post('/builders/edit/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Invalid builder id'));
    const d = cleanBody(req.body);
    if (!d.name) {
        return res.redirect('/admin/builders/edit/' + id + '?err=' + encodeURIComponent('Builder name is required'));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_update');
        await client.query(
            `UPDATE private.builders SET
                name=$1, rera_number=$2, gst_number=$3, contact_person=$4,
                phone=$5, email=$6, commission_type=$7, commission_rate=$8,
                payment_terms=$9, tie_up_date=$10, is_exclusive=$11,
                notes=$12, status=$13
             WHERE builder_id=$14 AND deleted_at IS NULL`,
            [d.name, d.rera_number, d.gst_number, d.contact_person, d.phone, d.email,
             d.commission_type, d.commission_rate, d.payment_terms, d.tie_up_date,
             d.is_exclusive, d.notes, d.status, id]
        );
        await client.query('RELEASE SAVEPOINT sp_update');
        await client.query('COMMIT');
        res.redirect('/admin/builders?msg=' + encodeURIComponent('Builder "' + d.name + '" updated'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/builders] update failed:', err.message);
        res.redirect('/admin/builders/edit/' + id + '?err=' + encodeURIComponent(userSafeError(err, 'Could not update the builder. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// DELETE (soft) — never hard-delete
// ---------------------------------------------------------------------
router.post('/builders/delete/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Invalid builder id'));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_softdel');
        await client.query(
            `UPDATE private.builders SET deleted_at = now()
              WHERE builder_id = $1 AND deleted_at IS NULL`,
            [id]
        );
        await client.query('RELEASE SAVEPOINT sp_softdel');
        await client.query('COMMIT');
        res.redirect('/admin/builders?msg=' + encodeURIComponent('Builder removed (soft-deleted)'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/builders] soft-delete failed:', err.message);
        res.redirect('/admin/builders?msg=' + encodeURIComponent('Could not remove builder'));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// DETAIL — one builder + its Projects (Δ5). Boss-only, matches module.
// Declared LAST so the static '/builders/new' (2-segment) matches before
// this 2-segment '/builders/:id' catch. '/builders/edit|delete/:id' are
// 3-segment and never collide.
// ---------------------------------------------------------------------
router.get('/builders/:id', ensureSuperAdmin, async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Invalid builder id'));

    const rows = await safe(
        `SELECT * FROM private.builders WHERE builder_id = $1 AND deleted_at IS NULL`,
        [id], []
    );
    if (!rows.length) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Builder not found'));
    const builder = rows[0];

    // Projects for this builder: match the FK, OR (for legacy rows that only
    // set the free-text builder field) match the builder name case-insensitively.
    const projects = await safe(
        `SELECT p.project_id,
                COALESCE(p.external_id,'')                AS external_id,
                p.title,
                COALESCE(p.location,'')                   AS location,
                COALESCE(p.area_zone,'')                  AS area_zone,
                COALESCE(p.tier,'')                       AS tier,
                COALESCE(p.construction_status::text,'')  AS construction_status,
                COALESCE(p.status_of_property,'{}')        AS status_of_property,
                COALESCE(p.configurations,'')             AS configurations,
                COALESCE(p.price_range,'')                AS price_range,
                p.listed_at,
                COUNT(u.property_id) FILTER (WHERE u.deleted_at IS NULL)::int AS unit_count
           FROM private.projects p
      LEFT JOIN private.properties u ON u.project_id = p.project_id
          WHERE p.deleted_at IS NULL
            AND ( p.builder_id = $1
                  OR (p.builder_id IS NULL AND LOWER(COALESCE(p.builder,'')) = LOWER($2)) )
       GROUP BY p.project_id
       ORDER BY p.listed_at DESC NULLS LAST, p.title`,
        [id, builder.name], []
    );

    // Phase 3 · C — offers on this builder (expired flagged; active-list auto-hide in view)
    const builderOffers = await safe(
        `SELECT o.offer_id, o.offer_text, o.valid_from, o.valid_to, o.status, o.project_id,
                p.title AS project_title,
                (o.valid_to IS NOT NULL AND o.valid_to < CURRENT_DATE) AS is_expired
           FROM private.offers o
           LEFT JOIN private.projects p ON p.project_id = o.project_id
          WHERE o.builder_id = $1 AND o.deleted_at IS NULL
          ORDER BY o.created_at DESC`, [id], []);
    const canPricing = await can(req.session.user, 'builder.pricing.manage', req);

    res.render('admin/builders-detail', {
        csrfToken: req.csrfToken(),
        pageTitle: builder.name,
        user: req.session.user,
        builder,
        projects,
        builderOffers,
        canPricing,
        statusOptions: sheet.STATUS_OPTIONS,
    });
});

module.exports = router;
