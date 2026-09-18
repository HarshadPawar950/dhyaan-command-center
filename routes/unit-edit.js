// =============================================================
// routes/unit-edit.js
// Edit Property — SINGULAR standalone listing (migration 026 sheet).
//
// Routes:
//   GET  /properties/:id/edit   → pre-filled sheet form (+ media manager)
//   POST /properties/:id/edit   → UPDATE the standalone property
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAuthenticated } = require('../middleware/auth');
const { logFromRequest } = require('../middleware/historyLogger');
const { ensurePermission } = require('../middleware/permissions');
const { ensureAdminOrRole } = require('../middleware/ensureAdminOrRole');
const { buildUnitData, validateUnit, UNIT_UPDATE_SQL, unitUpdateParams } = require('../lib/unitForm');
const sheet = require('../lib/propertySheet');
const { amenitiesMaster } = require('../lib/projectExtras');
const { unitsBaseFor } = require('../lib/propsNav');

const propsManageGate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canSeeOwner(u) {
    return !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'
        || (Array.isArray(u.navPerms) && u.navPerms.indexOf('properties.manage') !== -1));
}

async function safe(sql, params = [], fallback = []) {
    try { const r = await pool.query(sql, params); return r.rows; }
    catch (err) { console.error('[units/edit] query failed:', err.message); return fallback; }
}

// =============================================================
// GET /properties/:id/edit — show pre-filled sheet form
// =============================================================
router.get('/:id/edit', ensureAuthenticated, propsManageGate, async (req, res) => {
    const unitId = req.params.id;
    if (!UUID_RE.test(unitId)) return res.status(404).render('404', { pageTitle: 'Not Found' });

    const rows = await safe(
        `SELECT property_id, project_id,
                COALESCE(title,'')                AS title,
                category::text                    AS category,
                COALESCE(listing_sale,true)       AS listing_sale,
                COALESCE(listing_rent,false)      AS listing_rent,
                COALESCE(owner_name,'')           AS owner_name,
                COALESCE(owner_phone,'')          AS owner_phone,
                COALESCE(owner_email,'')          AS owner_email,
                COALESCE(owner_notes,'')          AS owner_notes,
                COALESCE(micro_market,'')         AS micro_market,
                COALESCE(locality,'')             AS locality,
                COALESCE(pincode,'')              AS pincode,
                COALESCE(address_details,'')      AS address_details,
                COALESCE(status_of_property,'')   AS status_of_property,
                COALESCE(possession,'')           AS possession,
                COALESCE(property_structure,'')   AS property_structure,
                COALESCE(property_type,'')        AS property_type,
                COALESCE(unit_no,'')              AS unit_no,
                carpet_area, sellable_area, COALESCE(area_unit,'sqft') AS area_unit,
                floor_number, total_floors,
                COALESCE(unit_condition,'')       AS unit_condition,
                facing::text                      AS facing,
                furnishing::text                  AS furnishing,
                COALESCE(vastu,'')                AS vastu,
                COALESCE(config,'')               AS config,
                COALESCE(pantry,'')               AS pantry,
                expected_price, price_per_sqft,
                COALESCE(roi_rental_note,'')      AS roi_rental_note,
                COALESCE(payment_plan,'')         AS payment_plan,
                price_negotiable,
                ownership_type::text              AS ownership_type,
                COALESCE(documents_received,'')   AS documents_received,
                COALESCE(rera_number,'')          AS rera_number,
                COALESCE(amenities,'{}')          AS amenities,
                COALESCE(view_note,'')            AS view_note,
                balconies,
                COALESCE(lift_availability,'')    AS lift_availability,
                parking_available, COALESCE(parking_type,'') AS parking_type, parking_count,
                COALESCE(connectivity,'')         AS connectivity,
                COALESCE(nearby_infrastructure,'') AS nearby_infrastructure,
                COALESCE(suitable_for,'')         AS suitable_for,
                COALESCE(highlights,'')           AS highlights,
                COALESCE(why_choose_this,'')      AS why_choose_this,
                COALESCE(about,'')                AS about,
                COALESCE(google_maps_url,'')      AS google_maps_url,
                latitude, longitude
           FROM private.properties
          WHERE property_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [unitId], []
    );
    if (rows.length === 0) return res.status(404).render('404', { pageTitle: 'Property Not Found' });
    const u = rows[0];

    const _n = v => (v === null || v === undefined) ? '' : String(v);
    const formData = {
        title: u.title, category: u.category || '',
        listing_sale: !!u.listing_sale, listing_rent: !!u.listing_rent,
        owner_name: u.owner_name, owner_phone: u.owner_phone, owner_email: u.owner_email, owner_notes: u.owner_notes,
        micro_market: u.micro_market, locality: u.locality, pincode: u.pincode,
        address_details: u.address_details,
        status_of_property: u.status_of_property, possession: u.possession,
        property_structure: u.property_structure, property_type: u.property_type,
        unit_no: u.unit_no, carpet_area: _n(u.carpet_area), sellable_area: _n(u.sellable_area), area_unit: u.area_unit || 'sqft',
        floor_number: _n(u.floor_number), total_floors: _n(u.total_floors),
        unit_condition: u.unit_condition, facing: u.facing || '', furnishing: u.furnishing || '',
        vastu: u.vastu, config: u.config, pantry: u.pantry,
        expected_price: _n(u.expected_price), price_per_sqft: _n(u.price_per_sqft),
        roi_rental_note: u.roi_rental_note,
        payment_plan: u.payment_plan, price_negotiable: !!u.price_negotiable,
        ownership_type: u.ownership_type || '', documents_received: u.documents_received, rera_number: u.rera_number,
        view_note: u.view_note, balconies: _n(u.balconies), lift_availability: u.lift_availability,
        parking_available: (u.parking_available === true || u.parking_available === false) ? u.parking_available : undefined,
        parking_type: u.parking_type || '', parking_count: _n(u.parking_count),
        connectivity: u.connectivity, nearby_infrastructure: u.nearby_infrastructure,
        suitable_for: u.suitable_for, highlights: u.highlights, why_choose_this: u.why_choose_this,
        about: u.about, google_maps_url: u.google_maps_url, latitude: _n(u.latitude), longitude: _n(u.longitude),
    };
    const selectedAmen = Array.isArray(u.amenities) ? u.amenities : [];

    const amen = await amenitiesMaster();
    const media = await safe(
        `SELECT image_id, file_path, COALESCE(media_type,'photo') AS media_type
           FROM private.property_images
          WHERE property_id = $1 AND deleted_at IS NULL
       ORDER BY sort_order, created_at`, [unitId], []);

    res.render('unit-edit', {
        pageTitle: 'Edit Property — ' + (u.title || ''),
        user: req.session.user,
        unitId: u.property_id,
        propertyId: u.project_id,
        sheet,
        isEdit: true,
        amenityGroups: amen.byCategory,
        selectedAmen,
        canSeeOwnerInternal: canSeeOwner(req.session.user),
        images: media.filter(m => m.media_type === 'photo'),
        videos: media.filter(m => m.media_type === 'video'),
        floorPlans: media.filter(m => m.media_type === 'floor_plan'),
        flash: req.session.unitFlash || req.session.propertyEditFlash || null,
        formData,
        csrfToken: req.csrfToken(),
    });

    req.session.unitFlash = null;
    req.session.propertyEditFlash = null;
});

// =============================================================
// POST /properties/:id/edit — update the standalone property
// =============================================================
router.post('/:id/edit', ensureAuthenticated, propsManageGate, async (req, res) => {
    const user = req.session.user;
    const unitId = req.params.id;
    const body = req.body || {};
    if (!UUID_RE.test(unitId)) return res.status(404).render('404', { pageTitle: 'Not Found' });

    const d = buildUnitData(body);
    const errors = validateUnit(d);
    if (errors.length > 0) {
        req.session.unitFlash = { type: 'error', text: errors.join(' ') };
        return res.redirect(`/properties/${unitId}/edit`);
    }

    // BUG A fix (027): NO silent partial-save fallback. The edit either fully
    // succeeds or it fails loudly — never a green "updated successfully" while
    // detailed fields were quietly dropped. The row already exists, so there is
    // nothing to salvage; an error rolls the whole update back and is shown.
    const client = await pool.connect();
    let result;
    try {
        await client.query('BEGIN');
        result = await client.query(UNIT_UPDATE_SQL, unitUpdateParams(d, unitId));

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            req.session.unitFlash = { type: 'error', text: 'Property not found or already deleted.' };
            return res.redirect(unitsBaseFor(user));
        }
        await client.query('COMMIT');
        const updated = result.rows[0];

        try {
            await logFromRequest(req, {
                entityType: 'property_unit',
                entityId: updated.property_id,
                action: 'update',
                newValue: updated.title,
                notes: `${user.name} edited property "${updated.title || updated.config}"`,
            });
        } catch (logErr) { console.warn('[units/edit] audit log failed:', logErr.message); }

        req.session.unitFlash = { type: 'success', text: `Property "${updated.title || updated.config}" updated successfully.` };
        return res.redirect(`/properties/${updated.property_id}`);

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[units/edit] update error:', err);
        req.session.unitFlash = { type: 'error', text: userSafeError(err, 'Could not update the property — no changes were saved. Please try again.') };
        return res.redirect(`/properties/${unitId}/edit`);
    } finally {
        client.release();
    }
});

module.exports = router;
