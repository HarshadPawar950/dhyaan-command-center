// =============================================================
// lib/projectExtras.js — ONE source of truth for the 99acres project view-model.
// Both /projects/:id (employee) and /admin/projects/:id (admin/HR) call
// loadProjectView() so the public detail page never diverges between personas.
// Additive to migration 019 fields; degrades gracefully if a field is null.
// =============================================================
const pool = require('../db');
const { buildMap } = require('./mapEmbed');
const { FIELDS: SHEET_FIELDS } = require('./projectSheet');
const { loadUnits } = require('./availableUnits');

async function q(sql, params = [], fallback = []) {
  try { const r = await pool.query(sql, params); return r.rows; }
  catch (err) { console.error('[projectExtras] query failed:', err.message); return fallback; }
}

// -------------------------------------------------------------------------
// Shared free-text search builder — the ONE place project search lives, so
// /admin/projects and /projects can never drift apart again (they already did
// once by copy-paste). Splits the query into whitespace-separated words; each
// word must match SOME column (AND across words, OR across columns), so
// "Nerul 2BHK" finds a Nerul project titled "…2BHK" instead of hunting the whole
// phrase in one column. Case-insensitive partial, fully parameterized.
//
// Mutates `conds` (pushes one OR-group per word) and `params` (pushes one
// '%word%' per word) in place; returns the next positional-param index. Capped
// at 8 words to bound the param count. Empty/blank q is a no-op (returns i).
function buildSearch(query, columns, conds, params, startIndex) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  let i = startIndex;
  for (const w of words) {
    const ors = columns.map(c => `LOWER(COALESCE(${c}, '')) LIKE $${i}`);
    conds.push('(' + ors.join(' OR ') + ')');
    params.push('%' + w.toLowerCase() + '%');
    i++;
  }
  return i;
}

// Project-list convenience: the canonical 6 searchable columns on
// private.projects, aliased (default 'p'). Used by BOTH project list routes.
function buildProjectSearch(query, alias, conds, params, startIndex) {
  const a = alias || 'p';
  const cols = [
    `${a}.title`, `${a}.builder`, `${a}.location`,
    `${a}.area_zone`, `${a}.locality`, `${a}.external_id`,
  ];
  return buildSearch(query, cols, conds, params, startIndex);
}

// ₹ formatter: lakhs-in → "₹85L" / "₹2.1Cr"
function money(lakhs) {
  if (lakhs == null || isNaN(Number(lakhs))) return null;
  const l = Number(lakhs);
  if (l >= 100) {
    const cr = l / 100;
    return '₹' + (Math.round(cr * 10) / 10).toString() + 'Cr';
  }
  return '₹' + (Math.round(l * 10) / 10).toString() + 'L';
}

// unit price in lakhs, preferring the new expected_price (rupees) then price_lakhs
function unitLakhs(u) {
  if (u.expected_price != null && !isNaN(Number(u.expected_price))) return Number(u.expected_price) / 100000;
  if (u.price_lakhs != null && !isNaN(Number(u.price_lakhs))) return Number(u.price_lakhs);
  return null;
}
function unitCarpet(u) {
  if (u.carpet_area != null && !isNaN(Number(u.carpet_area))) return Number(u.carpet_area);
  if (u.carpet_sqft != null && !isNaN(Number(u.carpet_sqft))) return Number(u.carpet_sqft);
  return null;
}

// "2, 3 BHK · 650–1400 sqft · ₹85L–₹2.1Cr" — derived, never cached.
function deriveConfigSummary(units) {
  const live = (units || []).filter(Boolean);
  if (!live.length) return null;
  // configs: keep distinct, order by any leading number
  const configs = [...new Set(live.map(u => (u.config || '').trim()).filter(Boolean))];
  const carpets = live.map(unitCarpet).filter(v => v != null);
  const prices  = live.map(unitLakhs).filter(v => v != null);
  const parts = [];
  if (configs.length) parts.push(configs.join(', '));
  if (carpets.length) {
    const mn = Math.min(...carpets), mx = Math.max(...carpets);
    parts.push(mn === mx ? `${mn} sqft` : `${mn}–${mx} sqft`);
  }
  if (prices.length) {
    const mn = money(Math.min(...prices)), mx = money(Math.max(...prices));
    parts.push(mn === mx ? mn : `${mn}–${mx}`);
  }
  return parts.length ? parts.join('  ·  ') : null;
}

const PROJECT_COLS = `
  project_id,
  COALESCE(external_id,'')                 AS external_id,
  title,
  COALESCE(location,'')                     AS location,
  COALESCE(builder,'')                      AS builder,
  builder_id,
  COALESCE(area_zone,'')                    AS area_zone,
  COALESCE(tier,'')                         AS tier,
  COALESCE(possession,'')                   AS possession,
  COALESCE(configurations,'')               AS configurations,
  COALESCE(price_range,'')                  AS price_range,
  COALESCE(construction_status::text,'')    AS construction_status,
  COALESCE(type::text,'')                   AS type,
  COALESCE(notes,'')                        AS notes,
  COALESCE(rera_number,'')                  AS rera_number,
  COALESCE(google_maps_url,'')              AS google_maps_url,
  latitude, longitude,
  COALESCE(bhk_config,'{}')                 AS bhk_config,
  COALESCE(source_doc,'')                   AS source_doc,
  price, listed_at,
  -- 019 additive
  COALESCE(about,'')                        AS about,
  possession_date, launch_date,
  total_towers, total_units_count,
  land_area, COALESCE(land_area_unit,'acres') AS land_area_unit,
  COALESCE(location_advantages,'{}')        AS location_advantages,
  COALESCE(price_list_note,'')              AS price_list_note,
  category::text                            AS category,
  COALESCE(has_residential,false)           AS has_residential,
  COALESCE(has_commercial,false)            AS has_commercial,
  COALESCE(property_type,'{}')              AS property_type,
  COALESCE(property_type_other_res,'')      AS property_type_other_res,
  COALESCE(property_type_other_com,'')      AS property_type_other_com,
  COALESCE(budget_ranges,'{}')              AS budget_ranges,
  COALESCE(budget_other,'')                 AS budget_other,
  COALESCE(status_of_property,'{}')         AS status_of_property,
  ${SHEET_FIELDS.join(', ')}`;

const UNIT_COLS = `
  property_id, project_id,
  COALESCE(title,'')        AS title,
  category::text            AS category,
  COALESCE(owner_name,'')   AS owner_name,
  COALESCE(owner_phone,'')  AS owner_phone,
  COALESCE(owner_email,'')  AS owner_email,
  COALESCE(owner_notes,'')  AS owner_notes,
  COALESCE(config,'')       AS config,
  COALESCE(carpet_sqft,'')  AS carpet_sqft,
  COALESCE(price_text,'')   AS price_text,
  price_lakhs,
  COALESCE(notes,'')        AS notes,
  created_at,
  -- 019 additive
  expected_price, price_per_sqft, price_negotiable,
  carpet_area, builtup_area, super_builtup_area,
  COALESCE(area_unit,'sqft') AS area_unit,
  bathrooms, balconies, floor_number, total_floors,
  facing::text              AS facing,
  COALESCE(additional_rooms,'{}') AS additional_rooms,
  COALESCE(overlooking,'{}')      AS overlooking,
  furnishing::text          AS furnishing,
  COALESCE(furnishing_items,'') AS furnishing_items,
  property_age_years,
  possession_status::text   AS possession_status,
  available_from,
  ownership_type::text      AS ownership_type,
  covered_parking, open_parking,
  COALESCE(about,'')        AS about,
  -- 026 singular sheet
  COALESCE(micro_market,'')          AS micro_market,
  COALESCE(locality,'')              AS locality,
  COALESCE(pincode,'')               AS pincode,
  COALESCE(status_of_property,'')    AS status_of_property,
  COALESCE(possession,'')            AS possession,
  COALESCE(property_structure,'')    AS property_structure,
  COALESCE(property_type,'')         AS property_type,
  COALESCE(unit_no,'')               AS unit_no,
  COALESCE(unit_condition,'')        AS unit_condition,
  COALESCE(vastu,'')                 AS vastu,
  COALESCE(pantry,'')                AS pantry,
  COALESCE(payment_plan,'')          AS payment_plan,
  COALESCE(documents_received,'')    AS documents_received,
  COALESCE(rera_number,'')           AS rera_number,
  COALESCE(amenities,'{}')           AS amenities,
  COALESCE(view_note,'')             AS view_note,
  COALESCE(lift_availability,'')     AS lift_availability,
  COALESCE(connectivity,'')          AS connectivity,
  COALESCE(nearby_infrastructure,'') AS nearby_infrastructure,
  COALESCE(suitable_for,'')          AS suitable_for,
  COALESCE(highlights,'')            AS highlights,
  COALESCE(why_choose_this,'')       AS why_choose_this,
  COALESCE(google_maps_url,'')       AS google_maps_url,
  latitude, longitude,
  -- 027 additive
  sellable_area,
  COALESCE(address_details,'')       AS address_details,
  COALESCE(roi_rental_note,'')       AS roi_rental_note,
  COALESCE(listing_sale,true)        AS listing_sale,
  COALESCE(listing_rent,false)       AS listing_rent,
  parking_available, COALESCE(parking_type,'') AS parking_type, parking_count`;

// Selected amenities for a project, grouped by category, ordered.
async function projectAmenities(projectId) {
  const rows = await q(
    `SELECT a.amenity_id, a.name, a.icon_key, COALESCE(a.category,'other') AS category, a.sort_order
       FROM private.project_amenities pa
       JOIN private.amenities a ON a.amenity_id = pa.amenity_id
      WHERE pa.project_id = $1 AND a.active
      ORDER BY a.sort_order, a.name`,
    [projectId], []);
  const byCategory = {};
  rows.forEach(a => { (byCategory[a.category] = byCategory[a.category] || []).push(a); });
  return { list: rows, byCategory };
}

// The amenities master grouped by category (no selection) — for the singular
// property checklist, which stores selected NAMES in properties.amenities (text[]).
async function amenitiesMaster() {
  const all = await q(
    `SELECT amenity_id, name, icon_key, COALESCE(category,'other') AS category, sort_order
       FROM private.amenities WHERE active ORDER BY sort_order, name`, [], []);
  const byCategory = {};
  all.forEach(a => { (byCategory[a.category] = byCategory[a.category] || []).push(a); });
  return { all, byCategory };
}

// Full amenities master (for the edit-form checklist) + a Set of selected ids.
async function amenitiesForEditor(projectId) {
  const all = await q(
    `SELECT amenity_id, name, icon_key, COALESCE(category,'other') AS category, sort_order
       FROM private.amenities WHERE active ORDER BY sort_order, name`, [], []);
  const sel = await q(
    `SELECT amenity_id FROM private.project_amenities WHERE project_id = $1`, [projectId], []);
  const selectedIds = new Set(sel.map(r => r.amenity_id));
  const byCategory = {};
  all.forEach(a => { (byCategory[a.category] = byCategory[a.category] || []).push(a); });
  return { all, byCategory, selectedIds };
}

// The full view-model both detail routes render.
async function loadProjectView(projectId) {
  const propRows = await q(
    `SELECT ${PROJECT_COLS} FROM private.projects WHERE project_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [projectId], []);
  if (!propRows.length) return null;
  const property = propRows[0];

  const units = await q(
    `SELECT ${UNIT_COLS} FROM private.properties
      WHERE project_id = $1 AND deleted_at IS NULL
      ORDER BY COALESCE(carpet_area, 0) ASC, COALESCE(price_lakhs,0) ASC, config`,
    [projectId], []);

  const media = await q(
    `SELECT image_id, file_path, COALESCE(caption,'') AS caption,
            COALESCE(media_type,'photo') AS media_type,
            COALESCE(original_name,'')   AS original_name,
            mime_type, file_size_bytes
       FROM private.property_images
      WHERE project_id = $1 AND deleted_at IS NULL
      ORDER BY sort_order, created_at`, [projectId], []);

  const amenities = await projectAmenities(projectId);
  const map = buildMap(property.google_maps_url, property.location, property.latitude, property.longitude);
  const availUnits = await loadUnits(pool, projectId);

  return {
    property,
    units,
    availUnits,
    images:     media.filter(m => m.media_type === 'photo'),
    videos:     media.filter(m => m.media_type === 'video'),
    brochures:  media.filter(m => m.media_type === 'brochure'),
    floorPlans: media.filter(m => m.media_type === 'floor_plan'),
    amenities:  amenities.list,
    amenitiesByCategory: amenities.byCategory,
    configSummary: deriveConfigSummary(units),
    map,
  };
}

// Single standalone property (singular sheet) + its media, map and — if a
// legacy project link survives — the parent project card.
async function loadUnitView(unitId) {
  const rows = await q(
    `SELECT ${UNIT_COLS} FROM private.properties WHERE property_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [unitId], []);
  if (!rows.length) return null;
  const unit = rows[0];

  // Legacy parent project (only if still linked).
  let project = null;
  if (unit.project_id) {
    const projRows = await q(
      `SELECT project_id, COALESCE(external_id,'') AS external_id, title,
              COALESCE(location,'') AS location, COALESCE(builder,'') AS builder,
              COALESCE(area_zone,'') AS area_zone, COALESCE(tier,'') AS tier,
              COALESCE(rera_number,'') AS rera_number,
              COALESCE(construction_status::text,'') AS construction_status
         FROM private.projects WHERE project_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [unit.project_id], []);
    project = projRows[0] || null;
  }

  // Map from the property's OWN link/coords (021+026), falling back to locality.
  const map = buildMap(unit.google_maps_url, unit.locality || (project && project.location), unit.latitude, unit.longitude);

  // Media for THIS standalone listing (026: property_images.property_id).
  const media = await q(
    `SELECT image_id, file_path, COALESCE(caption,'') AS caption,
            COALESCE(media_type,'photo') AS media_type,
            COALESCE(original_name,'')   AS original_name, mime_type, file_size_bytes
       FROM private.property_images
      WHERE property_id = $1 AND deleted_at IS NULL
      ORDER BY sort_order, created_at`, [unitId], []);

  return {
    unit, project, map,
    images:     media.filter(m => m.media_type === 'photo'),
    videos:     media.filter(m => m.media_type === 'video'),
    floorPlans: media.filter(m => m.media_type === 'floor_plan'),
  };
}

module.exports = {
  loadProjectView, loadUnitView, amenitiesForEditor, amenitiesMaster, deriveConfigSummary,
  money, unitLakhs, unitCarpet, PROJECT_COLS, UNIT_COLS,
  buildSearch, buildProjectSearch,
};
