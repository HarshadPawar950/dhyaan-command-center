// =============================================================
// routes/admin/projects.js
// Day 2 Phase 4 — Properties admin pages
// Day 6 — soft-delete aware (deleted_at IS NULL filters added)
//
// Routes:
//   GET /admin/projects              → list of projects with filters
//   GET /admin/projects/:id          → single project + all its unit variants
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdminOrRole } = require('../../middleware/ensureAdminOrRole');
const { ensurePermission, can } = require('../../middleware/permissions');
const { buildMap } = require('../../lib/mapEmbed');
const { loadProjectView, buildSearch, buildProjectSearch } = require('../../lib/projectExtras');
const { FURNISHING, POSSESSION } = require('../../lib/unitForm');
// Canonical price brackets — the SAME keys the project budget_ranges tag uses.
const { BUDGET_BUCKETS, BUDGET_BUCKET_KEYS } = require('../../lib/budgetBuckets');
const sheet = require('../../lib/projectSheet');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/projects] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

// safe csrf token (won't crash if csurf not on this route)
function csrf(req) {
    try { return (typeof req.csrfToken === 'function') ? req.csrfToken() : ''; }
    catch (_) { return ''; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Budget filter (052): matches on the project's OWN budget_ranges tag array —
// NOT on unit prices — so a project with no units still filters correctly.
// Buckets are the canonical shared list (lib/budgetBuckets.js); the tag and the
// filter are literally the same keys.
const PRICE_BUCKETS = BUDGET_BUCKETS;
const PRICE_BUCKET_KEYS = BUDGET_BUCKET_KEYS;

// =============================================================
// GET /admin/projects — list with filters
// =============================================================
router.get('/projects', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage'), async (req, res) => {

    const f = {
        q:       (req.query.q       || '').trim(),
        builder: (req.query.builder || '').trim(),
        area:    (req.query.area    || '').trim(),
        tier:    (req.query.tier    || '').trim(),
        category:(req.query.category|| '').trim(),
    };

    // multiselect: ?price=50-100&price=300plus  → array of whitelisted keys
    let _priceSel = req.query.price || [];
    if (!Array.isArray(_priceSel)) _priceSel = [_priceSel];
    f.price = _priceSel.map(k => String(k).trim()).filter(k => PRICE_BUCKET_KEYS.has(k));

    // multiselect: ?status=pre_launch&status=ready_to_move → array of valid slugs
    let _statusSel = req.query.status || [];
    if (!Array.isArray(_statusSel)) _statusSel = [_statusSel];
    f.status = _statusSel.map(s => String(s).trim()).filter(s => sheet.STATUS_VALUES.includes(s));

    // Day 6: deleted_at IS NULL is ALWAYS the first condition (hide soft-deleted)
    const conds = ['p.deleted_at IS NULL'];
    const params = [];
    let i = 1;
    // 022 mixed-use filter: booleans, so a Mixed project matches Residential AND Commercial.
    if (f.category === 'residential') { conds.push('p.has_residential'); }
    else if (f.category === 'commercial') { conds.push('p.has_commercial'); }
    else if (f.category === 'mixed') { conds.push('p.has_residential AND p.has_commercial'); }

    if (f.q) {
        // Shared multi-word search across the 6 project columns — see lib/projectExtras.
        i = buildProjectSearch(f.q, 'p', conds, params, i);
    }
    if (f.builder) {
        conds.push(`LOWER(COALESCE(p.builder, '')) = $${i++}`);
        params.push(f.builder.toLowerCase());
    }
    if (f.area) {
        conds.push(`LOWER(COALESCE(p.area_zone, '')) = $${i++}`);
        params.push(f.area.toLowerCase());
    }
    if (f.tier) {
        conds.push(`LOWER(COALESCE(p.tier, '')) = $${i++}`);
        params.push(f.tier.toLowerCase());
    }
    if (f.status.length) {
        // 053: status_of_property is now text[] — match on array overlap (&&),
        // same as the budget filter, so the tag and the filter stay in sync.
        conds.push(`p.status_of_property && $${i++}::text[]`);
        params.push(f.status);
    }
    if (f.price.length) {
        // 052: match the project's own budget_ranges tags (array overlap) — works
        // even when the project has no units entered. f.price is whitelisted above.
        conds.push(`p.budget_ranges && $${i++}::text[]`);
        params.push(f.price);
    }

    const whereClause = 'WHERE ' + conds.join(' AND ');

    const properties = await safe(
        `SELECT
             p.project_id,
             COALESCE(p.external_id, '')                   AS external_id,
             p.title,
             COALESCE(p.location, '')                      AS location,
             COALESCE(p.builder, '')                       AS builder,
             COALESCE(p.area_zone, '')                     AS area_zone,
             COALESCE(p.tier, '')                          AS tier,
             COALESCE(p.possession, '')                    AS possession,
             COALESCE(p.configurations, '')                AS configurations,
             COALESCE(p.price_range, '')                   AS price_range,
             COALESCE(p.construction_status::text, '')     AS construction_status,
             COALESCE(p.status_of_property, '{}')          AS status_of_property,
             COALESCE(p.type::text, '')                    AS type,
             COALESCE(p.category::text, '')                AS category,
             COALESCE(p.has_residential,false)             AS has_residential,
             COALESCE(p.has_commercial,false)              AS has_commercial,
             COALESCE(p.notes, '')                         AS notes,
             p.price,
             p.listed_at,
             COALESCE(COUNT(u.property_id), 0)::int            AS unit_count,
             MIN(u.price_lakhs)                            AS min_price_lakhs,
             MAX(u.price_lakhs)                            AS max_price_lakhs
           FROM private.projects p
      LEFT JOIN private.properties u ON u.project_id = p.project_id
           ${whereClause}
       GROUP BY p.project_id
       ORDER BY p.listed_at DESC NULLS LAST, p.title
          LIMIT 500`,
        params,
        []
    );

    // Stat counts (also hide soft-deleted)
    const stats = await safe(
        `SELECT
             (SELECT COUNT(*)::int FROM private.projects WHERE deleted_at IS NULL) AS total_projects,
             (SELECT COUNT(*)::int FROM private.properties WHERE deleted_at IS NULL) AS total_units,
             (SELECT COUNT(DISTINCT builder)::int FROM private.projects WHERE builder IS NOT NULL AND builder <> '' AND deleted_at IS NULL) AS total_builders,
             (SELECT COUNT(DISTINCT area_zone)::int FROM private.projects WHERE area_zone IS NOT NULL AND area_zone <> '' AND deleted_at IS NULL) AS total_areas`,
        [],
        [{ total_projects: 0, total_units: 0, total_builders: 0, total_areas: 0 }]
    );

    const builders = await safe(
        `SELECT DISTINCT builder FROM private.projects
          WHERE builder IS NOT NULL AND builder <> '' AND deleted_at IS NULL
       ORDER BY builder`,
        [], []
    );
    const areas = await safe(
        `SELECT DISTINCT area_zone FROM private.projects
          WHERE area_zone IS NOT NULL AND area_zone <> '' AND deleted_at IS NULL
       ORDER BY area_zone`,
        [], []
    );
    const tiers = await safe(
        `SELECT DISTINCT tier FROM private.projects
          WHERE tier IS NOT NULL AND tier <> '' AND deleted_at IS NULL
       ORDER BY tier`,
        [], []
    );
    const flash = req.session.propertiesListFlash || null;
    req.session.propertiesListFlash = null;

    res.render('admin/projects-list', {
        pageTitle: 'Projects',
        user: req.session.user,
        properties,
        stats: stats[0],
        filters: f,
        builders: builders.map(r => r.builder),
        areas: areas.map(r => r.area_zone),
        tiers: tiers.map(r => r.tier),
        statusOptions: sheet.STATUS_OPTIONS,
        priceBuckets: PRICE_BUCKETS.map(b => ({ key: b.key, label: b.label })),
        showing: properties.length,
        flash,
    });
});

// =============================================================
// GET /admin/projects/:id — single project detail + units
// =============================================================
router.get('/projects/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage'), async (req, res) => {
    const propertyId = req.params.id;

    if (!UUID_RE.test(propertyId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    // Unified data source: the SAME loadProjectView the employee detail uses,
    // so /admin/projects/:id and /projects/:id never diverge again.
    const view = await loadProjectView(propertyId);
    if (!view) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }
    const property = view.property;
    const units = view.units;
    const map = view.map;
    const images = view.images, videos = view.videos, brochures = view.brochures;

    const configBreakdown = units.reduce((acc, u) => {
        const cfg = (u.config || 'Other').trim();
        acc[cfg] = (acc[cfg] || 0) + 1;
        return acc;
    }, {});

    const flash = req.session.propertyEditFlash || null;
    req.session.propertyEditFlash = null;

    // Phase 3 · B — dated price revisions (read; current = latest effective_date)
    const priceUpdates = await safe(
        `SELECT price_update_id, effective_date, price_note, source, created_at
           FROM private.project_price_updates
          WHERE project_id = $1 AND deleted_at IS NULL
          ORDER BY effective_date DESC, created_at DESC`, [propertyId], []);
    const canPricing = await can(req.session.user, 'builder.pricing.manage', req);

    // mig 055 — INTERNAL builder cost sheets (off-public files). Anyone who
    // reaches this admin detail route already holds properties.manage, which is
    // exactly the gate on the cost-sheet up/download routes.
    const costSheets = await safe(
        `SELECT sheet_id, original_name, mime_type, file_size_bytes, created_at
           FROM private.project_cost_sheets
          WHERE project_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC`, [propertyId], []);

    // Phase 3 · C — offers on this project (expired flagged; auto-hidden from the active list in the view)
    const projectOffers = await safe(
        `SELECT offer_id, offer_text, valid_from, valid_to, status,
                (valid_to IS NOT NULL AND valid_to < CURRENT_DATE) AS is_expired
           FROM private.offers
          WHERE project_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC`, [propertyId], []);

    res.render('admin/projects-detail', {
        pageTitle: property.title,
        user: req.session.user,
        property,
        units,
        configBreakdown,
        map,
        amenities: view.amenities,
        amenitiesByCategory: view.amenitiesByCategory,
        configSummary: view.configSummary,
        unitsData: view.availUnits,
        floorPlans: view.floorPlans,
        sheet,
        canSeeMarketing: (u => !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'))(req.session.user),
        images,
        videos,
        brochures,
        flash,
        priceUpdates,
        canPricing,
        projectOffers,
        costSheets,
        projectId: propertyId,
        csrfToken: csrf(req),
    });
});

// =============================================================
// GET /admin/properties — the INVENTORY list (all saleable properties/units),
// distinct from /admin/projects (developments). Replaces the old 301 trap.
// =============================================================
router.get('/properties', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage'), async (req, res) => {
    const f = {
        q:          (req.query.q          || '').trim(),
        config:     (req.query.config     || '').trim(),
        project:    (req.query.project    || '').trim(),
        category:   (req.query.category   || '').trim(),
        listing:    (req.query.listing    || '').trim(),
        possession: (req.query.possession || '').trim(),
        furnishing: (req.query.furnishing || '').trim(),
        budget_min: (req.query.budget_min || '').trim(),
        budget_max: (req.query.budget_max || '').trim(),
    };
    const conds = ['u.deleted_at IS NULL', 'p.deleted_at IS NULL'];
    const params = [];
    let i = 1;
    if (f.q) {
        // Same multi-word engine as the project lists. Searches the unit's own
        // fields (title, config) PLUS the parent project's 6 searchable columns,
        // so location/area_zone/locality now hit and "Nerul 2BHK" works here too.
        i = buildSearch(f.q, [
            'u.title', 'u.config',
            'p.title', 'p.builder', 'p.location', 'p.area_zone', 'p.locality', 'p.external_id',
        ], conds, params, i);
    }
    if (f.config)     { conds.push(`LOWER(COALESCE(u.config,'')) = $${i++}`); params.push(f.config.toLowerCase()); }
    if (UUID_RE.test(f.project)) { conds.push(`u.project_id = $${i++}`); params.push(f.project); }
    if (f.category === 'residential' || f.category === 'commercial') { conds.push(`u.category::text = $${i++}`); params.push(f.category); }
    if (f.listing === 'sale') { conds.push(`u.listing_sale IS TRUE`); }
    else if (f.listing === 'rent') { conds.push(`u.listing_rent IS TRUE`); }
    if (f.possession) { conds.push(`u.possession_status::text = $${i++}`); params.push(f.possession); }
    if (f.furnishing) { conds.push(`u.furnishing::text = $${i++}`); params.push(f.furnishing); }
    // budget in ₹ (prefer expected_price; fall back to price_lakhs*100000)
    if (f.budget_min && !isNaN(Number(f.budget_min))) { conds.push(`COALESCE(u.expected_price, u.price_lakhs*100000) >= $${i++}`); params.push(Number(f.budget_min)); }
    if (f.budget_max && !isNaN(Number(f.budget_max))) { conds.push(`COALESCE(u.expected_price, u.price_lakhs*100000) <= $${i++}`); params.push(Number(f.budget_max)); }
    const where = 'WHERE ' + conds.join(' AND ');

    const units = await safe(
        `SELECT u.property_id, COALESCE(u.title,'') AS title, COALESCE(u.config,'') AS config,
                u.carpet_area, u.sellable_area, COALESCE(u.carpet_sqft,'') AS carpet_sqft, COALESCE(u.area_unit,'sqft') AS area_unit,
                COALESCE(u.listing_sale,true) AS listing_sale, COALESCE(u.listing_rent,false) AS listing_rent,
                u.expected_price, u.price_per_sqft, u.price_lakhs, u.price_negotiable,
                u.floor_number, u.total_floors, u.facing::text AS facing,
                u.furnishing::text AS furnishing,
                u.possession_status::text AS possession_status,
                u.category::text AS category,
                COALESCE(u.owner_name,'') AS owner_name, COALESCE(u.owner_phone,'') AS owner_phone,
                p.project_id, p.title AS project_title,
                COALESCE(p.location,'') AS location, COALESCE(p.builder,'') AS builder,
                (SELECT file_path FROM private.property_images
                   WHERE project_id = u.project_id AND COALESCE(media_type,'photo') = 'photo' AND deleted_at IS NULL
                   ORDER BY sort_order, created_at LIMIT 1) AS thumb
           FROM private.properties u
           LEFT JOIN private.projects p ON p.project_id = u.project_id AND p.deleted_at IS NULL
           ${where}
       ORDER BY u.title NULLS LAST, COALESCE(u.carpet_area,0), u.config
          LIMIT 1000`,
        params, []
    );
    const stats = await safe(
        `SELECT (SELECT COUNT(*)::int FROM private.properties WHERE deleted_at IS NULL) AS total_units,
                (SELECT COUNT(DISTINCT project_id)::int FROM private.properties WHERE deleted_at IS NULL) AS in_projects`,
        [], [{ total_units: 0, in_projects: 0 }]
    );
    const configs = await safe(
        `SELECT DISTINCT config FROM private.properties WHERE config IS NOT NULL AND config <> '' AND deleted_at IS NULL ORDER BY config`,
        [], []
    );
    const projectOpts = await safe(
        `SELECT project_id, title FROM private.projects WHERE deleted_at IS NULL ORDER BY title`,
        [], []
    );
    const flash = req.session.propertiesListFlash || null;
    req.session.propertiesListFlash = null;

    res.render('admin/properties-list', {
        pageTitle: 'Properties',
        user: req.session.user,
        units,
        stats: stats[0],
        filters: f,
        configs: configs.map(r => r.config),
        projectOpts,
        opts: { FURNISHING, POSSESSION },
        showing: units.length,
        flash,
    });
});

// /admin/properties/:id — send to the unit detail (302, never a cached 301).
router.get('/properties/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage'), (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).render('404', { pageTitle: 'Not Found' });
    return res.redirect(302, '/properties/' + req.params.id);
});

module.exports = router;
