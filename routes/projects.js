// =============================================================
// routes/projects.js — Employee Properties list/detail
// Day 7: soft-delete aware (deleted_at IS NULL filter on all queries)
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { buildMap } = require('../lib/mapEmbed');
const { loadProjectView, buildProjectSearch } = require('../lib/projectExtras');
const sheet = require('../lib/projectSheet');
const { _canManage } = require('../lib/propsNav');

// WORLD-SEALING (CAPTAIN ruling 2026-07-26): /projects is the EMPLOYEE property
// browse. A manager (properties.manage / super) belongs in the admin world, so
// send them to their /admin/projects twin instead of the employee page. Keeps
// worlds clean without weakening anything (this is display routing; every admin
// route still enforces its own gate).
function sealManagersToAdmin(req, res, next) {
    if (_canManage(req.session && req.session.user)) {
        const id = req.params && req.params.id;
        return res.redirect(id ? '/admin/projects/' + id : '/admin/projects');
    }
    next();
}

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[properties] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =============================================================
// GET /projects — list with filters
// =============================================================
router.get('/', ensureAuthenticated, sealManagersToAdmin, async (req, res) => {

    const f = {
        q:       (req.query.q       || '').trim(),
        builder: (req.query.builder || '').trim(),
        area:    (req.query.area    || '').trim(),
        tier:    (req.query.tier    || '').trim(),
        status:  (req.query.status  || '').trim(),
        category:(req.query.category|| '').trim(),
    };

    // Day 7: deleted_at IS NULL is ALWAYS first condition
    const conds = ['p.deleted_at IS NULL'];
    const params = [];
    let i = 1;
    // 022 mixed-use filter: a Mixed project matches BOTH Residential and Commercial.
    if (f.category === 'residential') { conds.push('p.has_residential'); }
    else if (f.category === 'commercial') { conds.push('p.has_commercial'); }
    else if (f.category === 'mixed') { conds.push('p.has_residential AND p.has_commercial'); }

    if (f.q) {
        // Shared multi-word search across the 6 project columns (title, builder,
        // location, area_zone, locality, external_id) — see lib/projectExtras.
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
    if (f.status && sheet.STATUS_VALUE_SET.has(f.status)) {
        // 053: match on the project's own status_of_property tags (array overlap),
        // same as /admin/projects. The stale construction_status enum is no longer filtered.
        conds.push(`p.status_of_property && ARRAY[$${i++}]::text[]`);
        params.push(f.status);
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

    // Stat counts (hide soft-deleted)
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

    res.render('properties', {
        pageTitle: 'Projects',
        user: req.session.user,
        properties,
        stats: stats[0],
        filters: f,
        builders: builders.map(r => r.builder),
        areas: areas.map(r => r.area_zone),
        tiers: tiers.map(r => r.tier),
        statusOptions: sheet.STATUS_OPTIONS,
        showing: properties.length,
    });
});

// =============================================================
// GET /projects/:id — single project detail + units
// =============================================================
router.get('/:id', ensureAuthenticated, sealManagersToAdmin, async (req, res) => {
    const propertyId = req.params.id;

    if (!UUID_RE.test(propertyId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const view = await loadProjectView(propertyId);
    if (!view) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    res.render('property-detail', {
        pageTitle: view.property.title,
        user: req.session.user,
        property: view.property,
        units: view.units,
        map: view.map,
        images: view.images,
        videos: view.videos,
        brochures: view.brochures,
        floorPlans: view.floorPlans,
        amenities: view.amenities,
        amenitiesByCategory: view.amenitiesByCategory,
        configSummary: view.configSummary,
        unitsData: view.availUnits,
        canManage: false,       // employee browse is read-only; /admin/projects/:id manages
        sheet,
        canSeeMarketing: (u => !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'))(req.session.user),
    });
});

module.exports = router;


