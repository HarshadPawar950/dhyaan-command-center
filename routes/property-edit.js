// =============================================================
// routes/property-edit.js
// Edit Property — admin + employee
//
// Routes:
//   GET  /projects/:id/edit   → pre-filled edit form
//   POST /projects/:id/edit   → UPDATE property
//
// Day 6 — mirrors property-new.js + lead-edit.js pattern.
// SAVEPOINT-safe for enum-cast resilience. Soft-delete aware:
// won't edit a property where deleted_at IS NOT NULL.
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { logFromRequest } = require('../middleware/historyLogger');
const { validateGoogleMapsUrl, validateCoords } = require('../lib/mapEmbed');
const { BHK_OPTIONS, normalizeBhk } = require('../lib/propertyConfig');
const { can, ensurePermission } = require('../middleware/permissions');
const { ensureAdminOrRole } = require('../middleware/ensureAdminOrRole');
 const { propsBaseFor } = require('../lib/propsNav');

const { amenitiesForEditor } = require('../lib/projectExtras');
const sheet = require('../lib/projectSheet');
const { buildSheetData, sheetUpdateSql, sheetParams, FIELDS, SIDES, STATUS_VALUES, STATUS_VALUE_SET, BUDGET_BUCKET_KEYS } = sheet;
const { parseUnits, saveUnits, loadUnits } = require('../lib/availableUnits');
const { userSafeError } = require('../lib/safeDbError');
function parsePropTypes(body) {
    const v = (body && body.property_type) || [];
    const arr = (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(Boolean);
    return [...new Set(arr)];
}
// budget_ranges checkbox group -> clean text[] (whitelist to known bucket keys)
function parseBudgetRanges(body) {
    const v = (body && body.budget_ranges) || [];
    const arr = (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(k => BUDGET_BUCKET_KEYS.has(k));
    return [...new Set(arr)];
}
// 054: budget_other free text — kept ONLY when the 'other' tag is ticked, else NULL
// (decision (a): unticking Other clears the text so it can't orphan behind a missing chip).
function parseBudgetOther(body, ranges) {
    if (!ranges.includes('other')) return null;
    const t = String((body && body.budget_other) || '').trim();
    return t || null;
}
// status_of_property checkbox group -> clean text[] (whitelist to known status slugs) — 053
function parseStatuses(body) {
    const v = (body && body.status_of_property) || [];
    const arr = (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(k => STATUS_VALUE_SET.has(k));
    return [...new Set(arr)];
}

// D4 fix: editing catalog rows is a manager action (matches /admin/projects gate).
const propsManageGate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

// date -> yyyy-mm-dd for <input type=date> (empty string if null)
function _ymd(d) {
    if (!d) return '';
    try { const t = new Date(d); return isNaN(t) ? '' : t.toISOString().slice(0, 10); } catch (e) { return ''; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[properties/edit] query failed:', err.message);
        return fallback;
    }
}

// =============================================================
// GET /projects/:id/edit — show pre-filled form
// =============================================================
router.get('/:id/edit', ensureAuthenticated, propsManageGate, async (req, res) => {
    const propertyId = req.params.id;

    if (!UUID_RE.test(propertyId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const rows = await safe(
        `SELECT project_id,
                COALESCE(external_id, '')                AS external_id,
                title,
                COALESCE(location, '')                   AS location,
                COALESCE(builder, '')                    AS builder,
                COALESCE(area_zone, '')                  AS area_zone,
                COALESCE(tier, '')                       AS tier,
                COALESCE(possession, '')                 AS possession,
                COALESCE(configurations, '')             AS configurations,
                COALESCE(price_range, '')                AS price_range,
                COALESCE(construction_status::text, '')  AS construction_status,
                COALESCE(type::text, '')                 AS type,
                COALESCE(notes, '')                      AS notes,
                COALESCE(google_maps_url, '')            AS google_maps_url,
                COALESCE(bhk_config, '{}')               AS bhk_config,
                latitude,
                longitude,
                price,
                COALESCE(rera_number, '')                AS rera_number,
                COALESCE(about, '')                      AS about,
                possession_date, launch_date,
                total_towers, total_units_count,
                land_area, COALESCE(land_area_unit,'acres') AS land_area_unit,
                COALESCE(location_advantages,'{}')       AS location_advantages,
                COALESCE(price_list_note,'')             AS price_list_note,
                category::text                           AS category,
                COALESCE(has_residential,false)          AS has_residential,
                COALESCE(has_commercial,false)           AS has_commercial,
                COALESCE(property_type,'{}')             AS property_type,
                COALESCE(property_type_other_res,'')     AS property_type_other_res,
                COALESCE(property_type_other_com,'')     AS property_type_other_com,
                COALESCE(budget_ranges,'{}')             AS budget_ranges,
                COALESCE(budget_other,'')                AS budget_other,
                COALESCE(status_of_property,'{}')        AS status_of_property,
                ${FIELDS.join(', ')}
           FROM private.projects
          WHERE project_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [propertyId],
        []
    );

    if (rows.length === 0) {
        return res.status(404).render('404', { pageTitle: 'Project Not Found' });
    }
    const property = rows[0];

    // Dropdown values
    const builders = await safe(
        `SELECT DISTINCT builder FROM private.projects
          WHERE builder IS NOT NULL AND builder <> '' ORDER BY builder`, [], []);
    const areas = await safe(
        `SELECT DISTINCT area_zone FROM private.projects
          WHERE area_zone IS NOT NULL AND area_zone <> '' ORDER BY area_zone`, [], []);
    const tiers = await safe(
        `SELECT DISTINCT tier FROM private.projects
          WHERE tier IS NOT NULL AND tier <> '' ORDER BY tier`, [], []);
    const statuses = await safe(
        `SELECT DISTINCT construction_status::text AS s FROM private.projects
          WHERE construction_status IS NOT NULL ORDER BY s`, [], []);
    const types = await safe(
        `SELECT DISTINCT type::text AS t FROM private.projects
          WHERE type IS NOT NULL ORDER BY t`, [], []);

    const formData = {
        title: property.title,
        location: property.location,
        builder: property.builder,
        area_zone: property.area_zone,
        tier: property.tier,
        possession: property.possession,
        configurations: property.configurations,
        price_range: property.price_range,
        construction_status: property.construction_status,
        type: property.type,
        price: (property.price === null || property.price === undefined) ? '' : String(property.price),
        notes: property.notes,
        google_maps_url: property.google_maps_url,
        bhk_config: Array.isArray(property.bhk_config) ? property.bhk_config : [],
        latitude: (property.latitude === null || property.latitude === undefined) ? '' : String(property.latitude),
        longitude: (property.longitude === null || property.longitude === undefined) ? '' : String(property.longitude),
        // 019 additive
        rera_number: property.rera_number,
        about: property.about,
        possession_date: _ymd(property.possession_date),
        launch_date: _ymd(property.launch_date),
        total_towers: (property.total_towers == null) ? '' : String(property.total_towers),
        total_units_count: (property.total_units_count == null) ? '' : String(property.total_units_count),
        land_area: (property.land_area == null) ? '' : String(property.land_area),
        land_area_unit: property.land_area_unit || 'acres',
        location_advantages: Array.isArray(property.location_advantages) ? property.location_advantages.join('\n') : '',
        price_list_note: property.price_list_note || '',
        category: property.category || '',
        has_residential: property.has_residential === true,
        has_commercial:  property.has_commercial === true,
        // 024: property_type is a text[]; keep it an array for the checkbox grid.
        property_type: Array.isArray(property.property_type) ? property.property_type : [],
        // 058: per-category Property Type "Other" free-text companions.
        property_type_other_res: property.property_type_other_res || '',
        property_type_other_com: property.property_type_other_com || '',
        // 052: budget_ranges is a text[]; keep it an array for the bucket checkbox grid.
        budget_ranges: Array.isArray(property.budget_ranges) ? property.budget_ranges : [],
        // 054: budget_other free-text companion to the 'other' bucket tag.
        budget_other: property.budget_other || '',
        // 053: status_of_property is a text[]; keep it an array for the status checkbox grid.
        status_of_property: Array.isArray(property.status_of_property) ? property.status_of_property : [],
    };
    // 021/022 sheet fields into formData
    FIELDS.forEach(f => { formData[f] = (property[f] === null || property[f] === undefined) ? '' : String(property[f]); });
    // 025: available units for the repeater
    const unitsData = await loadUnits(pool, property.project_id);

    const media = await safe(
        `SELECT image_id, file_path, COALESCE(caption,'') AS caption,
                COALESCE(media_type,'photo') AS media_type,
                COALESCE(original_name,'')   AS original_name,
                mime_type, file_size_bytes
           FROM private.property_images
          WHERE project_id = $1 AND deleted_at IS NULL
       ORDER BY sort_order, created_at`,
        [propertyId], []
    );
    const images    = media.filter(m => m.media_type === 'photo');
    const videos    = media.filter(m => m.media_type === 'video');
    const brochures = media.filter(m => m.media_type === 'brochure');

    // Show the media manager to anyone who can actually manage properties
    // (admin/super_admin, or the hr_manager fine-role via the Δ1 grant).
    let canManageMedia = false;
    try { canManageMedia = await can(req.session.user, 'properties.manage', req); } catch (_) {}

    // amenities checklist (master grouped by category + which are selected)
    let amenityGroups = {}, selectedAmenities = new Set();
    try {
        const am = await amenitiesForEditor(property.project_id);
        amenityGroups = am.byCategory;
        selectedAmenities = am.selectedIds;
    } catch (_) {}

    res.render('property-edit', {
        pageTitle: 'Edit Project — ' + property.title,
        user: req.session.user,
        propertyId: property.project_id,
        externalId: property.external_id,
        images,
        videos,
        brochures,
        floorPlans: media.filter(m => m.media_type === 'floor_plan'),
        canManageMedia,
        amenityGroups,
        selectedAmenities,
        sheet,
        unitsData,
        canSeeMarketing: (u => !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'))(req.session.user),
        builders: builders.map(r => r.builder).filter(Boolean),
        areas: areas.map(r => r.area_zone).filter(Boolean),
        tiers: tiers.map(r => r.tier).filter(Boolean),
        statuses: statuses.map(r => r.s).filter(Boolean),
        types: types.map(r => r.t).filter(Boolean),
        bhkOptions: BHK_OPTIONS,
        flash: req.session.propertyEditFlash || null,
        formData,
        csrfToken: req.csrfToken(),
    });

    req.session.propertyEditFlash = null;
});

// =============================================================
// POST /projects/:id/edit — update the property
// =============================================================
router.post('/:id/edit', ensureAuthenticated, propsManageGate, async (req, res) => {
    const user = req.session.user;
    const propertyId = req.params.id;
    const body = req.body || {};

    if (!UUID_RE.test(propertyId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const data = {
        title:               (body.title || '').trim(),
        location:            (body.location || '').trim(),
        builder:             (body.builder || '').trim(),
        area_zone:           (body.area_zone || '').trim(),
        tier:                (body.tier || '').trim(),
        possession:          (body.possession || '').trim(),
        configurations:      (body.configurations || '').trim(),
        price_range:         (body.price_range || '').trim(),
        construction_status: (body.construction_status || '').trim().toLowerCase(),
        type:                (body.type || '').trim().toLowerCase(),
        price:               (body.price || '').trim(),
        notes:               (body.notes || '').trim(),
        google_maps_url:     (body.google_maps_url || '').trim(),
        latitude:            (body.latitude || '').trim(),
        longitude:           (body.longitude || '').trim(),
        bhk_config:          normalizeBhk(body.bhk_config),
    };

    // 019 additive PROJECT config fields (all optional)
    const cfg = {
        about:            (body.about || '').trim(),
        possession_date:  (body.possession_date || '').trim(),
        launch_date:      (body.launch_date || '').trim(),
        total_towers:     (body.total_towers || '').trim(),
        total_units_count:(body.total_units_count || '').trim(),
        land_area:        (body.land_area || '').trim(),
        land_area_unit:   (body.land_area_unit || '').trim() || 'acres',
        price_list_note:  (body.price_list_note || '').trim(),
        rera_number:      (body.rera_number || '').trim(),
    };
    // location_advantages: textarea, one advantage per line
    const locationAdvantages = String(body.location_advantages || '')
        .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // amenities: checkbox group of amenity_ids (validate uuid shape)
    const amenityIds = (Array.isArray(body.amenities) ? body.amenities : (body.amenities ? [body.amenities] : []))
        .map(String).filter(v => UUID_RE.test(v));

    // Sheet-mirror: no free "Location" field — derive from Locality.
    if (!data.location) data.location = (body.locality || '').trim();

    // -------- VALIDATION --------
    const errors = [];
    if (!data.title || data.title.length < 2) {
        errors.push('Project title is required (at least 2 characters).');
    }
    if (!data.location) {
        errors.push('Locality is required (it also fills Location).');
    }
    const mapCheck = validateGoogleMapsUrl(data.google_maps_url);
    if (!mapCheck.ok) errors.push(mapCheck.reason);
    const coordCheck = validateCoords(data.latitude, data.longitude);
    if (!coordCheck.ok) errors.push(coordCheck.reason);
    // 022: at least one category (mirrors the DB CHECK; prevents a silent
    // best-effort rollback of the whole sheet/config update).
    const _sheetChk = buildSheetData(body);
    if (!_sheetChk.has_residential && !_sheetChk.has_commercial) {
        errors.push('Select at least one category (Residential and/or Commercial).');
    }
    // Reject out-of-range / non-numeric figures up front (named per field). This
    // also stops total_units_count / total_towers overflow being SILENTLY dropped
    // in the best-effort config savepoint — the user now gets a clear message
    // instead of a false "updated successfully" with the value gone.
    errors.push(...sheet.validateNumbers(body));
    // 053: status_of_property is a multi-select text[]; parseStatuses whitelists to
    // the known slugs (empty allowed) — no extra validation needed.

    if (errors.length > 0) {
        req.session.propertyEditFlash = { type: 'error', text: errors.join(' ') };
        return res.redirect(`/projects/${propertyId}/edit`);
    }

    // construction_status is NOT a form field — derive the single NOT-NULL enum from
    // the status_of_property[] tags. May be '' when no tag maps; the main UPDATE below
    // COALESCEs '' → existing value so an edit never NULLs the column (NOT NULL) or
    // clobbers it, and no longer falls into the savepoint fallback.
    data.construction_status = sheet.deriveConstructionStatus(parseStatuses(body));

    // -------- UPDATE WITH SAVEPOINT --------
    const client = await pool.connect();
    let firstError = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT before_update');

        let result;
        try {
            result = await client.query(
                `UPDATE private.projects SET
                    title = $1,
                    location = NULLIF($2, ''),
                    builder = NULLIF($3, ''),
                    area_zone = NULLIF($4, ''),
                    tier = NULLIF($5, ''),
                    possession = NULLIF($6, ''),
                    configurations = NULLIF($7, ''),
                    price_range = NULLIF($8, ''),
                    construction_status = COALESCE(NULLIF($9, '')::private.property_status, construction_status),
                    type = NULLIF($10, '')::private.requirement_type,
                    price = NULLIF($11, '')::numeric,
                    notes = NULLIF($12, ''),
                    google_maps_url = NULLIF($13, ''),
                    bhk_config = $14::text[],
                    latitude = NULLIF($15, '')::numeric,
                    longitude = NULLIF($16, '')::numeric
                 WHERE project_id = $17 AND deleted_at IS NULL
                 RETURNING project_id, external_id, title`,
                [
                    data.title, data.location, data.builder, data.area_zone, data.tier,
                    data.possession, data.configurations, data.price_range,
                    data.construction_status, data.type, data.price, data.notes,
                    data.google_maps_url,
                    data.bhk_config.length ? data.bhk_config : null,
                    data.latitude, data.longitude,
                    propertyId,
                ]
            );
        } catch (err) {
            firstError = err.message;
            console.warn('[properties/edit] full UPDATE failed, rolling back to savepoint:', err.message);
            await client.query('ROLLBACK TO SAVEPOINT before_update');

            // Fallback: update without enum/numeric columns. bhk_config (text[])
            // is safe to keep; lat/long numerics are dropped here like price.
            result = await client.query(
                `UPDATE private.projects SET
                    title = $1,
                    location = NULLIF($2, ''),
                    builder = NULLIF($3, ''),
                    area_zone = NULLIF($4, ''),
                    tier = NULLIF($5, ''),
                    possession = NULLIF($6, ''),
                    configurations = NULLIF($7, ''),
                    price_range = NULLIF($8, ''),
                    notes = NULLIF($9, ''),
                    google_maps_url = NULLIF($10, ''),
                    bhk_config = $11::text[]
                 WHERE project_id = $12 AND deleted_at IS NULL
                 RETURNING project_id, external_id, title`,
                [
                    data.title, data.location, data.builder, data.area_zone, data.tier,
                    data.possession, data.configurations, data.price_range, data.notes,
                    data.google_maps_url,
                    data.bhk_config.length ? data.bhk_config : null,
                    propertyId,
                ]
            );
        }

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            req.session.propertyEditFlash = { type: 'error', text: 'Property not found or already deleted.' };
            return res.redirect(propsBaseFor(user));
        }

        const updated = result.rows[0];

        // 019 additive config fields + amenities sync — isolated savepoint so a
        // cast hiccup here never poisons the core update above (best-effort).
        try {
            await client.query('SAVEPOINT before_config');
            await client.query(
                `UPDATE private.projects SET
                    about               = NULLIF($1,''),
                    possession_date     = NULLIF($2,'')::date,
                    launch_date         = NULLIF($3,'')::date,
                    total_towers        = NULLIF($4,'')::int,
                    total_units_count   = NULLIF($5,'')::int,
                    land_area           = NULLIF($6,'')::numeric,
                    land_area_unit      = NULLIF($7,''),
                    location_advantages = $8::text[],
                    price_list_note     = NULLIF($9,''),
                    rera_number         = NULLIF($10,'')
                 WHERE project_id = $11 AND deleted_at IS NULL`,
                [cfg.about, cfg.possession_date, cfg.launch_date, cfg.total_towers,
                 cfg.total_units_count, cfg.land_area, cfg.land_area_unit,
                 locationAdvantages.length ? locationAdvantages : null,
                 cfg.price_list_note, cfg.rera_number, propertyId]
            );
            // 021 Dhyaan sheet fields + category (same savepoint)
            await client.query(sheetUpdateSql(), sheetParams(buildSheetData(body), propertyId));
            // 024/025 structured: property_type (array) + budget_ranges (052) + available units (replace-all)
            const _pt = parsePropTypes(body);
            await client.query(`UPDATE private.projects SET property_type = $1::text[] WHERE project_id = $2`,
                [_pt.length ? _pt : null, propertyId]);
            // 058: per-category Property Type "Other" free-text (companion, never in the array)
            await client.query(
                `UPDATE private.projects SET property_type_other_res = $1, property_type_other_com = $2 WHERE project_id = $3`,
                [sheet.parseTypeOther(body, 'res', _sheetChk), sheet.parseTypeOther(body, 'com', _sheetChk), propertyId]);
            const _br = parseBudgetRanges(body);
            await client.query(`UPDATE private.projects SET budget_ranges = $1::text[] WHERE project_id = $2`,
                [_br.length ? _br : null, propertyId]);
            await client.query(`UPDATE private.projects SET budget_other = $1 WHERE project_id = $2`,
                [parseBudgetOther(body, _br), propertyId]);
            const _st = parseStatuses(body);
            await client.query(`UPDATE private.projects SET status_of_property = $1::text[] WHERE project_id = $2`,
                [_st.length ? _st : null, propertyId]);
            for (const sd of SIDES) await saveUnits(client, propertyId, sd.key, parseUnits(body, sd.key));
            // amenities: replace the set
            await client.query('DELETE FROM private.project_amenities WHERE project_id = $1', [propertyId]);
            if (amenityIds.length) {
                const vals = amenityIds.map((_, i) => `($1, $${i + 2})`).join(', ');
                await client.query(
                    `INSERT INTO private.project_amenities (project_id, amenity_id)
                     VALUES ${vals} ON CONFLICT DO NOTHING`,
                    [propertyId, ...amenityIds]
                );
            }
        } catch (cfgErr) {
            await client.query('ROLLBACK TO SAVEPOINT before_config');
            console.warn('[properties/edit] 019 config fields skipped:', cfgErr.message);
        }

        await client.query('COMMIT');

        // Audit log (best-effort)
        try {
            await logFromRequest(req, {
                entityType: 'property',
                entityId: updated.external_id,
                action: 'update',
                fieldName: null,
                oldValue: null,
                newValue: updated.title,
                notes: `${user.name} edited property "${updated.title}"`,
            });
        } catch (logErr) {
            console.warn('[properties/edit] audit log failed (non-fatal):', logErr.message);
        }

        let msg = `Property "${updated.title}" updated successfully.`;
        if (firstError) {
            msg += ' (Note: status, type and price were skipped due to a formatting issue — re-enter them and save again.)';
        }
        req.session.propertyEditFlash = { type: 'success', text: msg };
        return res.redirect(`${propsBaseFor(user)}/${propertyId}`);

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[properties/edit] update error:', err);
        req.session.propertyEditFlash = {
            type: 'error',
            text: userSafeError(err, 'Could not update the project. Please check your entries and try again.')
        };
        return res.redirect(`/projects/${propertyId}/edit`);
    } finally {
        client.release();
    }
});

module.exports = router;
