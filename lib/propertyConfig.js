// =============================================================
// lib/propertyConfig.js — canonical unit-configuration checklist (Δ2).
// Single source of truth shared by the property forms + the write routes so
// the checkbox set, storage order, and validation never drift apart.
// Stored in private.projects.bhk_config (text[]).
// =============================================================

const BHK_OPTIONS = ['1BHK', '2BHK', '3BHK', '4BHK+', 'Shop', 'Office'];

// Normalise checkbox input (undefined | string | string[]) into a clean array
// of ONLY allowed values, in canonical order (dedup + whitelist).
function normalizeBhk(input) {
    let arr = [];
    if (Array.isArray(input)) arr = input;
    else if (typeof input === 'string' && input.trim()) arr = [input];
    const picked = new Set(arr.map(s => String(s).trim()));
    return BHK_OPTIONS.filter(o => picked.has(o));
}

module.exports = { BHK_OPTIONS, normalizeBhk };
