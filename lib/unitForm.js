// =============================================================
// lib/unitForm.js — shared parse + SQL for the SINGULAR property sheet.
// ONE column spec drives both the INSERT (unit-new) and UPDATE (unit-edit) so
// the two never drift. Rebuilt for migration 026: manages exactly the columns
// the sheet form surfaces. price_per_sqft is auto-computed from
// expected_price / carpet_area (the ONE area) on every save.
//
// Legacy columns (carpet_sqft, price_text, price_lakhs, notes, builtup_area,
// super_builtup_area, bathrooms, additional_rooms, overlooking, furnishing_items,
// property_age_years, possession_status, available_from) are intentionally NOT
// in COLS — they are never written, so existing data on the 1 live row is
// preserved untouched rather than nulled by the new form.
// =============================================================

const { STATUS_VALUES, TYPE_OPTIONS } = require('./projectSheet');
// 027: properties add a "pre_lease" status on top of the shared project statuses.
const PROPERTY_STATUS_VALUES = STATUS_VALUES.concat(['pre_lease']);

// Option lists (also used to render the <select> groups + propertySheet).
const FACING = ['north', 'south', 'east', 'west', 'north_east', 'north_west', 'south_east', 'south_west'];
const FURNISHING = ['unfurnished', 'semi_furnished', 'furnished'];
const OWNERSHIP = ['freehold', 'leasehold', 'co_operative_society', 'power_of_attorney'];
// Kept exported for legacy imports (no longer surfaced on the sheet form).
const POSSESSION = ['pre_launch', 'under_construction', 'ready_to_move', 'completed'];
const ADDITIONAL_ROOMS = ['servant', 'study', 'pooja', 'store'];
const OVERLOOKING = ['garden', 'road', 'pool', 'club'];

const CATEGORY_VALUES = ['residential', 'commercial'];

function asArray(v) { return Array.isArray(v) ? v : (v || v === 0 ? [v] : []); }

function buildUnitData(body) {
    const b = body || {};
    const s = k => (b[k] === undefined || b[k] === null ? '' : String(b[k])).trim();

    const expected_price = s('expected_price');
    const carpet_area   = s('carpet_area');       // 027: the TRUE carpet area
    const sellable_area = s('sellable_area');      // 027: the primary "Sellable Area"
    // ₹/sqft is computed off the primary SELLABLE area (fall back to carpet if blank).
    let price_per_sqft = '';
    const ep = parseFloat(expected_price);
    const areaForPsf = !isNaN(parseFloat(sellable_area)) ? parseFloat(sellable_area) : parseFloat(carpet_area);
    if (!isNaN(ep) && !isNaN(areaForPsf) && areaForPsf > 0) price_per_sqft = String(Math.round(ep / areaForPsf));

    // Amenities: checkbox group of names -> clean text[] (dedup, drop empties).
    const amenities = [...new Set(asArray(b.amenities).map(x => String(x).trim()).filter(Boolean))];
    const neg = b.price_negotiable;

    // Listing type (027): Sell / Rent — both tickable (booleans).
    const truthy = v => (v === 'on' || v === 'true' || v === true || v === '1');
    const listing_sale = truthy(b.listing_sale);
    const listing_rent = truthy(b.listing_rent);

    // Parking (027): Yes/No -> type + count; NO clears the detail fields.
    const pav = String(b.parking_available || '').toLowerCase();
    const parking_available = (pav === 'yes' || pav === 'true' || pav === 'on' || pav === '1') ? true
                            : (pav === 'no' || pav === 'false' || pav === '0') ? false : null;
    const parking_type  = parking_available ? s('parking_type') : '';
    const parking_count = parking_available ? s('parking_count') : '';

    return {
        // G1
        title: s('title'), category: s('category'),
        listing_sale, listing_rent,                              // 027 (1.5)
        owner_name: s('owner_name'), owner_phone: s('owner_phone'),
        owner_email: s('owner_email'), owner_notes: s('owner_notes'),
        micro_market: s('micro_market'), locality: s('locality'), pincode: s('pincode'),
        address_details: s('address_details'),                   // 027 (1.3)
        // G2
        status_of_property: s('status_of_property'), possession: s('possession'),
        property_structure: s('property_structure'), property_type: s('property_type'),
        // G3
        unit_no: s('unit_no'), carpet_area, sellable_area, area_unit: s('area_unit') || 'sqft',
        floor_number: s('floor_number'), total_floors: s('total_floors'),
        unit_condition: s('unit_condition'), facing: s('facing'), furnishing: s('furnishing'),
        vastu: s('vastu'), config: s('config'), pantry: s('pantry'),
        // G4
        expected_price, price_per_sqft,
        roi_rental_note: s('roi_rental_note'),                   // 027 (1.6)
        payment_plan: s('payment_plan'),
        price_negotiable: (neg === 'on' || neg === 'true' || neg === true || neg === '1'),
        ownership_type: s('ownership_type'),
        documents_received: s('documents_received'), rera_number: s('rera_number'),
        // G5
        amenities: amenities.length ? amenities : null,
        view_note: s('view_note'), balconies: s('balconies'),
        lift_availability: s('lift_availability'),
        parking_available, parking_type, parking_count,          // 027 (1.7)
        // G6
        connectivity: s('connectivity'), nearby_infrastructure: s('nearby_infrastructure'),
        suitable_for: s('suitable_for'), highlights: s('highlights'),
        why_choose_this: s('why_choose_this'), about: s('about'),
        google_maps_url: s('google_maps_url'), latitude: s('latitude'), longitude: s('longitude'),
    };
}

// Shared validation — required + choice-set checks. Returns string[] of errors.
function validateUnit(d) {
    const errors = [];
    if (!d.title || d.title.length < 2) errors.push('Property title is required (at least 2 characters).');
    if (!d.category) errors.push('Category (Residential or Commercial) is required.');
    else if (CATEGORY_VALUES.indexOf(d.category) === -1) errors.push('Invalid category.');
    if (!d.property_type) errors.push('Property Type is required.');
    else if (d.category && CATEGORY_VALUES.indexOf(d.category) !== -1) {
        const allowed = d.category === 'residential' ? TYPE_OPTIONS.res : TYPE_OPTIONS.com;
        if (allowed.indexOf(d.property_type) === -1) errors.push('Property Type does not match the selected category.');
    }
    if (!d.expected_price) errors.push('Expected price is required.');
    if (d.status_of_property && PROPERTY_STATUS_VALUES.indexOf(d.status_of_property) === -1) errors.push('Invalid Status of Property.');
    return errors;
}

// column | placeholder builder | value getter — the single source of truth.
const NUM = i => `NULLIF($${i},'')::numeric`;
const INT = i => `NULLIF($${i},'')::int`;
const TXT = i => `NULLIF($${i},'')`;
const COLS = [
    // G1
    { c: 'title',              ph: TXT, v: d => d.title },
    { c: 'category',           ph: i => `NULLIF($${i},'')::private.property_category`, v: d => d.category },
    { c: 'listing_sale',       ph: i => `$${i}::boolean`, v: d => d.listing_sale },
    { c: 'listing_rent',       ph: i => `$${i}::boolean`, v: d => d.listing_rent },
    { c: 'owner_name',         ph: TXT, v: d => d.owner_name },
    { c: 'owner_phone',        ph: TXT, v: d => d.owner_phone },
    { c: 'owner_email',        ph: TXT, v: d => d.owner_email },
    { c: 'owner_notes',        ph: TXT, v: d => d.owner_notes },
    { c: 'micro_market',       ph: TXT, v: d => d.micro_market },
    { c: 'locality',           ph: TXT, v: d => d.locality },
    { c: 'pincode',            ph: TXT, v: d => d.pincode },
    { c: 'address_details',    ph: TXT, v: d => d.address_details },
    // G2
    { c: 'status_of_property', ph: TXT, v: d => d.status_of_property },
    { c: 'possession',         ph: TXT, v: d => d.possession },
    { c: 'property_structure', ph: TXT, v: d => d.property_structure },
    { c: 'property_type',      ph: TXT, v: d => d.property_type },
    // G3
    { c: 'unit_no',            ph: TXT, v: d => d.unit_no },
    { c: 'carpet_area',        ph: NUM, v: d => d.carpet_area },
    { c: 'sellable_area',      ph: NUM, v: d => d.sellable_area },
    { c: 'area_unit',          ph: TXT, v: d => d.area_unit },
    { c: 'floor_number',       ph: INT, v: d => d.floor_number },
    { c: 'total_floors',       ph: INT, v: d => d.total_floors },
    { c: 'unit_condition',     ph: TXT, v: d => d.unit_condition },
    { c: 'facing',             ph: i => `NULLIF($${i},'')::private.facing_direction`,  v: d => d.facing },
    { c: 'furnishing',         ph: i => `NULLIF($${i},'')::private.furnishing_status`, v: d => d.furnishing },
    { c: 'vastu',              ph: TXT, v: d => d.vastu },
    { c: 'config',             ph: i => `$${i}`, v: d => d.config },
    { c: 'pantry',             ph: TXT, v: d => d.pantry },
    // G4
    { c: 'expected_price',     ph: NUM, v: d => d.expected_price },
    { c: 'price_per_sqft',     ph: NUM, v: d => d.price_per_sqft },
    { c: 'roi_rental_note',    ph: TXT, v: d => d.roi_rental_note },
    { c: 'payment_plan',       ph: TXT, v: d => d.payment_plan },
    { c: 'price_negotiable',   ph: i => `$${i}::boolean`, v: d => d.price_negotiable },
    { c: 'ownership_type',     ph: i => `NULLIF($${i},'')::private.ownership_type`, v: d => d.ownership_type },
    { c: 'documents_received', ph: TXT, v: d => d.documents_received },
    { c: 'rera_number',        ph: TXT, v: d => d.rera_number },
    // G5
    { c: 'amenities',          ph: i => `$${i}::text[]`, v: d => d.amenities },
    { c: 'view_note',          ph: TXT, v: d => d.view_note },
    { c: 'balconies',          ph: INT, v: d => d.balconies },
    { c: 'lift_availability',  ph: TXT, v: d => d.lift_availability },
    { c: 'parking_available',  ph: i => `$${i}::boolean`, v: d => d.parking_available },
    { c: 'parking_type',       ph: TXT, v: d => d.parking_type },
    { c: 'parking_count',      ph: INT, v: d => d.parking_count },
    // G6
    { c: 'connectivity',          ph: TXT, v: d => d.connectivity },
    { c: 'nearby_infrastructure', ph: TXT, v: d => d.nearby_infrastructure },
    { c: 'suitable_for',          ph: TXT, v: d => d.suitable_for },
    { c: 'highlights',            ph: TXT, v: d => d.highlights },
    { c: 'why_choose_this',       ph: TXT, v: d => d.why_choose_this },
    { c: 'about',                 ph: TXT, v: d => d.about },
    { c: 'google_maps_url',       ph: TXT, v: d => d.google_maps_url },
    { c: 'latitude',              ph: NUM, v: d => d.latitude },
    { c: 'longitude',             ph: NUM, v: d => d.longitude },
];

// UPDATE: params = [...COLS values, unitId]
const UNIT_UPDATE_SQL =
    `UPDATE private.properties SET ${COLS.map((col, idx) => `${col.c} = ${col.ph(idx + 1)}`).join(', ')}
      WHERE property_id = $${COLS.length + 1} AND deleted_at IS NULL
      RETURNING property_id, project_id, title, config`;
function unitUpdateParams(d, unitId) { return COLS.map(col => col.v(d)).concat([unitId]); }

// INSERT: project_id is $1, then the COLS shifted by 1. params = [projectId, ...COLS values]
const UNIT_INSERT_SQL =
    `INSERT INTO private.properties (project_id, ${COLS.map(c => c.c).join(', ')})
     VALUES ($1, ${COLS.map((col, idx) => col.ph(idx + 2)).join(', ')})
     RETURNING property_id, title, config`;
function unitInsertParams(d, projectId) { return [projectId].concat(COLS.map(col => col.v(d))); }

module.exports = {
    buildUnitData, validateUnit, UNIT_UPDATE_SQL, unitUpdateParams, UNIT_INSERT_SQL, unitInsertParams,
    FACING, FURNISHING, OWNERSHIP, POSSESSION, ADDITIONAL_ROOMS, OVERLOOKING, CATEGORY_VALUES,
};
