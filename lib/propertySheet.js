// =============================================================
// lib/propertySheet.js — the SINGULAR property sheet (migration 026).
// The one-unit / one-owner analog of lib/projectSheet.js. ONE ordered spec
// drives the property form (unit-new / unit-edit) and the read-only detail
// page (unit-detail) so the two never drift.
//
//   • Category is SINGLE-select (radio): a property is Residential OR Commercial.
//     The pick switches the Property Type list and reveals commercial-only fields.
//   • Groups render in sheet order G1→G6 (NO G7 marketing block — CAPTAIN ruling
//     2026-07-26: ad/marketing spend stays a project-level concern).
//   • Every field maps to a real private.properties column. `kind` tells the
//     form/detail how to render it; `commercial:true` = shown only when Commercial;
//     `gated:true` = owner-internal (email/notes), admin/super/HR only.
// =============================================================

const projectSheet = require('./projectSheet');
const { FACING, FURNISHING, OWNERSHIP } = require('./unitForm');

// Property status (027): the project statuses re-ordered per CAPTAIN's note,
// PLUS a property-only 5th option "Pre-Lease". status_of_property is a TEXT
// column, so this is a pure option-list change — no enum, no migration, and it
// does NOT touch the projects sheet (which keeps projectSheet.STATUS_OPTIONS).
const STATUS_OPTIONS = [
    { value: 'under_construction', label: 'Under Construction' },
    { value: 'ready_to_move',      label: 'Ready to Move' },
    { value: 'near_possession',    label: 'Near Possession' },
    { value: 'pre_launch',         label: 'Pre Launch' },
    { value: 'pre_lease',          label: 'Pre-Lease' },
];
const STATUS_VALUES = STATUS_OPTIONS.map(o => o.value);
function statusLabel(v) { const o = STATUS_OPTIONS.find(x => x.value === v); return o ? o.label : projectSheet.statusLabel(v); }

// Listing type (027): Sell / Rent — styled like the residential/commercial
// toggle, BOTH tickable. Stored as booleans listing_sale / listing_rent.
const LISTING_OPTIONS = [
    { name: 'listing_sale', label: 'Sell', icon: '🏷️' },
    { name: 'listing_rent', label: 'Rent', icon: '🔑' },
];
// property_type is SINGLE-select here; the option set switches by category.
const TYPE_BY_CATEGORY = {
    residential: projectSheet.TYPE_OPTIONS.res,   // 1 BHK … Penthouse
    commercial:  projectSheet.TYPE_OPTIONS.com,   // Office … Commercial Plot
};

const CATEGORIES = [
    { value: 'residential', label: 'Residential', icon: '🏠' },
    { value: 'commercial',  label: 'Commercial',  icon: '🏢' },
];

// f(name,label,kind,opts) — kind drives rendering (see the form partial).
function f(name, label, kind, opts) { return Object.assign({ name, label, kind: kind || 'text' }, opts || {}); }

// Ordered groups. Special kinds: 'status' (radio), 'type' (single-select by
// category), 'area' (one area + unit), 'select' (enum opts), 'bool', 'psf'
// (auto, read-only), 'amenities', 'map', 'media'.
const GROUPS = [
    { n: 1, key: 'basic', title: 'Basic & Location', fields: [
        f('title', 'Property Title', 'text', { required: true, full: true }),
        f('micro_market', 'Micro Market', 'text'),
        f('locality', 'Locality', 'text'),
        f('pincode', 'Pincode', 'text'),
        f('address_details', 'Address Details', 'textarea', { full: true }),   // 027 (1.3)
        // Owner block (name+phone public; email+notes gated)
        f('owner_name', 'Owner Name', 'text', { owner: true }),
        f('owner_phone', 'Owner Phone', 'text', { owner: true }),
        f('owner_email', 'Owner Email', 'text', { owner: true, gated: true }),
        f('owner_notes', 'Owner Notes', 'textarea', { owner: true, gated: true, full: true }),
    ] },
    { n: 2, key: 'status', title: 'Status & Structure', fields: [
        f('status_of_property', 'Status of Property', 'status'),
        f('possession', 'Possession', 'text'),
        f('property_structure', 'Property Structure', 'text'),
        f('property_type', 'Property Type', 'type', { required: true }),
    ] },
    { n: 3, key: 'unit', title: 'Unit Details', fields: [
        f('unit_no', 'Unit No', 'text'),
        f('sellable_area', 'Sellable Area', 'area'),                    // 027 (1.2) primary area (drives ₹/sqft)
        f('carpet_area', 'Carpet Area', 'carea'),                       // 027 (1.1) alongside the primary area
        f('floor_number', 'Floor Number', 'num'),
        f('total_floors', 'Total Floors', 'num'),
        f('unit_condition', 'Unit Condition', 'text'),
        f('facing', 'Facing', 'select', { opts: FACING }),
        f('furnishing', 'Furnishing', 'select', { opts: FURNISHING }),
        f('vastu', 'Vastu', 'text'),
        f('config', 'Office Configuration', 'text', { commercial: true }),
        f('pantry', 'Pantry', 'text', { commercial: true }),
    ] },
    { n: 4, key: 'pricing', title: 'Pricing & Legal', fields: [
        f('expected_price', 'Expected Price (₹)', 'num', { required: true }),
        f('price_per_sqft', 'Price / sq.ft (₹)', 'psf'),                // auto (₹ / Sellable Area)
        f('roi_rental_note', 'ROI / Rental Note', 'textarea', { full: true }),   // 027 (1.6)
        f('payment_plan', 'Payment Plan', 'textarea', { full: true }),
        f('price_negotiable', 'Price Negotiable', 'bool'),
        f('ownership_type', 'Ownership Type', 'select', { opts: OWNERSHIP }),
        f('documents_received', 'Documents Received', 'textarea', { full: true }),
        f('rera_number', 'RERA Number', 'text'),
    ] },
    { n: 5, key: 'amenities', title: 'Amenities & Lifestyle', fields: [
        f('amenities', 'Amenities', 'amenities', { full: true }),
        f('view_note', 'View', 'text'),
        f('balconies', 'Balconies', 'num'),
        f('lift_availability', 'Lift', 'text'),
        f('parking', 'Parking', 'parking', { full: true }),            // 027 (1.7) Yes/No -> type + count
    ] },
    { n: 6, key: 'about', title: 'Connectivity & About', fields: [
        f('connectivity', 'Connectivity', 'textarea', { full: true }),
        f('nearby_infrastructure', 'Nearby Infrastructure', 'textarea', { full: true }),
        f('suitable_for', 'Suitable For', 'textarea', { full: true }),
        f('highlights', 'Highlights', 'textarea', { full: true }),
        f('why_choose_this', 'Why Choose This', 'textarea', { full: true }),
        f('about', 'About', 'textarea', { full: true }),
        f('google_maps_url', 'Google Maps Link / Coordinates', 'map', { full: true }),
        f('media', 'Media', 'media', { full: true }),
    ] },
];

function typeOptionsFor(category) { return TYPE_BY_CATEGORY[category] || []; }
function categoryLabel(v) { const c = CATEGORIES.find(x => x.value === v); return c ? c.label : (v || ''); }

// ---- Detail helpers ----
function _has(v) { return v !== null && v !== undefined && String(v).trim() !== '' && !(Array.isArray(v) && v.length === 0); }
function cap(s) { return s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : ''; }

// Ordered detail cells for one group: [{label, value}] of the SET plain fields
// only (skips special widgets — amenities/map/media/psf are rendered bespoke,
// and category/commercial-hidden fields are filtered by the row's category).
const SKIP_IN_CELLS = { amenities: 1, map: 1, media: 1, psf: 1, bool: 1, parking: 1 };
// Shown bespoke in the detail hero — never repeat them as plain cells.
const HERO_FIELDS = { title: 1, status_of_property: 1, property_type: 1, expected_price: 1 };
function detailCells(row, group, opts) {
    const o = opts || {};
    return group.fields.filter(fl => {
        if (SKIP_IN_CELLS[fl.kind]) return false;
        if (HERO_FIELDS[fl.name]) return false;
        if (fl.owner) return false;                                   // owner card is bespoke
        if (fl.commercial && row.category !== 'commercial') return false;
        return _has(row[fl.name]);
    }).map(fl => {
        let v = row[fl.name];
        if (fl.kind === 'select' || fl.kind === 'status' || fl.name === 'facing' || fl.name === 'furnishing' || fl.name === 'ownership_type') v = cap(v);
        if (fl.name === 'status_of_property') v = statusLabel(row[fl.name]);
        if (fl.name === 'carpet_area')   v = row.carpet_area   + ' ' + (row.area_unit || 'sqft');
        if (fl.name === 'sellable_area') v = row.sellable_area + ' ' + (row.area_unit || 'sqft');
        if (fl.name === 'expected_price') v = '₹' + Number(row.expected_price).toLocaleString('en-IN');
        return { label: fl.label, value: v };
    });
}

module.exports = {
    GROUPS, CATEGORIES, STATUS_OPTIONS, STATUS_VALUES, statusLabel, LISTING_OPTIONS,
    TYPE_BY_CATEGORY, typeOptionsFor, categoryLabel,
    FACING, FURNISHING, OWNERSHIP,
    detailCells, cap,
};
