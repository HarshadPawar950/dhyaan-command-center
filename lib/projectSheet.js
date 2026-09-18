// =============================================================
// lib/projectSheet.js — the Dhyaan project SHEET, mirrored LINE BY LINE
// (migrations 021 + 022 + 023). ONE ordered spec drives the form, the read-only
// display, and the sheet SQL. Groups & labels match the workbook exactly.
//
//   • Groups render in sheet order 1→7.
//   • G3 (Unit Configuration) + G4 (Pricing, ROI & Legal) are PER-CATEGORY:
//     rendered once per ticked side, backed by res_/com_ columns.
//   • G1,G2,G5,G6,G7 are SHARED (render once). G7 is admin/super only.
//   • Some visible fields are owned by OTHER routes, not the sheet SQL:
//       ext:'core'   → title, builder, possession   (core INSERT/UPDATE)
//       ext:'config' → total_units_count, about      (019 config UPDATE)
//       ext:'widget' → amenities, brochure, floor_plan (existing subsystems)
//     Only fields with neither ext nor widget are sheet-owned columns.
// =============================================================

const { BUDGET_BUCKETS, BUDGET_BUCKET_KEYS, bucketLabel } = require('./budgetBuckets');

const SIDES = [
    { key: 'res', prefix: 'res_', label: 'Residential', badge: 'RESIDENTIAL', flag: 'has_residential', icon: '🏠' },
    { key: 'com', prefix: 'com_', label: 'Commercial',  badge: 'COMMERCIAL',  flag: 'has_commercial',  icon: '🏢' },
];

// Budget Range: project-level multi-select; stored as text[] budget_ranges.
// Options are the canonical brackets (shared with the /admin/projects filter).
const BUDGET_OPTIONS = BUDGET_BUCKETS.map(b => ({ key: b.key, label: b.label }));

// ---- Structured choice sets (migration 024; status → multi 053) ----
// Status of Property: multi-select; stored as text[] status_of_property (053).
// Keys shared by the form, the read-only display and the /admin/projects filter.
const STATUS_OPTIONS = [
    { value: 'pre_launch',         label: 'Pre Launch' },
    { value: 'under_construction', label: 'Under Construction' },
    { value: 'near_possession',    label: 'Near Possession' },
    { value: 'ready_to_move',      label: 'Ready to Move' },
];
const STATUS_VALUES = STATUS_OPTIONS.map(o => o.value);
const STATUS_VALUE_SET = new Set(STATUS_VALUES);
function statusLabel(v) { var o = STATUS_OPTIONS.find(x => x.value === v); return o ? o.label : (v || ''); }
// construction_status (private.property_status enum, NOT NULL) is NOT a form field —
// the sheet form only sends the multi-select status_of_property[] tags. Derive the
// single enum from those tags so the main INSERT/UPDATE satisfies the NOT NULL column
// instead of passing NULL and silently falling into the savepoint fallback (which
// dropped price + type too). Multi-tagged projects collapse to the LEAST-complete
// phase so a cost sheet defaults to GST-applicable (the cost-sheet author overrides).
// near_possession is Pre-OC → GST applies → under_construction (CAPTAIN ruling).
const CONSTRUCTION_FROM_STATUS = {
    pre_launch:         'pre_launch',
    under_construction: 'under_construction',
    near_possession:    'under_construction',
    ready_to_move:      'ready_to_move',
};
// progress rank: lower = earlier phase = more GST-conservative default
const CONSTRUCTION_RANK = { pre_launch: 0, under_construction: 1, ready_to_move: 2, completed: 3 };
// Returns a valid property_status slug, or '' when no tag maps (caller decides the
// fallback: 'pre_launch' on create; preserve-existing on edit).
function deriveConstructionStatus(statuses) {
    const mapped = (Array.isArray(statuses) ? statuses : [])
        .map(s => CONSTRUCTION_FROM_STATUS[String(s || '').trim()])
        .filter(Boolean);
    if (!mapped.length) return '';
    return mapped.sort((a, b) => CONSTRUCTION_RANK[a] - CONSTRUCTION_RANK[b])[0];
}
// Property Type: multi-select; stored as text[] property_type. Options switch by category.
const TYPE_OPTIONS = {
    res: ['1 BHK', '2 BHK', '3 BHK', '4 BHK', '5 BHK', '6 BHK', 'Villa', 'Penthouse'],
    com: ['Office', 'Shop', 'Showroom', 'Warehouse', 'Office Space', 'Commercial Plot'],
};
// Property Type "Other" free-text (058): per-category companion to the Group 2
// property_type[] tags — a mirror of parseBudgetOther (054), but ONE field PER SIDE
// so a mixed-use project records a residential-Other ("Row House") and a
// commercial-Other ("Shop-cum-office") independently. Stored in
// property_type_other_res / property_type_other_com; the free text NEVER enters
// property_type[], keeping the matcher / filters / cost sheets (none read it)
// unaffected. Returns trimmed text, or NULL when the side is inactive OR the side's
// "Other" checkbox (<side>_type_other) is not ticked — so unticking clears to NULL.
function parseTypeOther(body, sideKey, sheetData) {
    const b = body || {};
    const active = sideKey === 'res'
        ? !!(sheetData && sheetData.has_residential)
        : !!(sheetData && sheetData.has_commercial);
    if (!active) return null;
    if (!String(b[`${sideKey}_type_other`] || '').trim()) return null;   // checkbox off → NULL
    const t = String(b[`property_type_other_${sideKey}`] || '').trim();
    return t || null;
}

// f(name, label, kind, opts) — kind: 'text' | 'num' | 'textarea' | 'widget'
function f(name, label, kind, opts) { return Object.assign({ name, label, kind: kind || 'text' }, opts || {}); }

// Ordered 7 groups. perCategory groups list BASE field names (col = prefix+name).
const SHEET = [
    { n: 1, key: 'basic', title: 'Basic Project & Location Information', fields: [
        f('micro_market', 'Micro market', 'text'),
        f('locality', 'Locality', 'text'),
        f('pincode', 'Pincode', 'text'),
        f('code_name', 'Code Name', 'text'),
        f('title', 'Real Name', 'text', { ext: 'core', required: true }),
        f('builder', 'Builder/Developer', 'text', { ext: 'core' }),
        // Location info — feeds the detail-page map embed + "Open in Google Maps".
        f('google_maps_url', 'Google Maps Link / Coordinates', 'map', { ext: 'core' }),
    ] },
    { n: 2, key: 'status', title: 'Property Status & Structure', fields: [
        f('status_of_property', 'Status of Property', 'statuses', { ext: 'array' }),  // multi-select text[] (053); keys shared with filter
        f('possession', 'Possession', 'text', { ext: 'core' }),
        f('property_structure', 'Property Structure', 'text'),
        f('property_type', 'Property Type', 'types', { ext: 'array' }),  // multi-select text[]
        f('land_parcel', 'Land Parcel', 'text'),
        f('total_units_count', 'Total No Of Units', 'num', { ext: 'config', int: true, max: 2147483647 }),
        f('tower_block', 'Tower/Block', 'text'),
        f('saleable_area', 'Saleable Area (sq ft)', 'num'),   // Change D — project-level, shared
        f('carpet_area', 'Carpet Area (sq ft)', 'num'),       // Change D — project-level, shared
        f('budget_ranges', 'Budget Range', 'buckets', { ext: 'array' }),  // multi-select text[]; keys shared with filter
    ] },
    { n: 3, key: 'config', title: 'Unit Configuration & Availability', perCategory: true, fields: [
        f('smallest_unit_area', 'Smallest Unit Area', 'num'),      // direct (line-by-line)
        f('largest_unit_area', 'Largest Unit Area', 'num'),        // direct
        f('available_units', 'Available Units', 'units'),          // repeater: Unit No / Unit Area Available / Floor No
        f('unit_condition', 'Unit Condition', 'text'),
        f('config', 'Office Configuration', 'text'),
        f('vastu', 'Property Vastu', 'text'),
    ] },
    { n: 4, key: 'pricing', title: 'Pricing, ROI & Legal', perCategory: true, fields: [
        f('payment_plan', 'Payment Plan', 'textarea'),
        f('psf_rate', 'PSF', 'num'),
        f('floor_rise_price', 'Floor Rise Price', 'num'),
        f('market_rate_psf', 'Market Pricing (Rate Per Sq. Ft)', 'num'),
        f('roi_rental_note', 'ROI and Rental', 'textarea'),
        f('documents_received', 'Documents Received', 'textarea'),
        f('rera_number', 'RERA Number', 'text'),
    ] },
    { n: 5, key: 'amenities', title: 'Amenities, Facilities & Lifestyle', fields: [
        f('facilities', 'Facilities', 'textarea'),
        f('view_note', 'View', 'text'),
        f('amenities', 'Amenities', 'widget', { ext: 'widget', widget: 'amenities' }),
        f('balcony_note', 'Balcony', 'text'),
        f('lift_availability', 'Lift Availability', 'text'),
        f('pantry', 'Pantry', 'text'),
    ] },
    { n: 6, key: 'connectivity', title: 'Connectivity & Marketing Insights', fields: [
        f('connectivity', 'Connectivity', 'textarea'),
        f('nearby_infrastructure', 'Nearby Infrastructure', 'textarea'),
        f('suitable_for', 'Suitable For', 'textarea'),
        f('project_highlights', 'Project Highlights', 'textarea'),
        f('contact_number', 'Contact Number', 'text'),
        f('why_choose_this', 'Why Choose This', 'textarea'),
        f('brochure', 'Brochure', 'widget', { ext: 'widget', widget: 'brochure' }),
        f('floor_plan', 'Floor Plan', 'widget', { ext: 'widget', widget: 'floor_plan' }),
        f('breakdown', 'Breakdown', 'textarea'),
        f('about', 'About the Project', 'textarea', { ext: 'config' }),
    ] },
    { n: 7, key: 'internal', title: 'Digital Marketing & Ads (Internal Use)', internal: true, fields: [
        f('limited_offer', 'Limited Offer', 'text'),
        f('creatives_note', 'Creatives', 'textarea'),
        f('ad_budget', 'Budget for Ads', 'num'),
        f('targeted_keywords', 'Targeted Keywords', 'textarea'),
    ] },
];

// A field is a sheet-owned column iff it isn't external and isn't a widget/units repeater.
// (status_of_property + property_type are ext:'array'; available units live in a child table.)
function isSheetField(fl) { return !fl.ext && fl.kind !== 'widget' && fl.kind !== 'units'; }

// Flat list of sheet-owned columns (shared + res_/com_ per-category).
function sheetColumns() {
    const cols = [];
    SHEET.forEach(g => {
        g.fields.filter(isSheetField).forEach(fl => {
            if (g.perCategory) SIDES.forEach(s => cols.push({ col: s.prefix + fl.name, num: fl.kind === 'num' }));
            else cols.push({ col: fl.name, num: fl.kind === 'num' });
        });
    });
    return cols;
}
const SHEET_COLS = sheetColumns();
const FIELDS = SHEET_COLS.map(c => c.col);           // for SELECT in projectExtras

// ---- Parse the POST body into a sheet save payload ----
function buildSheetData(body) {
    const b = body || {};
    const s = k => (b[k] === undefined || b[k] === null ? '' : String(b[k])).trim();
    const truthy = v => v === true || v === 'on' || v === '1' || v === 'true';
    const d = { has_residential: truthy(b.has_residential), has_commercial: truthy(b.has_commercial) };
    SHEET_COLS.forEach(c => { d[c.col] = s(c.col); });
    return d;
}

// ---- SQL: flags first ($1,$2), then every sheet column, then WHERE id ----
function sheetUpdateSql() {
    const parts = ['has_residential = $1', 'has_commercial = $2'];
    let i = 3;
    SHEET_COLS.forEach(c => {
        parts.push(`${c.col} = ` + (c.num ? `NULLIF($${i},'')::numeric` : `NULLIF($${i},'')`));
        i++;
    });
    return `UPDATE private.projects SET ${parts.join(', ')} WHERE project_id = $${i} AND deleted_at IS NULL`;
}
function sheetParams(d, projectId) {
    return [d.has_residential, d.has_commercial].concat(SHEET_COLS.map(c => d[c.col])).concat([projectId]);
}

// ---- Numeric validation (shared by property-new + property-edit) ----
// Catch out-of-range / non-numeric input in the FORM with a human message that
// NAMES the field, instead of letting an oversized value reach Postgres and blow
// up with a raw type-overflow error. INT_MAX = PostgreSQL `integer` ceiling;
// NUM_CEILING = a sane business ceiling for money/area/rate fields (the columns
// are unbounded numeric, but a 12-digit rupee/sqft figure is already absurd).
const INT_MAX = 2147483647;
const NUM_CEILING = 1000000000000; // 1e12
// integer-typed DB columns not (fully) covered by the sheet 'num' loop.
const EXTRA_INT_FIELDS = { total_towers: 'No. of Towers' };
// numeric core columns that live outside the sheet spec.
const EXTRA_NUM_FIELDS = { price: 'Price', land_area: 'Land Area' };

function validateNumbers(body) {
    const b = body || {};
    const errors = [];
    const seen = new Set();
    function check(name, label, isInt, max) {
        if (seen.has(name)) return; seen.add(name);
        const raw = b[name];
        if (raw === undefined || raw === null || String(raw).trim() === '') return; // optional
        const s = String(raw).trim();
        const n = Number(s);
        if (s === '' || !isFinite(n) || Number.isNaN(n)) { errors.push(`${label} must be a number.`); return; }
        if (isInt && !Number.isInteger(n)) { errors.push(`${label} must be a whole number.`); return; }
        if (n < 0) { errors.push(`${label} cannot be negative.`); return; }
        const cap = max || (isInt ? INT_MAX : NUM_CEILING);
        if (n > cap) { errors.push(`${label} is too large (maximum ${cap.toLocaleString('en-IN')}).`); return; }
    }
    // Every sheet 'num' column (shared + res_/com_ per-category), honouring per-field int/max.
    SHEET.forEach(g => g.fields.filter(fl => fl.kind === 'num').forEach(fl => {
        if (g.perCategory) SIDES.forEach(s => check(s.prefix + fl.name, `${s.label} ${fl.label}`, !!fl.int, fl.max));
        else check(fl.name, fl.label, !!fl.int, fl.max);
    }));
    Object.keys(EXTRA_INT_FIELDS).forEach(k => check(k, EXTRA_INT_FIELDS[k], true));
    Object.keys(EXTRA_NUM_FIELDS).forEach(k => check(k, EXTRA_NUM_FIELDS[k], false));
    return errors;
}

// ---- Display helpers ----
function _has(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function activeBadges(row) {
    return SIDES.filter(s => row && row[s.flag]).map(s => ({ label: s.label, badge: s.badge, icon: s.icon }));
}
// Per-category blocks for the detail page: [{ side, label, badge, icon, groups:[{title, cells:[{label,value}]}] }]
function categoryBlocks(row) {
    const r = row || {};
    return SIDES.filter(s => r[s.flag]).map(side => {
        const groups = SHEET.filter(g => g.perCategory).map(g => {
            const cells = g.fields.filter(isSheetField)
                .map(fl => ({ label: fl.label, value: r[side.prefix + fl.name] }))
                .filter(c => _has(c.value));
            return { n: g.n, title: g.title, cells };
        }).filter(g => g.cells.length);
        return { side: side.key, label: side.label, badge: side.badge, icon: side.icon, groups };
    });
}

module.exports = {
    SHEET, SIDES, FIELDS, SHEET_COLS, isSheetField,
    STATUS_OPTIONS, STATUS_VALUES, STATUS_VALUE_SET, statusLabel, TYPE_OPTIONS,
    deriveConstructionStatus, parseTypeOther,
    BUDGET_OPTIONS, BUDGET_BUCKET_KEYS, bucketLabel,
    buildSheetData, sheetUpdateSql, sheetParams,
    validateNumbers,
    activeBadges, categoryBlocks,
};
