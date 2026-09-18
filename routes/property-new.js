// =============================================================
// routes/property-new.js
// Add New Property — for employees (and admin)
//
// Routes:
//   GET  /projects/new       → show beautiful form
//   POST /projects/new       → create new property
//
// DAY 5 FIX: SAVEPOINT pattern.
// Previous version threw "current transaction is aborted" because
// when the first INSERT failed (likely enum cast on
// construction_status/type or numeric cast on price), the entire
// PostgreSQL transaction got poisoned. SAVEPOINT lets us rollback
// ONLY the failed INSERT, keeping the transaction alive for the
// fallback INSERT to succeed.
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
const sheet = require('../lib/projectSheet');
const { buildSheetData, sheetUpdateSql, sheetParams, SIDES, STATUS_VALUES, STATUS_VALUE_SET, BUDGET_BUCKET_KEYS } = sheet;
const { parseUnits, saveUnits } = require('../lib/availableUnits');
const { userSafeError } = require('../lib/safeDbError');
// property_type checkbox group -> clean text[] (dedup, drop empties)
function parsePropTypes(body) {
    const v = (body && body.property_type) || [];
    const arr = (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(Boolean);
    return [...new Set(arr)];
}
// budget_ranges checkbox group -> clean text[] (dedup, drop empties, whitelist to known bucket keys)
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
// status_of_property checkbox group -> clean text[] (dedup, whitelist to known status slugs) — 053
function parseStatuses(body) {
    const v = (body && body.status_of_property) || [];
    const arr = (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(k => STATUS_VALUE_SET.has(k));
    return [...new Set(arr)];
}

// D4 fix: creating catalog rows is a manager action — same gate as /admin/projects
// and the media upload routes. Blocks plain-employee mutation of the inventory.
const propsManageGate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[properties/new] query failed:', err.message);
        return fallback;
    }
}

async function nextPropertyCode(client) {
    // Atomic, collision-proof code allocation via a dedicated sequence
    // (migration 056: private.project_code_seq, START 2000).
    //
    // The old generator did MAX(digits of external_id)::bigint + 1, but pg returns
    // bigint as a STRING so `(max || 0) + 1` CONCATENATED — every create appended a
    // '1', growing an all-1s repunit code (PROJ001, PROJ011, PROJ111 …) until the
    // 20th overflowed bigint and blocked all creation. nextval() sidesteps that
    // entirely: it's atomic (concurrency-safe — two creates can never get the same
    // number) and never reads the poisoned external_id column. ::text so we
    // CONCATENATE the value (no arithmetic → no repeat of the string-concat bug).
    //
    // Seed 2000 sits in the repunit-free corridor (1111 < 2000 < 11111), so
    // PROJ2000..PROJ11110 are 9,111 collision-free codes. The existence-check retry
    // is a belt-and-suspenders backstop that skips any code already taken.
    for (let attempt = 0; attempt < 50; attempt++) {
        const r = await client.query(`SELECT nextval('private.project_code_seq')::text AS n`);
        const code = 'PROJ' + r.rows[0].n;
        const hit = await client.query(
            `SELECT 1 FROM private.projects WHERE external_id = $1 LIMIT 1`, [code]);
        if (hit.rowCount === 0) return code;
    }
    throw new Error('Could not allocate a unique project code after 50 attempts');
}

// =============================================================
// GET /projects/new — show the form
// =============================================================
router.get('/new', ensureAuthenticated, propsManageGate, async (req, res) => {

    const builders = await safe(
        `SELECT DISTINCT builder FROM private.projects
          WHERE builder IS NOT NULL AND builder <> ''
       ORDER BY builder`,
        [], []
    );

    const areas = await safe(
        `SELECT DISTINCT area_zone FROM private.projects
          WHERE area_zone IS NOT NULL AND area_zone <> ''
       ORDER BY area_zone`,
        [], []
    );

    const tiers = await safe(
        `SELECT DISTINCT tier FROM private.projects
          WHERE tier IS NOT NULL AND tier <> ''
       ORDER BY tier`,
        [], []
    );

    const statuses = await safe(
        `SELECT DISTINCT construction_status::text AS s FROM private.projects
          WHERE construction_status IS NOT NULL
       ORDER BY s`,
        [], []
    );

    const types = await safe(
        `SELECT DISTINCT type::text AS t FROM private.projects
          WHERE type IS NOT NULL
       ORDER BY t`,
        [], []
    );

    res.render('property-new', {
        pageTitle: 'Add New Project',
        user: req.session.user,
        builders: builders.map(r => r.builder).filter(Boolean),
        areas: areas.map(r => r.area_zone).filter(Boolean),
        tiers: tiers.map(r => r.tier).filter(Boolean),
        statuses: statuses.map(r => r.s).filter(Boolean),
        types: types.map(r => r.t).filter(Boolean),
        bhkOptions: BHK_OPTIONS,
        flash: req.session.propertyNewFlash || null,
        formData: req.session.propertyNewFormData || {},
        csrfToken: req.csrfToken(),
        sheet,
        canSeeMarketing: (u => !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'))(req.session.user),
    });

    req.session.propertyNewFlash = null;
    req.session.propertyNewFormData = null;
});

// =============================================================
// POST /projects/new — create the property
// =============================================================
router.post('/new', ensureAuthenticated, propsManageGate, async (req, res) => {
    const user = req.session.user;
    const body = req.body || {};

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

    // Sheet-mirror: the form has no free "Location" — derive it from Locality
    // so the required-location check + the map keep working.
    if (!data.location) data.location = (body.locality || '').trim();

    // -------- VALIDATION --------
    const errors = [];
    if (!data.title || data.title.length < 2) {
        errors.push('Project title is required (at least 2 characters).');
    }
    if (!data.location) {
        errors.push('Locality is required (it also fills Location).');
    }
    const _sheet = buildSheetData(body);
    const _propTypes = parsePropTypes(body);
    // 058: per-category Property Type "Other" free-text (NULL when the side is off or
    // its Other checkbox is unticked). NEVER merged into _propTypes/property_type[].
    const _typeOtherRes = sheet.parseTypeOther(body, 'res', _sheet);
    const _typeOtherCom = sheet.parseTypeOther(body, 'com', _sheet);
    const _budgets = parseBudgetRanges(body);
    const _budgetOther = parseBudgetOther(body, _budgets);
    const _statuses = parseStatuses(body);
    // construction_status is NOT a form field — derive the single NOT-NULL enum from
    // the status_of_property[] tags. Empty tags → column default 'pre_launch'. Without
    // this the main INSERT sent NULL → NOT NULL violation → savepoint fallback that also
    // silently dropped price + type.
    data.construction_status = sheet.deriveConstructionStatus(_statuses) || 'pre_launch';
    if (!_sheet.has_residential && !_sheet.has_commercial) errors.push('Select at least one category (Residential and/or Commercial).');
    if (!_sheet.locality) errors.push('Locality is required.');
    // Reject out-of-range / non-numeric figures IN THE FORM (named per field),
    // so an oversized number never reaches Postgres and surfaces as a raw error.
    errors.push(...sheet.validateNumbers(body));
    // 053: status_of_property is a multi-select text[]; parseStatuses whitelists to
    // the known slugs (empty allowed) — no extra validation needed.
    const mapCheck = validateGoogleMapsUrl(data.google_maps_url);
    if (!mapCheck.ok) errors.push(mapCheck.reason);
    const coordCheck = validateCoords(data.latitude, data.longitude);
    if (!coordCheck.ok) errors.push(coordCheck.reason);

    if (errors.length > 0) {
        req.session.propertyNewFlash = { type: 'error', text: errors.join(' ') };
        req.session.propertyNewFormData = Object.assign({}, data, _sheet, { property_type: _propTypes, budget_ranges: _budgets, budget_other: _budgetOther || '', status_of_property: _statuses, property_type_other_res: _typeOtherRes || '', property_type_other_com: _typeOtherCom || '' });
        return res.redirect('/projects/new');
    }

    // Duplicate check (light protection)
    const dup = await safe(
        `SELECT project_id, title FROM private.projects
          WHERE LOWER(title) = LOWER($1) AND LOWER(COALESCE(location, '')) = LOWER($2)
          LIMIT 1`,
        [data.title, data.location],
        []
    );
    if (dup.length > 0) {
        req.session.propertyNewFlash = {
            type: 'error',
            text: `A property "${dup[0].title}" already exists at ${data.location}. Use a different title or location.`
        };
        req.session.propertyNewFormData = data;
        return res.redirect('/projects/new');
    }

    // -------- INSERT IN TRANSACTION WITH SAVEPOINT --------
    const client = await pool.connect();
    let firstInsertError = null;
    try {
        await client.query('BEGIN');

        const propCode = await nextPropertyCode(client);

        let insertResult;

        // SAVEPOINT so failed INSERT doesn't abort the whole transaction
        await client.query('SAVEPOINT before_insert');

        try {
            insertResult = await client.query(
                `INSERT INTO private.projects
                    (external_id, title, location, builder, area_zone, tier,
                     possession, configurations, price_range,
                     construction_status, type, price, notes, google_maps_url,
                     bhk_config, latitude, longitude, has_residential, has_commercial, listed_at)
                 VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
                         NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
                         NULLIF($10, '')::private.property_status,
                         NULLIF($11, '')::private.requirement_type,
                         NULLIF($12, '')::numeric, NULLIF($13, ''), NULLIF($14, ''),
                         $15::text[], NULLIF($16, '')::numeric, NULLIF($17, '')::numeric, $18, $19, NOW())
                 RETURNING project_id, external_id, title`,
                [
                    propCode, data.title, data.location, data.builder, data.area_zone,
                    data.tier, data.possession, data.configurations, data.price_range,
                    data.construction_status, data.type, data.price, data.notes,
                    data.google_maps_url,
                    data.bhk_config.length ? data.bhk_config : null,
                    data.latitude, data.longitude,
                    _sheet.has_residential, _sheet.has_commercial,
                ]
            );
        } catch (err) {
            firstInsertError = err.message;
            console.warn('[properties/new] full INSERT failed, rolling back to savepoint:', err.message);

            // Rollback to savepoint — transaction stays alive
            await client.query('ROLLBACK TO SAVEPOINT before_insert');

            // Fallback: insert without enum/numeric columns (typical culprits).
            // bhk_config (text[]) is safe to keep; lat/long numerics are dropped
            // here just like price, and can be re-added via edit.
            insertResult = await client.query(
                `INSERT INTO private.projects
                    (external_id, title, location, builder, area_zone, tier,
                     possession, configurations, price_range, notes, google_maps_url,
                     bhk_config, has_residential, has_commercial, listed_at)
                 VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
                         NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
                         NULLIF($10, ''), NULLIF($11, ''), $12::text[], $13, $14, NOW())
                 RETURNING project_id, external_id, title`,
                [
                    propCode, data.title, data.location, data.builder, data.area_zone,
                    data.tier, data.possession, data.configurations, data.price_range,
                    data.notes, data.google_maps_url,
                    data.bhk_config.length ? data.bhk_config : null,
                    _sheet.has_residential, _sheet.has_commercial,
                ]
            );
        }

        const newProp = insertResult.rows[0];

        // 021 Dhyaan sheet fields + category (isolated savepoint — best-effort)
        try {
            await client.query('SAVEPOINT before_sheet');
            await client.query(sheetUpdateSql(), sheetParams(_sheet, newProp.project_id));
        } catch (sheetErr) {
            await client.query('ROLLBACK TO SAVEPOINT before_sheet');
            console.warn('[properties/new] sheet fields skipped:', sheetErr.message);
        }

        // 024/025 structured fields — property_type (array) + budget_ranges (052) + available units (best-effort)
        try {
            await client.query('SAVEPOINT before_structured');
            await client.query(
                `UPDATE private.projects SET property_type = $1::text[] WHERE project_id = $2`,
                [_propTypes.length ? _propTypes : null, newProp.project_id]);
            // 058: per-category Property Type "Other" free-text (companion, not in the array)
            await client.query(
                `UPDATE private.projects SET property_type_other_res = $1, property_type_other_com = $2 WHERE project_id = $3`,
                [_typeOtherRes, _typeOtherCom, newProp.project_id]);
            await client.query(
                `UPDATE private.projects SET budget_ranges = $1::text[] WHERE project_id = $2`,
                [_budgets.length ? _budgets : null, newProp.project_id]);
            await client.query(
                `UPDATE private.projects SET budget_other = $1 WHERE project_id = $2`,
                [_budgetOther, newProp.project_id]);
            await client.query(
                `UPDATE private.projects SET status_of_property = $1::text[] WHERE project_id = $2`,
                [_statuses.length ? _statuses : null, newProp.project_id]);
            for (const sd of SIDES) await saveUnits(client, newProp.project_id, sd.key, parseUnits(body, sd.key));
        } catch (structErr) {
            await client.query('ROLLBACK TO SAVEPOINT before_structured');
            console.warn('[properties/new] structured fields skipped:', structErr.message);
        }

        await client.query('COMMIT');

        // Audit log (best-effort, don't fail if logger errors)
        try {
            await logFromRequest(req, {
                entityType: 'property',
                entityId: newProp.external_id,
                action: 'create',
                fieldName: null,
                oldValue: null,
                newValue: newProp.title,
                notes: `${user.name} created new property "${newProp.title}" at ${data.location}`,
            });
        } catch (logErr) {
            console.warn('[properties/new] audit log failed (non-fatal):', logErr.message);
        }

        let successMsg = `Property "${newProp.title}" created successfully (${newProp.external_id}).`;
        if (firstInsertError) {
            successMsg += ' (Note: status, type and price were skipped due to a formatting issue — you can add them via Edit.)';
        }

        // Admin / property-manager add → return to the ADMIN properties list
        // (with sidebar + breadcrumb), mirroring the edit flow. Plain employees
        // who reach the shared form stay on the employee browse page.
        let canManage = false;
        try { canManage = await can(user, 'properties.manage', req); } catch (_) {}
        if (canManage) {
            req.session.propertiesListFlash = { type: 'success', text: successMsg };
            return res.redirect('/admin/projects');
        }
        req.session.propertyNewFlash = { type: 'success', text: successMsg };
        return res.redirect('/projects');

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[properties/new] insert error (final):', err);
        req.session.propertyNewFlash = {
            type: 'error',
            text: userSafeError(err, 'Could not create the project. Please check your entries and try again.')
        };
        req.session.propertyNewFormData = data;
        return res.redirect('/projects/new');
    } finally {
        client.release();
    }
});

module.exports = router;
