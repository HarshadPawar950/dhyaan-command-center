// =============================================================
// middleware/leadAssignment.js — lead intake helpers (C-series)
//
// Shared by /leads/new and /walkins so dedup + round-robin behave identically.
//
//   normalizePhone(phone)          — JS mirror of leads.normalized_phone
//                                     (last 10 digits, else null).
//   findActiveDuplicate(run, np)   — an ACTIVE lead with the same normalized
//                                     phone + its current owner, or null.
//                                     (Soft-deleted leads never block — C0 lock.)
//   eligibleExecs(run)             — the LOCKED round-robin set, ordered.
//   roundRobinPick(client)         — next eligible exec via the singleton
//                                     pointer; advances the cursor. null if the
//                                     eligible set is empty. MUST run inside the
//                                     caller's txn so pick + assign are atomic.
//
// Round-robin eligible set is the C0 lock, verbatim:
//   access_role = 'employee' AND external_id ~ '^E[0-9]{3,}$' AND status='active'
// =============================================================

// Ordered eligible set. FOR UPDATE is added by roundRobinPick's pointer read,
// not here (this list itself needs no lock).
const ELIGIBLE_SQL = `
    SELECT employee_id, external_id, name
      FROM private.employees
     WHERE access_role = 'employee'
       AND external_id ~ '^E[0-9]{3,}$'
       AND email NOT LIKE '%@dhyaan.local'
       AND status = 'active'
     ORDER BY external_id`;

// last-10-digits, mirrors the SQL generated column exactly.
function normalizePhone(phone) {
    const digits = String(phone == null ? '' : phone).replace(/[^0-9]/g, '');
    const last10 = digits.slice(-10);
    return last10.length ? last10 : null;
}

async function eligibleExecs(run) {
    const r = await run.query(ELIGIBLE_SQL);
    return r.rows;
}

// Existing ACTIVE lead with the same normalized phone + current owner (latest
// assignment). Returns null when there's no active duplicate.
async function findActiveDuplicate(run, normalizedPhone) {
    if (!normalizedPhone) return null;
    const r = await run.query(
        `SELECT l.lead_id, l.external_id, l.name, l.phone,
                l.status::text AS status, l.created_at,
                e.name AS owner_name, e.external_id AS owner_code
           FROM private.leads l
           LEFT JOIN LATERAL (
                SELECT a.employee_id
                  FROM private.assignments a
                 WHERE a.lead_id = l.lead_id
                 ORDER BY a.assigned_at DESC
                 LIMIT 1
           ) la ON true
           LEFT JOIN private.employees e ON e.employee_id = la.employee_id
          WHERE l.deleted_at IS NULL
            AND l.normalized_phone = $1
          ORDER BY l.created_at DESC
          LIMIT 1`,
        [normalizedPhone]
    );
    return r.rows.length ? r.rows[0] : null;
}

// Round-robin pick using the singleton pointer. Row-locks the pointer so
// concurrent intakes serialize (no two leads to the same exec by a race).
// Returns { employeeId, externalId, name } or null when nobody is eligible.
async function roundRobinPick(client) {
    const execs = (await client.query(ELIGIBLE_SQL)).rows;
    if (execs.length === 0) return null;

    const ptr = await client.query(
        `SELECT last_employee_id
           FROM private.assignment_pointer
          WHERE id = true
          FOR UPDATE`
    );
    const last = ptr.rows.length ? ptr.rows[0].last_employee_id : null;

    let idx = -1;
    if (last) idx = execs.findIndex(e => e.employee_id === last);
    const next = execs[(idx + 1) % execs.length];   // advance, wrap around

    await client.query(
        `UPDATE private.assignment_pointer
            SET last_employee_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = true`,
        [next.employee_id]
    );
    return { employeeId: next.employee_id, externalId: next.external_id, name: next.name };
}

module.exports = {
    ELIGIBLE_SQL, normalizePhone, eligibleExecs, findActiveDuplicate, roundRobinPick,
};
