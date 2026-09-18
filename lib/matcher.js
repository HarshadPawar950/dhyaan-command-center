// =============================================================
// lib/matcher.js — Property Matcher (AI Day, Feature 1)
//
// PURE scoring logic. No database, no I/O, no side effects — fully unit-
// testable. The route/service layer feeds it a lead + a list of units and
// gets back a ranked top-5 with transparent reasons and an honest skipped
// count.
//
// DIRTY-DATA DOCTRINE: prices and budgets in this DB are free-text
// (unit.price_lakhs is often NULL; the real price hides in price_text like
// "₹1,64,86,300"; lead.budget is text like "1.3cr"). We parse DEFENSIVELY and
// SKIP anything we cannot parse — counted and surfaced, never guessed, never
// crashed, never a fabricated score.
//
// Weights (out of 100) — Boss-approved 2026-07-22, tune here:
// =============================================================

// Weights (out of 100). 027 activated the Client Profile signals: the reserved
// possession weight is now live, and Config splits into BHK + category so a
// commercial lead never scores high on a residential unit.
// v3 (029): rebalanced to make room for three Client-Profile-v2 signals —
// layout (standalone/township), floor-of-choice, and amenities preference.
const WEIGHTS = Object.freeze({
    budget: 34,        // affordability fit (sharpened by cp_budget_tag when set)
    location: 22,      // micro-market / zone
    config: 20,        // BHK (12) + category res/comm (8)
    config_bhk: 12,
    config_category: 8,
    possession: 8,     // cp_possession_pref vs unit status_of_property
    business: 4,       // builder commission (transparent business weight)
    layout: 5,         // cp_layout_pref (standalone/township) vs property_structure
    floor: 4,          // cp_floor_pref band vs unit floor_number
    amenities: 3,      // cp_amenities_pref (with/without) vs unit has_amenities
});

// cp_budget_tag -> [lo, hi] band in LAKHS. Used to score budget precisely when
// the lead carries a structured budget tag (overrides the free-text parse).
const BUDGET_BANDS = Object.freeze({
    under_50l:  [0, 50],
    '50l_1cr':  [50, 100],
    '1_3cr':    [100, 300],
    '3_10cr':   [300, 1000],
    above_10cr: [1000, Infinity],
});

// HYBRID MATCHER (Option 3): projects are scored alongside units. A project
// carries RANGES (budget_ranges tags, property_type[]), not an exact price/config,
// so its budget + BHK signals are honestly capped (RANGE_CAP) and it is never shown
// unless it clears MIN_SCORE. budgetBuckets is a pure constant module (no DB) — safe
// to require here without breaking lib/matcher's "no I/O" contract.
const { BUDGET_BUCKETS } = require('./budgetBuckets');
// Node-aware location scoring (also pure/no-I/O — same contract as budgetBuckets).
const { extractNode, meaningfulTokens, nodeLabel } = require('./nodes');
// bucket key -> [lo, hi] lakhs band ('300plus' -> [300, Infinity]; 'other' has no band).
const BUCKET_BAND = Object.freeze(BUDGET_BUCKETS.reduce((m, b) => {
    if (!b.other) m[b.key] = [b.min, (b.max == null ? Infinity : b.max)];
    return m;
}, {}));
const RANGE_CAP = 0.9;   // projects match budget/BHK on RANGES, not exact -> honest 10% cap
const MIN_SCORE = 25;    // below this: not shown (explicit empty-state, never padding)

function _arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }

// ---------------------------------------------------------------------
// PARSERS (return null when un-parseable — the caller decides what to do)
// ---------------------------------------------------------------------

// "1.3cr" -> 130, "1cr" -> 100, "56 lakh"/"56L" -> 56, "90k" -> 0.9,
// "₹1,64,86,300" -> 164.863, "90" -> 90 (bare small = lakhs), null on junk.
function parseBudgetLakhs(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).toLowerCase().replace(/₹|rs\.?|inr/g, '').trim();
    if (!s) return null;
    const m = s.match(/([\d]+(?:[\d,]*\d)?(?:\.\d+)?)/);
    if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(num)) return null;
    if (/\d\s*cr|crore/.test(s)) return num * 100;       // crore -> lakhs
    if (/lakh|lac|\bl\b|\dl\b/.test(s)) return num;       // lakhs
    if (/\bk\b|\dk\b/.test(s)) return num / 100;           // thousand -> lakhs
    // bare number: large = raw rupees; otherwise treat as lakhs
    if (num >= 100000) return num / 100000;
    return num;
}

// Prefer the clean numeric column; fall back to parsing the formatted text.
// "₹1,64,86,300" -> 164.863 lakhs. Returns null if neither is usable.
function parsePriceLakhs(priceLakhs, priceText) {
    if (priceLakhs !== null && priceLakhs !== undefined && priceLakhs !== '') {
        const n = Number(priceLakhs);
        if (isFinite(n) && n > 0) return n;
    }
    if (priceText === null || priceText === undefined) return null;
    const digits = String(priceText).replace(/[^\d.]/g, '');
    if (!digits || !/\d/.test(digits)) return null;
    const rupees = parseFloat(digits);
    if (!isFinite(rupees) || rupees <= 0) return null;
    return rupees / 100000; // rupees -> lakhs
}

// Pull a BHK integer out of any of the given free-text fields. "3bhk
// residential @ dombivili" -> 3, "2 BHK" -> 2, null if none found.
function extractBHK(...fields) {
    for (const f of fields) {
        if (f === null || f === undefined) continue;
        const m = String(f).toLowerCase().match(/(\d+(?:\.\d+)?)\s*bhk/);
        if (m) {
            const n = parseFloat(m[1]);
            if (isFinite(n)) return n;
        }
    }
    return null;
}

// Absolute floor number -> band. Rough but deterministic — we have no reliable
// total-floors data, so map by absolute height. null when unknown.
function floorBand(n) {
    if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return null;
    const f = Number(n);
    if (f <= 4) return 'lower';
    if (f <= 10) return 'mid';
    return 'higher';
}

// Location tokens worth matching on: ≥3 chars AND not a city-wide/structural
// stopword ("navi","mumbai","sector",...). Stripping the noise is what lets a
// real locality outrank a city-wide one in the token-fallback tier. (Delegates
// to lib/nodes so the stopword list lives in one place.)
function locationTokens(loc) {
    return meaningfulTokens(loc);
}

// ---- SHARED LOCATION SIGNAL (units + projects use the same logic) ----
// Tiering: known-NODE match (lead node == item node) => FULL weight; else a
// stopword-filtered token overlap => weak "same area" credit; else 0. `o` may
// carry propertyZone / locality / propertyLocation — we score against the
// combined haystack (area_zone -> locality -> location fallback chain).
function locHaystack(o) {
    return [o.locationHay, o.propertyZone, o.locality, o.propertyLocation]
        .filter(Boolean).join(' , ');
}
function scoreLocationSignal(o, ctx) {
    const hay = locHaystack(o);
    if (!hay) return { pts: 0, reason: null };
    const itemNode = extractNode(hay);
    if (ctx.leadNode && itemNode && ctx.leadNode === itemNode) {
        return { pts: WEIGHTS.location,
                 reason: { k: 'location', t: nodeLabel(ctx.leadNode) + ' node match', good: true } };
    }
    const low = hay.toLowerCase();
    if (ctx.leadTokens.length && ctx.leadTokens.some(t => low.includes(t))) {
        return { pts: Math.round(WEIGHTS.location * 0.6),
                 reason: { k: 'location', t: 'same area', good: true } };
    }
    return { pts: 0, reason: null };
}

// ---- PROJECT parsers (hybrid matcher) ----
// "1-1.5Cr" / "1cr - 1.5cr" / "50L-75L" -> [lo, hi] lakhs. A trailing unit is
// propagated to a unit-less first part ("1-1.5Cr" -> 1Cr..1.5Cr). null if unusable.
function parseRangeBand(text) {
    if (!text) return null;
    const s = String(text).trim();
    const unitM = s.toLowerCase().match(/(cr|crore|lakh|lac|l)\s*$/);
    const unit = unitM ? unitM[1] : '';
    const nums = s.split(/\s*(?:-|–|—|to)\s*/i).map(part => {
        let q = part.trim();
        if (unit && !/(cr|crore|lakh|lac|\bl\b|k)/i.test(q)) q = q + unit; // propagate trailing unit
        return parseBudgetLakhs(q);
    }).filter(v => v !== null && isFinite(v));
    if (!nums.length) return null;
    return [Math.min(...nums), Math.max(...nums)];
}
// Union the ticked budget_ranges tags into numeric [lo,hi] bands; fall back to a
// range parsed from free-text price_range / budget_other when no tags are set.
function projectBudgetBands(budgetRanges, priceRange, budgetOther) {
    const bands = [];
    for (const k of _arr(budgetRanges)) { const b = BUCKET_BAND[String(k)]; if (b) bands.push(b); }
    if (bands.length) return bands;
    const fromText = parseRangeBand(priceRange) || parseRangeBand(budgetOther);
    return fromText ? [fromText] : [];
}
// BHK integers present in a property_type[] array. "2 BHK" -> 2; Villa/Office -> none.
function extractBHKSet(propertyType) {
    const set = new Set();
    for (const t of _arr(propertyType)) {
        const m = String(t).toLowerCase().match(/(\d+)\s*bhk/);
        if (m) set.add(parseInt(m[1], 10));
    }
    return set;
}
// lakhs -> "₹1.5 Cr" / "₹75 L" for the project price label.
function formatLakhs(l) {
    if (l == null || !isFinite(l)) return '';
    return l >= 100 ? '₹' + (l / 100).toFixed(2).replace(/\.?0+$/, '') + ' Cr' : '₹' + Math.round(l) + ' L';
}
// label for a set of budget bands: lowest lo .. highest hi.
function bandLabel(bands) {
    if (!bands || !bands.length) return '';
    const lo = Math.min(...bands.map(b => b[0]));
    const hi = Math.max(...bands.map(b => b[1]));
    if (hi === Infinity) return formatLakhs(lo) + '+';
    return formatLakhs(lo) + ' – ' + formatLakhs(hi);
}

// ---------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------

// ctx: { budgetLakhs, budgetParsed, leadBHK, leadTokens, maxCommission }
// unit: { priceLakhs (already parsed, >0), unitBHK, propertyLocation,
//         propertyZone, commissionRate, isExclusive }
const POSS_LABEL = {
    ready_to_move: 'ready-to-move', under_construction: 'under-construction',
    near_possession: 'near-possession', pre_launch: 'pre-launch', pre_lease: 'pre-lease',
};

function scoreUnitParsed(unit, ctx) {
    const reasons = [];

    // ---- Budget (40) ----
    let budget;
    if (ctx.budgetBand) {
        // Structured budget tag: score by the band (overrides the free-text parse).
        const lo = ctx.budgetBand[0], hi = ctx.budgetBand[1];
        const p = unit.priceLakhs;
        if (p >= lo && p <= hi) {
            budget = WEIGHTS.budget;
            reasons.push({ k: 'budget', t: 'budget tag match', good: true });
        } else {
            const width = Math.max(50, hi === Infinity ? lo : (hi - lo));
            const dist = p < lo ? (lo - p) : (p - hi);
            const frac = Math.min(1, dist / width);
            budget = Math.max(0, WEIGHTS.budget * (1 - frac));
            reasons.push({ k: 'budget', t: p < lo ? 'below budget tag' : 'above budget tag', good: p < lo });
        }
    } else if (!ctx.budgetParsed) {
        budget = WEIGHTS.budget * 0.5; // neutral — no lead budget captured
        reasons.push({ k: 'budget', t: 'budget not specified', good: false });
    } else {
        const ratio = unit.priceLakhs / ctx.budgetLakhs;
        if (ratio >= 0.85 && ratio <= 1.15) {
            budget = WEIGHTS.budget;
            reasons.push({ k: 'budget', t: 'within budget', good: true });
        } else if (ratio < 0.85) {
            const short = (0.85 - ratio) / 0.85;                 // 0..1
            budget = Math.max(WEIGHTS.budget * 0.35, WEIGHTS.budget - short * (WEIGHTS.budget * 0.66));
            reasons.push({ k: 'budget', t: 'under budget', good: true });
        } else {
            const over = (ratio - 1.15) / 0.35;                  // 0..1 at +50%
            budget = Math.max(0, WEIGHTS.budget - over * WEIGHTS.budget);
            reasons.push({ k: 'budget', t: 'over budget', good: false });
        }
    }

    // ---- Location (22) — node-first, token fallback (shared helper) ----
    const locSig = scoreLocationSignal(unit, ctx);
    const location = locSig.pts;
    if (locSig.reason) reasons.push(locSig.reason);

    // ---- Config: BHK (12) + Category res/comm (8) ----
    let configBhk;
    if (ctx.leadBHK === null || ctx.leadBHK === undefined) {
        configBhk = WEIGHTS.config_bhk * 0.5;
        reasons.push({ k: 'config', t: 'BHK not specified', good: false });
    } else if (unit.unitBHK === null || unit.unitBHK === undefined) {
        configBhk = 0;
    } else {
        const diff = Math.abs(unit.unitBHK - ctx.leadBHK);
        if (diff === 0) {
            configBhk = WEIGHTS.config_bhk;
            reasons.push({ k: 'config', t: `${ctx.leadBHK}BHK match`, good: true });
        } else if (diff <= 1) {
            configBhk = Math.round(WEIGHTS.config_bhk * 0.4);
            reasons.push({ k: 'config', t: '±1 BHK', good: true });
        } else {
            configBhk = 0;
        }
    }
    let configCat;
    if (!ctx.leadConfigs || !ctx.leadConfigs.length) {
        configCat = WEIGHTS.config_category * 0.5;                // neutral — no preference
    } else if (unit.category && ctx.leadConfigs.indexOf(unit.category) !== -1) {
        configCat = WEIGHTS.config_category;
        reasons.push({ k: 'config', t: unit.category === 'commercial' ? 'commercial match' : 'residential match', good: true });
    } else {
        configCat = 0;                                           // lead specified categories, this unit isn't one
    }
    const config = configBhk + configCat;

    // ---- Possession (10) ----
    let possession;
    if (!ctx.leadPoss || !ctx.leadPoss.length) {
        possession = WEIGHTS.possession * 0.5;                   // neutral — no preference
    } else if (unit.status && ctx.leadPoss.indexOf(unit.status) !== -1) {
        possession = WEIGHTS.possession;
        reasons.push({ k: 'possession', t: 'wants ' + (POSS_LABEL[unit.status] || unit.status), good: true });
    } else {
        possession = 0;
    }

    // ---- Layout: standalone vs township (5) ----
    let layout;
    if (!ctx.leadLayout) {
        layout = WEIGHTS.layout * 0.5;                           // neutral — no preference
    } else if (!unit.propertyStructure) {
        layout = WEIGHTS.layout * 0.5;                           // unit data missing — don't punish
    } else if (unit.propertyStructure.indexOf(ctx.leadLayout) !== -1) {
        layout = WEIGHTS.layout;
        reasons.push({ k: 'layout', t: ctx.leadLayout === 'township' ? 'township match' : 'stand-alone match', good: true });
    } else {
        layout = 0;
    }

    // ---- Floor of choice (4) ----
    let floor;
    if (!ctx.leadFloors || !ctx.leadFloors.length) {
        floor = WEIGHTS.floor * 0.5;                             // neutral — no preference
    } else if (unit.floorBand === null || unit.floorBand === undefined) {
        floor = WEIGHTS.floor * 0.5;                             // unit floor unknown — neutral
    } else if (ctx.leadFloors.indexOf(unit.floorBand) !== -1) {
        floor = WEIGHTS.floor;
        reasons.push({ k: 'floor', t: unit.floorBand + '-floor match', good: true });
    } else {
        floor = 0;
    }

    // ---- Amenities preference: with / without (3) ----
    let amenities;
    if (!ctx.leadAmenPref) {
        amenities = WEIGHTS.amenities * 0.5;                     // neutral — no preference
    } else if ((ctx.leadAmenPref === 'with_amenities' && unit.hasAmenities) ||
               (ctx.leadAmenPref === 'without' && !unit.hasAmenities)) {
        amenities = WEIGHTS.amenities;
        reasons.push({ k: 'amenities', t: ctx.leadAmenPref === 'with_amenities' ? 'has amenities' : 'no-frills match', good: true });
    } else {
        amenities = 0;
    }

    // ---- Business / commission (4) ----
    let business = 0;
    if (ctx.maxCommission > 0 && isFinite(unit.commissionRate)) {
        business = (unit.commissionRate / ctx.maxCommission) * (WEIGHTS.business - 1);
    }
    if (unit.isExclusive) business += 1;
    business = Math.min(WEIGHTS.business, business);

    const score = Math.round(budget + location + config + possession + business + layout + floor + amenities);
    return {
        score,
        reasons,
        breakdown: {
            budget: Math.round(budget), location, config: Math.round(config),
            possession: Math.round(possession),
            layout: Math.round(layout), floor: Math.round(floor), amenities: Math.round(amenities),
            business: Math.round(business * 10) / 10,
        },
    };
}

// Score a PROJECT row (ranges, not exact data). Same weights as scoreUnitParsed,
// but budget + BHK match on RANGES so they are capped at RANGE_CAP (honest
// imprecision), floor is always neutral-half (a project has no floor), and a
// project with no BHK-bearing property_type scores BHK neutral-half — absent data,
// NOT a mismatch (CAPTAIN ruling). scoreUnitParsed is deliberately left untouched.
// proj: { budgetBands:[[lo,hi]], bhkSet:Set, categories:Set, statusTags:[],
//         propertyLocation, propertyZone, propertyStructure, hasAmenities,
//         commissionRate, isExclusive }
function scoreProjectParsed(proj, ctx) {
    const reasons = [];

    // ---- Budget (34), range-capped ----
    let budget;
    let lo = null, hi = null;
    if (ctx.budgetBand) { lo = ctx.budgetBand[0]; hi = ctx.budgetBand[1]; }
    else if (ctx.budgetParsed) { lo = ctx.budgetLakhs; hi = ctx.budgetLakhs; }
    const bands = proj.budgetBands || [];
    if (lo === null) {
        budget = WEIGHTS.budget * 0.5;                          // LEAD carries no budget — true neutral (not the project's fault)
        reasons.push({ k: 'budget', t: 'budget not specified', good: false });
    } else if (!bands.length) {
        // PROJECT declares no range — score at 0.85 of neutral (CAPTAIN ruling): a
        // declared+matching range is stronger evidence, but 12/37 are untagged real
        // inventory, so it's a nudge, never a knockout.
        budget = WEIGHTS.budget * 0.5 * 0.85;
        reasons.push({ k: 'budget', t: 'no price range on project', good: false });
    } else if (bands.some(b => lo <= b[1] && hi >= b[0])) {
        budget = WEIGHTS.budget * RANGE_CAP;                    // lead budget falls inside a project range
        reasons.push({ k: 'budget', t: 'in budget range', good: true });
    } else {
        let dist = Infinity;
        for (const b of bands) { const d = hi < b[0] ? (b[0] - hi) : (lo - b[1]); if (d < dist) dist = d; }
        const frac = Math.min(1, Math.max(0, dist) / 50);
        budget = Math.max(0, WEIGHTS.budget * RANGE_CAP * (1 - frac));
        reasons.push({ k: 'budget', t: hi < bands[0][0] ? 'below project range' : 'above project range', good: false });
    }

    // ---- Location (22) — node-first, token fallback (shared helper) ----
    const locSig = scoreLocationSignal(proj, ctx);
    const location = locSig.pts;
    if (locSig.reason) reasons.push(locSig.reason);

    // ---- Config: BHK (12, range-capped) + Category (8, full) ----
    let configBhk;
    if (ctx.leadBHK === null || ctx.leadBHK === undefined) {
        configBhk = WEIGHTS.config_bhk * 0.5;                   // lead didn't specify — neutral
        reasons.push({ k: 'config', t: 'BHK not specified', good: false });
    } else if (!proj.bhkSet || proj.bhkSet.size === 0) {
        configBhk = WEIGHTS.config_bhk * 0.5;                   // RULING: no BHK on project = absent data, neutral (not 0)
    } else if (proj.bhkSet.has(ctx.leadBHK)) {
        configBhk = WEIGHTS.config_bhk * RANGE_CAP;
        reasons.push({ k: 'config', t: `${ctx.leadBHK}BHK available`, good: true });
    } else if ([...proj.bhkSet].some(b => Math.abs(b - ctx.leadBHK) <= 1)) {
        configBhk = WEIGHTS.config_bhk * 0.4 * RANGE_CAP;
        reasons.push({ k: 'config', t: '±1 BHK', good: true });
    } else {
        configBhk = 0;
    }
    let configCat;
    if (!ctx.leadConfigs || !ctx.leadConfigs.length) {
        configCat = WEIGHTS.config_category * 0.5;
    } else if (proj.categories && ctx.leadConfigs.some(c => proj.categories.has(c))) {
        configCat = WEIGHTS.config_category;
        reasons.push({ k: 'config', t: (proj.categories.has('commercial') && ctx.leadConfigs.indexOf('commercial') !== -1) ? 'commercial match' : 'residential match', good: true });
    } else {
        configCat = 0;
    }
    const config = configBhk + configCat;

    // ---- Possession (8), full — projects carry status_of_property[] tags ----
    let possession;
    if (!ctx.leadPoss || !ctx.leadPoss.length) {
        possession = WEIGHTS.possession * 0.5;
    } else if (proj.statusTags && ctx.leadPoss.some(p => proj.statusTags.indexOf(p) !== -1)) {
        possession = WEIGHTS.possession;
        reasons.push({ k: 'possession', t: 'possession match', good: true });
    } else {
        possession = 0;
    }

    // ---- Layout (5), full ----
    let layout;
    if (!ctx.leadLayout) layout = WEIGHTS.layout * 0.5;
    else if (!proj.propertyStructure) layout = WEIGHTS.layout * 0.5;
    else if (proj.propertyStructure.indexOf(ctx.leadLayout) !== -1) {
        layout = WEIGHTS.layout;
        reasons.push({ k: 'layout', t: ctx.leadLayout === 'township' ? 'township match' : 'stand-alone match', good: true });
    } else layout = 0;

    // ---- Floor (4): a project has no floor — always neutral-half ----
    const floor = WEIGHTS.floor * 0.5;

    // ---- Amenities (3), full ----
    let amenities;
    if (!ctx.leadAmenPref) amenities = WEIGHTS.amenities * 0.5;
    else if ((ctx.leadAmenPref === 'with_amenities' && proj.hasAmenities) ||
             (ctx.leadAmenPref === 'without' && !proj.hasAmenities)) {
        amenities = WEIGHTS.amenities;
        reasons.push({ k: 'amenities', t: ctx.leadAmenPref === 'with_amenities' ? 'has amenities' : 'no-frills match', good: true });
    } else amenities = 0;

    // ---- Business / commission (4), full ----
    let business = 0;
    if (ctx.maxCommission > 0 && isFinite(proj.commissionRate)) {
        business = (proj.commissionRate / ctx.maxCommission) * (WEIGHTS.business - 1);
    }
    if (proj.isExclusive) business += 1;
    business = Math.min(WEIGHTS.business, business);

    const score = Math.round(budget + location + config + possession + business + layout + floor + amenities);
    return {
        score, reasons,
        breakdown: {
            budget: Math.round(budget), location, config: Math.round(config),
            possession: Math.round(possession), layout: Math.round(layout),
            floor: Math.round(floor), amenities: Math.round(amenities),
            business: Math.round(business * 10) / 10,
        },
    };
}

// Rank all units for a lead. Returns the top-5 plus honest counters.
// lead: raw DB row. units: array of raw DB rows joined with property+builder
// fields (property_location, property_zone, commission_rate, is_exclusive).
// projects: array of raw private.projects rows (hybrid matcher — scored by range).
function rankMatches(lead, units, projects = [], limit = 5) {
    const budgetLakhs = parseBudgetLakhs(lead.budget);
    const budgetParsed = budgetLakhs !== null && budgetLakhs > 0;
    const leadBHK = extractBHK(lead.configuration, lead.requirement, lead.property_type);
    const leadTokens = locationTokens(lead.location);
    const leadNode = extractNode(lead.location);
    // 027 Client Profile signals (all optional — absent => neutral scoring).
    const budgetBand = (lead.cp_budget_tag && BUDGET_BANDS[lead.cp_budget_tag]) ? BUDGET_BANDS[lead.cp_budget_tag] : null;
    const leadConfigs = _arr(lead.cp_configuration).map(x => String(x).toLowerCase());
    const leadPoss = _arr(lead.cp_possession_pref).map(x => String(x).toLowerCase());
    // 029 v2 signals (all optional — absent => neutral scoring).
    const leadLayout = lead.cp_layout_pref ? String(lead.cp_layout_pref).toLowerCase() : null;
    const leadFloors = _arr(lead.cp_floor_pref).map(x => String(x).toLowerCase());
    const leadAmenPref = lead.cp_amenities_pref ? String(lead.cp_amenities_pref).toLowerCase() : null;

    let maxCommission = 0;
    for (const u of units) {
        const c = Number(u.commission_rate);
        if (isFinite(c) && c > maxCommission) maxCommission = c;
    }
    for (const p of projects) {
        const c = Number(p.commission_rate);
        if (isFinite(c) && c > maxCommission) maxCommission = c;
    }

    const scored = [];
    let skipped = 0;
    for (const u of units) {
        const price = parsePriceLakhs(u.price_lakhs, u.price_text);
        if (price === null) { skipped++; continue; }
        const unitBHK = extractBHK(u.config);
        const s = scoreUnitParsed({
            priceLakhs: price,
            unitBHK,
            category: u.category ? String(u.category).toLowerCase() : null,
            status: u.status_of_property ? String(u.status_of_property).toLowerCase() : null,
            propertyLocation: u.property_location,
            propertyZone: u.property_zone,
            locality: u.locality,
            commissionRate: Number(u.commission_rate),
            isExclusive: !!u.is_exclusive,
            propertyStructure: u.property_structure ? String(u.property_structure).toLowerCase() : null,
            floorBand: floorBand(u.floor_number),
            hasAmenities: !!u.has_amenities,
        }, { budgetLakhs, budgetParsed, budgetBand, leadBHK, leadTokens, leadNode, leadConfigs, leadPoss,
             leadLayout, leadFloors, leadAmenPref, maxCommission });

        scored.push({
            kind: 'unit',
            confidence: 'exact',
            property_id: u.property_id,
            project_id: u.project_id,
            title: u.title,
            config: u.config,
            price_lakhs: Math.round(price * 10) / 10,
            price_display: null,
            location: u.property_location,
            builder: u.builder,
            score: s.score,
            reasons: s.reasons.filter(r => r.good).slice(0, 3),
            allReasons: s.reasons.slice(0, 3),
            breakdown: s.breakdown,
        });
    }

    // ---- Score PROJECTS (hybrid: range-based) ----
    for (const p of projects) {
        const proj = {
            budgetBands: projectBudgetBands(p.budget_ranges, p.price_range, p.budget_other),
            bhkSet: extractBHKSet(p.property_type),
            categories: new Set([
                ...(p.has_residential ? ['residential'] : []),
                ...(p.has_commercial ? ['commercial'] : []),
            ]),
            statusTags: _arr(p.status_of_property).map(x => String(x).toLowerCase()),
            propertyLocation: p.property_location,
            propertyZone: p.property_zone,
            locality: p.locality,
            propertyStructure: p.property_structure ? String(p.property_structure).toLowerCase() : null,
            hasAmenities: !!p.has_amenities,
            commissionRate: Number(p.commission_rate),
            isExclusive: !!p.is_exclusive,
        };
        const s = scoreProjectParsed(proj, { budgetLakhs, budgetParsed, budgetBand, leadBHK,
            leadTokens, leadNode, leadConfigs, leadPoss, leadLayout, leadAmenPref, maxCommission });
        const priceDisplay = (p.price_range && String(p.price_range).trim())
            ? String(p.price_range).trim()
            : (proj.budgetBands.length ? bandLabel(proj.budgetBands) : (p.budget_other || null));
        scored.push({
            kind: 'project',
            confidence: 'range',
            property_id: null,
            project_id: p.project_id,
            title: p.title,
            config: _arr(p.property_type).join(', ') || null,
            price_lakhs: null,
            price_display: priceDisplay || null,
            location: p.property_location,
            builder: p.builder,
            score: s.score,
            reasons: s.reasons.filter(r => r.good).slice(0, 3),
            allReasons: s.reasons.slice(0, 3),
            breakdown: s.breakdown,
        });
    }

    // ---- Merge, dedup (one representative per project_id), floor, slice ----
    // Sort by score; on a tie an exact UNIT ranks above a range PROJECT.
    scored.sort((a, b) => (b.score - a.score) ||
        ((a.kind === 'unit' ? 0 : 1) - (b.kind === 'unit' ? 0 : 1)));
    // Collapse same-project duplicates: keep the highest-scoring representative of
    // each project_id (a matching unit supersedes its parent project). Standalone
    // units (project_id null, from the 021 decouple) never collapse.
    const seenProject = new Set();
    const deduped = [];
    for (const r of scored) {
        if (r.project_id != null) {
            if (seenProject.has(r.project_id)) continue;
            seenProject.add(r.project_id);
        }
        deduped.push(r);
    }
    // MIN_SCORE floor: below it we show NOTHING (the route/panel renders an explicit
    // empty-state) rather than padding the top-5 with weak non-matches.
    const above = deduped.filter(r => r.score >= MIN_SCORE);

    return {
        results: above.slice(0, limit),
        totalScored: scored.length,
        skippedCount: skipped,
        belowFloorCount: deduped.length - above.length,
        minScore: MIN_SCORE,
        budgetParsed,
        budgetLakhs: budgetParsed ? Math.round(budgetLakhs) : null,
        leadBHK,
        banner: (budgetParsed || budgetBand) ? null
            : 'Lead budget not captured — ranking on location + config only.',
    };
}

module.exports = {
    WEIGHTS,
    parseBudgetLakhs,
    parsePriceLakhs,
    extractBHK,
    floorBand,
    locationTokens,
    scoreLocationSignal,
    scoreUnitParsed,
    scoreProjectParsed,
    parseRangeBand,
    projectBudgetBands,
    extractBHKSet,
    rankMatches,
};
