// =============================================================
// lib/clientProfile.js — shared Client Profile (migrations 027 + 029) parse +
// persist. Used by lead-new + lead-edit so the two never drift.
// v2 (029): +layout/occupation/amenities_pref/community/floor[]/timeline/
// projects_visited/current_residence/budget_other. Urgency note is REQUIRED
// (min 50 chars) — enforced via cpErrors() in both routes.
// The detailed cp_amenities checklist was retired on the lead side (PART 2);
// its column is deliberately NOT written here so existing values are preserved.
// Stored on private.leads.cp_* columns.
// =============================================================

const URGENCY_MIN = 50;

// A checkbox/multi field -> clean text[] (dedup, drop empties) or null.
function cpArr(v) {
    const a = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    const c = [...new Set(a.map(x => String(x).trim()).filter(Boolean))];
    return c.length ? c : null;
}

// Collect the Client Profile fields off a POST body.
function cpData(body) {
    const b = body || {};
    const s = k => (b[k] == null ? '' : String(b[k])).trim();
    return {
        configuration: cpArr(b.cp_configuration),
        use: s('cp_use'),
        possession_pref: cpArr(b.cp_possession_pref),
        funding: s('cp_funding'),
        down_payment: s('cp_down_payment'),
        budget_tag: s('cp_budget_tag'),
        budget_other: s('cp_budget_other'),
        visit_pref: s('cp_visit_pref'),
        urgency_note: s('cp_urgency_note'),
        // v2 (029)
        layout_pref: s('cp_layout_pref'),
        occupation: s('cp_occupation'),
        amenities_pref: s('cp_amenities_pref'),
        community_pref: s('cp_community_pref'),
        floor_pref: cpArr(b.cp_floor_pref),
        purchase_timeline: s('cp_purchase_timeline'),
        projects_visited: s('cp_projects_visited'),
        current_residence: s('cp_current_residence'),
    };
}

// Server-side validation for the Client Profile. Returns a string[] of errors.
// The urgency note is the discipline field: every lead must carry a real one.
function cpErrors(body) {
    const errs = [];
    const urgency = ((body && body.cp_urgency_note) || '').trim();
    if (urgency.length < URGENCY_MIN) {
        errs.push('Urgency notes are required and must be at least ' + URGENCY_MIN +
            ' characters (currently ' + urgency.length + ') — write a real urgency note.');
    }
    return errs;
}

// Persist Client Profile onto a lead, on its OWN statement so the source-enum
// retry in the caller can never drop these. Runs inside the caller's txn.
// NOTE: cp_amenities is intentionally NOT set here — the lead-side checklist was
// retired (PART 2); leaving it out preserves any historical values.
async function saveClientProfile(client, cp, leadId) {
    await client.query(
        `UPDATE private.leads SET
            cp_configuration = $1::text[], cp_use = NULLIF($2,''),
            cp_possession_pref = $3::text[], cp_funding = NULLIF($4,''),
            cp_down_payment = NULLIF($5,'')::numeric, cp_budget_tag = NULLIF($6,''),
            cp_budget_other = NULLIF($7,''), cp_visit_pref = NULLIF($8,''),
            cp_urgency_note = NULLIF($9,''),
            cp_layout_pref = NULLIF($10,''), cp_occupation = NULLIF($11,''),
            cp_amenities_pref = NULLIF($12,''), cp_community_pref = NULLIF($13,''),
            cp_floor_pref = $14::text[], cp_purchase_timeline = NULLIF($15,''),
            cp_projects_visited = NULLIF($16,''), cp_current_residence = NULLIF($17,'')
          WHERE lead_id = $18 AND deleted_at IS NULL`,
        [cp.configuration, cp.use, cp.possession_pref, cp.funding, cp.down_payment,
         cp.budget_tag, cp.budget_other, cp.visit_pref, cp.urgency_note,
         cp.layout_pref, cp.occupation, cp.amenities_pref, cp.community_pref,
         cp.floor_pref, cp.purchase_timeline, cp.projects_visited, cp.current_residence,
         leadId]
    );
}

// Read-side: pull cp_* off a lead row into formData shape for the shared form.
function cpFormData(lead) {
    return {
        cp_configuration: lead.cp_configuration || [],
        cp_use: lead.cp_use || '',
        cp_possession_pref: lead.cp_possession_pref || [],
        cp_funding: lead.cp_funding || '',
        cp_down_payment: lead.cp_down_payment != null ? String(lead.cp_down_payment) : '',
        cp_budget_tag: lead.cp_budget_tag || '',
        cp_budget_other: lead.cp_budget_other || '',
        cp_visit_pref: lead.cp_visit_pref || '',
        cp_urgency_note: lead.cp_urgency_note || '',
        // v2 (029)
        cp_layout_pref: lead.cp_layout_pref || '',
        cp_occupation: lead.cp_occupation || '',
        cp_amenities_pref: lead.cp_amenities_pref || '',
        cp_community_pref: lead.cp_community_pref || '',
        cp_floor_pref: lead.cp_floor_pref || [],
        cp_purchase_timeline: lead.cp_purchase_timeline || '',
        cp_projects_visited: lead.cp_projects_visited || '',
        cp_current_residence: lead.cp_current_residence || '',
    };
}

// Echo raw cp_* POST values back into formData shape, so a failed submit
// (e.g. urgency < 50 chars) re-renders the form WITHOUT wiping the profile.
function cpEcho(body) {
    const b = body || {};
    const keys = ['cp_configuration', 'cp_use', 'cp_possession_pref', 'cp_funding',
        'cp_down_payment', 'cp_budget_tag', 'cp_budget_other', 'cp_visit_pref',
        'cp_urgency_note', 'cp_layout_pref', 'cp_occupation', 'cp_amenities_pref',
        'cp_community_pref', 'cp_floor_pref', 'cp_purchase_timeline',
        'cp_projects_visited', 'cp_current_residence'];
    const out = {};
    keys.forEach(k => { if (b[k] !== undefined) out[k] = b[k]; });
    return out;
}

module.exports = { cpArr, cpData, cpErrors, cpEcho, saveClientProfile, cpFormData, URGENCY_MIN };
