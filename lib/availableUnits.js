// =============================================================
// lib/availableUnits.js — per-category AVAILABLE-UNITS inventory (migration 025).
// Form posts repeatable rows named <side>_unit_no / _unit_area / _floor_no.
// Save is REPLACE-ALL per project+category (the form is the source of truth for
// what is currently available). deleted_at is reserved for future manual removal.
// =============================================================
const CATEGORY = { res: 'residential', com: 'commercial' };

function _arr(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }

// Parse one side's unit rows out of the POST body. Drops fully-empty rows.
function parseUnits(body, sideKey) {
    const b = body || {};
    const nos    = _arr(b[`${sideKey}_unit_no`]);
    const areas  = _arr(b[`${sideKey}_unit_area`]);
    const floors = _arr(b[`${sideKey}_floor_no`]);
    const n = Math.max(nos.length, areas.length, floors.length);
    const out = [];
    for (let i = 0; i < n; i++) {
        const unit_no  = (nos[i]    || '').toString().trim();
        const unit_area= (areas[i]  || '').toString().trim();
        const floor_no = (floors[i] || '').toString().trim();
        if (!unit_no && !unit_area && !floor_no) continue;       // skip empty row
        out.push({ unit_no, unit_area, floor_no, sort_order: out.length });
    }
    return out;
}

// Replace all available units for (projectId, side) inside an open transaction.
async function saveUnits(client, projectId, sideKey, units) {
    const category = CATEGORY[sideKey];
    if (!category) return;
    await client.query(
        `DELETE FROM private.project_available_units WHERE project_id = $1 AND category = $2`,
        [projectId, category]);
    for (const u of units) {
        await client.query(
            `INSERT INTO private.project_available_units (project_id, category, unit_no, unit_area, floor_no, sort_order)
             VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6)`,
            [projectId, category, u.unit_no, u.unit_area, u.floor_no, u.sort_order]);
    }
}

// Load available units for a project, grouped by side { res:[...], com:[...] }.
async function loadUnits(pool, projectId) {
    const out = { res: [], com: [] };
    try {
        const r = await pool.query(
            `SELECT category::text AS category, COALESCE(unit_no,'') AS unit_no,
                    COALESCE(unit_area,'') AS unit_area, COALESCE(floor_no,'') AS floor_no
               FROM private.project_available_units
              WHERE project_id = $1 AND deleted_at IS NULL
              ORDER BY category, sort_order, unit_no`, [projectId]);
        r.rows.forEach(row => {
            const side = row.category === 'commercial' ? 'com' : 'res';
            out[side].push({ unit_no: row.unit_no, unit_area: row.unit_area, floor_no: row.floor_no });
        });
    } catch (_) { /* table absent / error → empty */ }
    return out;
}

module.exports = { parseUnits, saveUnits, loadUnits, CATEGORY };
