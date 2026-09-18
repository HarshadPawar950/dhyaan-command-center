// =============================================================
// lib/nodes.js — Navi Mumbai NODE list + extraction (Property Matcher).
//
// WHY: prod project rows leave `area_zone` empty, but `location`/`locality` are
// rich free-text ("Sector-34C, Kharghar, Navi Mumbai"). Matching on raw ≥3-char
// tokens full-credited the city-wide noise ("navi","mumbai") that sits in nearly
// EVERY row, so location stopped discriminating and a Nerul project tied a
// Kharghar one on a Kharghar lead. Extracting the NODE fixes that precisely:
// "Navi Mumbai" is not a node, so it never counts; multi-word nodes
// ("Kopar Khairane") match as a phrase; a stray shared token (a builder name,
// "world", "tower") can't fake a location hit.
//
// PURE DATA + PURE FUNCTIONS — no DB, no I/O (safe to require from lib/matcher's
// "no I/O" scorer, same contract as lib/budgetBuckets.js). The node list is DATA:
// add a node here, no scorer change needed.
// =============================================================

// Canonical Navi Mumbai / MMR nodes our inventory actually sits in (CAPTAIN
// ruling 2026-08-22). Longest phrases matched first so "Kopar Khairane" wins
// over any single-word overlap. Extend freely — order does not matter here, the
// matcher sorts by length at match time. This is DATA: add a node, no scorer change.
const NODES = Object.freeze([
    // multi-word first (readability only; match sorts by length anyway)
    'kopar khairane', 'mira road',
    // Navi Mumbai proper
    'kharghar', 'nerul', 'vashi', 'sanpada', 'panvel', 'ulwe', 'dronagiri',
    'taloja', 'kamothe', 'kalamboli', 'airoli', 'ghansoli', 'turbhe',
    'belapur', 'seawoods', 'juinagar', 'rabale', 'mahape', 'karanjade',
    'roadpali', 'khandeshwar', 'kharkopar', 'digha', 'uran', 'sewri',
    // wider MMR — Birla Taranya (Thane), Sai World Dreams (Dombivli), etc.
    'thane', 'dombivli', 'kalyan', 'shilphata', 'badlapur', 'ambernath',
    'bhiwandi',
]);

// alias (as it may appear in the string) -> canonical node above.
const ALIASES = Object.freeze({
    'koparkhairane': 'kopar khairane',
    'kopar-khairane': 'kopar khairane',
    'cbd': 'belapur',
    'cbd-belapur': 'belapur',
    'cbd belapur': 'belapur',        // CAPTAIN: "CBD Belapur" -> Belapur
    'sea woods': 'seawoods',
    'sea-woods': 'seawoods',
    'new panvel': 'panvel',
    'old panvel': 'panvel',
    'miraroad': 'mira road',
    'dombivali': 'dombivli',         // common spelling variants
    'dombivili': 'dombivli',
});

// City-wide / structural NOISE — stripped before any token compare so a real
// locality can never be outranked by a city-wide one (the token-fallback tier).
const STOPWORDS = Object.freeze(new Set([
    'navi', 'mumbai', 'maharashtra', 'india', 'sector', 'plot', 'near',
    'opp', 'opposite', 'behind', 'next', 'road', 'node', 'the', 'and',
    'nr', 'no', 'tal', 'dist', 'taluka', 'district', 'phase', 'wing',
]));

// Match candidates sorted longest-first (phrases before single words), each
// mapped to its canonical node. Built once at module load.
const _CANDIDATES = (() => {
    const pairs = [];
    for (const [alias, canon] of Object.entries(ALIASES)) pairs.push([alias, canon]);
    for (const n of NODES) pairs.push([n, n]);
    return pairs.sort((a, b) => b[0].length - a[0].length);
})();

// Normalise to " token token " so phrase/word matches are boundary-safe:
// "Plot No. 57, Sector-35E, Kharghar, Navi Mumbai" -> " plot no 57 sector 35e kharghar navi mumbai "
function _norm(s) {
    return ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

// Return the canonical node found in a free-text location string, or null.
// Phrase-aware and boundary-safe (won't match "belapur" inside a longer word).
function extractNode(str) {
    if (!str) return null;
    const hay = _norm(str);
    for (const [needle, canon] of _CANDIDATES) {
        if (hay.includes(' ' + needle + ' ')) return canon;
    }
    return null;
}

// Meaningful location tokens: lowercased, ≥3 chars, NOT a stopword. Used for the
// weak "same area" fallback tier when neither side yields a known node.
function meaningfulTokens(loc) {
    if (!loc) return [];
    return String(loc).toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// "kopar khairane" -> "Kopar Khairane" for reason labels.
function nodeLabel(node) {
    return String(node || '').replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { NODES, ALIASES, STOPWORDS, extractNode, meaningfulTokens, nodeLabel };
