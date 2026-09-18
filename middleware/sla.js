// =============================================================
// middleware/sla.js — first-touch SLA helpers (C-series)
//
// SLA window is config-driven (private.sla_config.first_touch_hours), NOT
// hardcoded. A lead is SLA-overdue when it is ASSIGNED, the window has elapsed
// since the first assignment, and no follow-up has landed since that assignment
// (no first touch). Unassigned leads are NEVER overdue (a different problem —
// the round-robin handles those).
//
//   getFirstTouchHours(run) -> integer hours (validated, fallback 24)
//   overdueExpr(hoursInt)   -> a boolean SQL fragment for a query that has the
//                              lead aliased `l` and a LATERAL first-assignment
//                              alias `fa.first_at`. hoursInt MUST be the integer
//                              from getFirstTouchHours (inlined, so it must be a
//                              trusted number — never raw user input).
// =============================================================

async function getFirstTouchHours(run) {
    try {
        const r = await run.query(
            `SELECT hours FROM private.sla_config WHERE config_key = 'first_touch_hours' LIMIT 1`
        );
        const h = r.rows.length ? parseInt(r.rows[0].hours, 10) : NaN;
        return Number.isFinite(h) && h > 0 ? h : 24;
    } catch (err) {
        console.error('[sla] config read failed, defaulting to 24h:', err.message);
        return 24;
    }
}

// Trusted integer only (from getFirstTouchHours). Coerced defensively.
function overdueExpr(hoursInt) {
    const h = Number.isFinite(Number(hoursInt)) && Number(hoursInt) > 0 ? Math.floor(Number(hoursInt)) : 24;
    return `(
        fa.first_at IS NOT NULL
        AND NOW() > fa.first_at + make_interval(hours => ${h})
        AND NOT EXISTS (
            SELECT 1 FROM private.follow_ups f
             WHERE f.lead_id = l.lead_id AND f.deleted_at IS NULL
               AND f.created_at >= fa.first_at
        )
    )`;
}

// Standalone LATERAL join clause (first assignment time per lead).
const FIRST_ASSIGN_LATERAL = `
    LEFT JOIN LATERAL (
        SELECT MIN(a.assigned_at) AS first_at
          FROM private.assignments a
         WHERE a.lead_id = l.lead_id
    ) fa ON true`;

module.exports = { getFirstTouchHours, overdueExpr, FIRST_ASSIGN_LATERAL };
