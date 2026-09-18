// =============================================================
// middleware/matcherService.js — DB orchestration for the Property Matcher.
// Loads active units (+ property + builder), runs the PURE lib/matcher scorer,
// and logs the run to private.match_log as a side-effect (never blocks the
// response, exactly like middleware/historyLogger.js).
// =============================================================

const pool = require('../db');
const { rankMatches, WEIGHTS } = require('../lib/matcher');

// All active units, joined to their property (location/zone/builder) and the
// builder (commission). LEFT JOIN builders so a unit with no builder link is
// still scorable (commission just doesn't contribute).
// Migration 019: prefer the richer numeric fields when present, so the scorer
// transparently uses better data (expected_price in ₹ -> lakhs; numeric
// carpet_area -> the carpet the scorer parses). Falls back to the legacy
// columns for older rows. Scorer logic (lib/matcher.js) is untouched.
const UNITS_SQL = `
    SELECT u.property_id, u.project_id, u.config,
           u.category::text                                      AS category,
           u.status_of_property,
           COALESCE(u.carpet_area::text, u.carpet_sqft)          AS carpet_sqft,
           u.price_text,
           COALESCE(u.expected_price / 100000.0, u.price_lakhs)  AS price_lakhs,
           COALESCE(NULLIF(u.title,''), p.title)                 AS title,
           p.location  AS property_location,
           p.area_zone AS property_zone,
           p.locality  AS locality,
           p.builder,
           b.commission_rate,
           b.is_exclusive,
           -- 029 matcher v3 signals
           COALESCE(u.property_structure, p.property_structure)   AS property_structure,
           u.floor_number                                         AS floor_number,
           ( (u.amenities IS NOT NULL AND array_length(u.amenities, 1) > 0)
             OR EXISTS (SELECT 1 FROM private.project_amenities pa WHERE pa.project_id = p.project_id) ) AS has_amenities
      FROM private.properties u
      -- 021 decouple: LEFT JOIN so STANDALONE properties (no project) are still
      -- scored (project-derived location/builder just don't contribute).
      LEFT JOIN private.projects p
        ON p.project_id = u.project_id AND p.deleted_at IS NULL
      LEFT JOIN private.builders b
        ON b.builder_id = p.builder_id AND b.deleted_at IS NULL
     WHERE u.deleted_at IS NULL
`;

// HYBRID MATCHER (Option 3): projects are scored alongside units. Reps enter
// inventory at BOTH levels — a project carries budget_ranges / property_type / status
// tags (ranges), a unit carries an exact price + config. The scorer (lib/matcher.js)
// range-scores projects and dedups a project against its own units. All columns below
// already exist on private.projects (no migration).
const PROJECTS_SQL = `
    SELECT p.project_id,
           p.title,
           p.location  AS property_location,
           p.area_zone AS property_zone,
           p.locality  AS locality,
           p.builder,
           COALESCE(p.budget_ranges,'{}')       AS budget_ranges,
           COALESCE(p.budget_other,'')          AS budget_other,
           COALESCE(p.price_range,'')           AS price_range,
           COALESCE(p.property_type,'{}')       AS property_type,
           COALESCE(p.status_of_property,'{}')  AS status_of_property,
           COALESCE(p.has_residential,false)    AS has_residential,
           COALESCE(p.has_commercial,false)     AS has_commercial,
           p.property_structure,
           b.commission_rate,
           b.is_exclusive,
           EXISTS (SELECT 1 FROM private.project_amenities pa WHERE pa.project_id = p.project_id) AS has_amenities
      FROM private.projects p
      LEFT JOIN private.builders b
        ON b.builder_id = p.builder_id AND b.deleted_at IS NULL
     WHERE p.deleted_at IS NULL
`;

// Fire-and-forget audit write. Follows historyLogger doctrine: a logging
// failure NEVER breaks the feature.
async function logMatchRun(lead, out, req) {
    try {
        const su = req && req.session && req.session.user ? req.session.user : null;
        const params = {
            budget_lakhs: out.budgetLakhs,
            bhk: out.leadBHK,
            location: lead.location || null,
            budget_parsed: out.budgetParsed,
            weights: WEIGHTS,
        };
        const top5 = out.results.map(r => ({
            kind: r.kind, property_id: r.property_id, project_id: r.project_id, title: r.title,
            config: r.config, price_lakhs: r.price_lakhs, score: r.score,
            reasons: r.reasons.map(x => x.t),
        }));
        await pool.query(
            `INSERT INTO private.match_log
                (lead_id, run_by_code, run_by_name, params, top5, total_scored, skipped_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                lead.lead_id,
                su ? (su.external_id || su.employee_code || null) : null,
                su ? (su.name || null) : null,
                JSON.stringify(params),
                JSON.stringify(top5),
                out.totalScored,
                out.skippedCount,
            ]
        );
    } catch (err) {
        console.error('[matcher] match_log write failed:', err.message);
    }
}

// Load units, score, log, return the payload the panel renders.
async function runMatches(lead, req) {
    // Separate try/catch per pool so a failure in one still scores the other
    // (a projects-query error must never silently zero the whole result set).
    let units = [];
    try {
        const r = await pool.query(UNITS_SQL);
        units = r.rows;
    } catch (err) {
        console.error('[matcher] units query failed:', err.message);
    }
    let projects = [];
    try {
        const r = await pool.query(PROJECTS_SQL);
        projects = r.rows;
    } catch (err) {
        console.error('[matcher] projects query failed:', err.message);
    }
    const out = rankMatches(lead, units, projects);
    await logMatchRun(lead, out, req);
    return out;
}

module.exports = { runMatches };
