// =============================================================
// middleware/incentive.js — incentive slab compute (JS mirror of the SQL
// used by the Slice-5 auto-accrual). Used for display/preview; the source of
// truth for a persisted entry is still the SQL insert in the txn.
//
//   pickSlab(base, slabs)       -> the matching active slab, or null
//   computeIncentive(base, slabs) -> { rate, amount, slab }
//
// Matching rule (identical to the SQL): active, not-deleted slab where
// base >= min_amount AND (max_amount IS NULL OR base < max_amount); when more
// than one matches, the highest min_amount wins (ORDER BY min_amount DESC).
// amount = ROUND(base * rate / 100, 2).
// =============================================================

function pickSlab(base, slabs) {
    const b = Number(base) || 0;
    const matches = (slabs || []).filter(s =>
        s && s.active && !s.deleted_at &&
        b >= Number(s.min_amount) &&
        (s.max_amount === null || s.max_amount === undefined || b < Number(s.max_amount))
    );
    if (!matches.length) return null;
    return matches.reduce((best, s) => (Number(s.min_amount) > Number(best.min_amount) ? s : best));
}

function computeIncentive(base, slabs) {
    const s = pickSlab(base, slabs);
    if (!s) return { rate: 0, amount: 0, slab: null };
    const rate = Number(s.rate_percent) || 0;
    // round(base * rate) / 100 — algebraically equal to SQL ROUND(base*rate/100, 2)
    // for percent rates; two-decimal money rounding.
    const amount = Math.round((Number(base) || 0) * rate) / 100;
    return { rate, amount, slab: s };
}

module.exports = { pickSlab, computeIncentive };
