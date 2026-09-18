// =============================================================
// lib/budgetBuckets.js — canonical price brackets.
//
// ONE source of truth, shared by:
//   * the project budget_ranges TAG (lib/projectSheet.js Group 2 field)
//   * the /admin/projects budget FILTER (routes/admin/projects.js)
// so the thing you tag a project with is the exact same key you filter on.
//
// keys: 50-100 / 100-150 / 150-200 / 250-300 / 300plus / other
// (min/max are in LAKHS — kept for any numeric use; the filter now matches
//  on the tag array, not unit prices.)
// =============================================================
const BUDGET_BUCKETS = [
    { key: '50-100',  label: '50L – 1Cr',   min: 50,  max: 100  },
    { key: '100-150', label: '1Cr – 1.5Cr', min: 100, max: 150  },
    { key: '150-200', label: '1.5Cr – 2Cr', min: 150, max: 200  },
    { key: '250-300', label: '2.5Cr – 3Cr', min: 250, max: 300  },
    { key: '300plus', label: '3Cr+',        min: 300, max: null  },
    { key: 'other',   label: 'Other',       other: true          },
];
const BUDGET_BUCKET_KEYS = new Set(BUDGET_BUCKETS.map(b => b.key));
function bucketLabel(k) { const b = BUDGET_BUCKETS.find(x => x.key === k); return b ? b.label : k; }

module.exports = { BUDGET_BUCKETS, BUDGET_BUCKET_KEYS, bucketLabel };
