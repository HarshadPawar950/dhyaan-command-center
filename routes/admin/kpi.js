// =====================================================================
// routes/admin/kpi.js — KPI & TARGETS (admin + boss, reports.view)
// Mount: app.use('/admin', adminKpiRoutes)
// Routes:
//   GET /admin/kpi           -> per-exec KPI leaderboard for a month
//   GET /admin/kpi/targets   -> targets editor grid (Phase 4)
//   POST /admin/kpi/targets  -> bulk upsert targets  (Phase 4)
//
// READ-ONLY here. Per-exec actuals aggregated in ONE query set (no N+1):
//   leads assigned  (assignments.assigned_at in month)
//   calls done      (follow_ups outcome='completed', active, created in month)
//   site visits     (site_visits status='completed', active, scheduled in month)
//   bookings/deals  (commission_ledger rows, earned in month)
//   commission      (SUM employee_share, earned in month)
// Compared against private.monthly_targets for that month. Attainment % is
// actual/target, guarded for zero/absent targets. Leaderboard = overall
// attainment desc. All 31 ACTIVE employees appear (per CAPTAIN's ruling).
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { logFromRequest } = require('../../middleware/historyLogger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/kpi] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// Validate a YYYY-MM string -> first-of-month date string, else null.
function monthToFirst(mm) {
    if (!/^\d{4}-\d{2}$/.test(mm)) return null;
    const [y, m] = mm.split('-').map(Number);
    if (m < 1 || m > 12 || y < 2000 || y > 2100) return null;
    return `${mm}-01`;
}

// Current month as YYYY-MM (server local time).
function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Human-staff discriminator. The employees table also holds 25 ROLE-LOGIN-*
// template accounts (CEO/Director, Marketing Manager, ...) used purely for
// role-based logins — they are NOT people and must never appear on the KPI
// roster. Real staff carry an employee number external_id (E000, E002, ...).
// This positive pattern matches every human and excludes every ROLE-LOGIN-*.
const HUMAN_STAFF_SQL = `e.external_id ~ '^E[0-9]'`;

// Default landing month when none is supplied: the latest month that actually
// has lead-assignment activity (so the page opens on real numbers instead of an
// empty current month). Falls back to the current month if assignments is empty.
// Self-correcting — as new months gain assignments, the default advances.
async function defaultMonth() {
    const r = await safe(
        `SELECT to_char(date_trunc('month', MAX(assigned_at)), 'YYYY-MM') AS m
           FROM private.assignments`, [], []
    );
    return (r[0] && r[0].m) ? r[0].m : currentMonth();
}

// Attainment ratio guarded for zero/absent targets: returns null when there is
// no target (so the view shows "—", never Infinity/NaN from a divide-by-zero).
function pct(actual, target) {
    const t = Number(target) || 0;
    if (t <= 0) return null;
    return Math.round((Number(actual) || 0) / t * 100);
}

// ---------------------------------------------------------------------
// GET /admin/kpi — leaderboard for a month
// ---------------------------------------------------------------------
router.get('/kpi', ensureAdmin, ensurePermission('reports.view'), async (req, res) => {
    const mmRaw = (req.query.month || '').trim();
    // Explicit valid month wins; otherwise land on the latest month with activity.
    const mm = monthToFirst(mmRaw) ? mmRaw : await defaultMonth();
    const monthStart = monthToFirst(mm);   // guaranteed valid now

    // ONE query set — per-employee actuals + that month's targets, no N+1.
    const rows = await safe(
        `WITH p AS (
            SELECT $1::date AS m_start, ($1::date + INTERVAL '1 month')::date AS m_end
         ),
         la AS (
            SELECT a.employee_id, COUNT(*)::int AS c
              FROM private.assignments a, p
             WHERE a.assigned_at >= p.m_start AND a.assigned_at < p.m_end
             GROUP BY a.employee_id
         ),
         fu AS (
            SELECT f.employee_id, COUNT(*)::int AS c
              FROM private.follow_ups f, p
             WHERE f.deleted_at IS NULL AND f.outcome = 'completed'
               AND f.created_at >= p.m_start AND f.created_at < p.m_end
             GROUP BY f.employee_id
         ),
         sv AS (
            SELECT s.employee_id, COUNT(*)::int AS c
              FROM private.site_visits s, p
             WHERE s.deleted_at IS NULL AND s.status = 'completed'
               AND s.scheduled_at >= p.m_start AND s.scheduled_at < p.m_end
             GROUP BY s.employee_id
         ),
         cl AS (
            SELECT cl.employee_id,
                   COUNT(*)::int AS deals,
                   COALESCE(SUM(cl.employee_share), 0)::numeric AS earned
              FROM private.commission_ledger cl, p
             WHERE cl.earned_at >= p.m_start AND cl.earned_at < p.m_end
             GROUP BY cl.employee_id
         ),
         tg AS (
            SELECT t.employee_id, t.target_calls, t.target_visits,
                   t.target_bookings, t.target_revenue
              FROM private.monthly_targets t, p
             WHERE t.deleted_at IS NULL AND t.month = p.m_start
         )
         SELECT e.employee_id, e.name, e.role,
                COALESCE(la.c, 0)      AS leads_assigned,
                COALESCE(fu.c, 0)      AS calls_done,
                COALESCE(sv.c, 0)      AS visits_done,
                COALESCE(cl.deals, 0)  AS bookings_done,
                COALESCE(cl.earned, 0)::numeric AS commission_earned,
                tg.target_calls, tg.target_visits, tg.target_bookings, tg.target_revenue,
                (SELECT COUNT(*)::int FROM private.employees se
                  WHERE se.reports_to = e.employee_id
                    AND se.status = 'active'
                    AND se.external_id ~ '^E[0-9]{3,}$'
                    AND se.email NOT LIKE '%@dhyaan.local') AS report_count
           FROM private.employees e
           LEFT JOIN la ON la.employee_id = e.employee_id
           LEFT JOIN fu ON fu.employee_id = e.employee_id
           LEFT JOIN sv ON sv.employee_id = e.employee_id
           LEFT JOIN cl ON cl.employee_id = e.employee_id
           LEFT JOIN tg ON tg.employee_id = e.employee_id
          WHERE e.status = 'active' AND ${HUMAN_STAFF_SQL}
          ORDER BY e.name`,
        [monthStart], []
    );

    // Attainment (guarded) + overall = mean of the components that HAVE a target.
    const execs = rows.map(r => {
        const a = {
            calls:    pct(r.calls_done, r.target_calls),
            visits:   pct(r.visits_done, r.target_visits),
            bookings: pct(r.bookings_done, r.target_bookings),
            revenue:  pct(r.commission_earned, r.target_revenue),
        };
        const present = Object.values(a).filter(v => v !== null);
        const overall = present.length
            ? Math.round(present.reduce((s, v) => s + v, 0) / present.length)
            : null;
        return {
            employee_id: r.employee_id,
            name: r.name,
            role: r.role || '',
            leads_assigned: Number(r.leads_assigned) || 0,
            calls_done: Number(r.calls_done) || 0,
            visits_done: Number(r.visits_done) || 0,
            bookings_done: Number(r.bookings_done) || 0,
            commission_earned: Number(r.commission_earned) || 0,
            target_calls: r.target_calls,
            target_visits: r.target_visits,
            target_bookings: r.target_bookings,
            target_revenue: r.target_revenue,
            att: a,
            overall,
            has_target: present.length > 0,
            report_count: Number(r.report_count) || 0,
        };
    });

    // Leaderboard: attainment desc (execs with any target first, then by name).
    const ranked = [...execs].sort((x, y) => {
        if (x.overall === null && y.overall === null) return x.name.localeCompare(y.name);
        if (x.overall === null) return 1;
        if (y.overall === null) return -1;
        return y.overall - x.overall;
    });

    // Team totals for the header strip.
    const totals = execs.reduce((t, e) => {
        t.calls += e.calls_done; t.visits += e.visits_done;
        t.bookings += e.bookings_done; t.commission += e.commission_earned;
        t.leads += e.leads_assigned;
        return t;
    }, { calls: 0, visits: 0, bookings: 0, commission: 0, leads: 0 });

    res.render('admin/kpi', {
        csrfToken: req.csrfToken(),
        pageTitle: 'KPI & Targets',
        user: req.session.user,
        month: mm,
        monthStart,
        execs: ranked,
        totals,
        execCount: execs.length,
    });
});

// ---------------------------------------------------------------------
// GET /admin/kpi/targets — editable grid of employees x 4 target fields
// ---------------------------------------------------------------------
router.get('/kpi/targets', ensureAdmin, ensurePermission('reports.view'), async (req, res) => {
    const mmRaw = (req.query.month || '').trim();
    const mm = monthToFirst(mmRaw) ? mmRaw : currentMonth();
    const monthStart = monthToFirst(mm);

    const rows = await safe(
        `SELECT e.employee_id, e.name, e.role,
                COALESCE(t.target_calls, 0)    AS target_calls,
                COALESCE(t.target_visits, 0)   AS target_visits,
                COALESCE(t.target_bookings, 0) AS target_bookings,
                COALESCE(t.target_revenue, 0)  AS target_revenue,
                (t.target_id IS NOT NULL)      AS has_target
           FROM private.employees e
           LEFT JOIN private.monthly_targets t
                  ON t.employee_id = e.employee_id
                 AND t.month = $1
                 AND t.deleted_at IS NULL
          WHERE e.status = 'active' AND ${HUMAN_STAFF_SQL}
          ORDER BY e.name`,
        [monthStart], []
    );

    res.render('admin/kpi-targets', {
        csrfToken: req.csrfToken(),
        pageTitle: 'KPI & Targets',
        user: req.session.user,
        month: mm,
        rows,
        messages: { success: req.flash('success'), error: req.flash('error') },
    });
});

// ---------------------------------------------------------------------
// POST /admin/kpi/targets — bulk upsert (ON CONFLICT on the partial unique
// index), SAVEPOINT txn, history_log per CHANGED cell (old -> new).
// Employees are re-queried server-side, so only valid active execs are
// processed (posted keys for anyone else are ignored).
// ---------------------------------------------------------------------
router.post('/kpi/targets', ensureAdmin, ensurePermission('reports.view'), async (req, res) => {
    const mmRaw = (req.body.month || '').trim();
    const mm = monthToFirst(mmRaw) ? mmRaw : null;
    if (!mm) {
        req.flash('error', 'Invalid month — nothing saved.');
        return res.redirect('/admin/kpi/targets');
    }
    const monthStart = monthToFirst(mm);

    const emps = await safe(
        // Human staff only — never upsert targets for ROLE-LOGIN-* template accounts.
        `SELECT employee_id, name FROM private.employees
          WHERE status = 'active' AND external_id ~ '^E[0-9]'`, [], []
    );
    const existingRows = await safe(
        `SELECT employee_id, target_calls, target_visits, target_bookings, target_revenue
           FROM private.monthly_targets WHERE month = $1 AND deleted_at IS NULL`,
        [monthStart], []
    );
    const existing = new Map(existingRows.map(r => [r.employee_id, r]));

    let actorId = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;
    if (actorId && !UUID_RE.test(String(actorId))) actorId = null;   // FK-safe

    const numI = v => Math.max(0, Math.floor(Number(v) || 0));       // ints >= 0
    const numN = v => Math.max(0, Number(v) || 0);                   // numeric >= 0

    const client = await pool.connect();
    let changed = 0;
    const logs = [];
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_targets');

        for (const e of emps) {
            const id = e.employee_id;
            const nc = numI(req.body['t_calls_' + id]);
            const nv = numI(req.body['t_visits_' + id]);
            const nb = numI(req.body['t_bookings_' + id]);
            const nr = numN(req.body['t_revenue_' + id]);

            const old = existing.get(id);
            const oc = old ? Number(old.target_calls) : 0;
            const ov = old ? Number(old.target_visits) : 0;
            const ob = old ? Number(old.target_bookings) : 0;
            const orv = old ? Number(old.target_revenue) : 0;

            const diff = nc !== oc || nv !== ov || nb !== ob || nr !== orv;
            if (!diff) continue;
            // Never create an empty (all-zero) row for someone with no target yet.
            if (!old && nc === 0 && nv === 0 && nb === 0 && nr === 0) continue;

            await client.query(
                `INSERT INTO private.monthly_targets
                        (employee_id, month, target_calls, target_visits, target_bookings, target_revenue, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (employee_id, month) WHERE deleted_at IS NULL
                 DO UPDATE SET target_calls    = EXCLUDED.target_calls,
                               target_visits   = EXCLUDED.target_visits,
                               target_bookings = EXCLUDED.target_bookings,
                               target_revenue  = EXCLUDED.target_revenue,
                               updated_at      = CURRENT_TIMESTAMP`,
                [id, monthStart, nc, nv, nb, nr, actorId]
            );
            changed++;

            const action = old ? 'update' : 'create';
            if (nc !== oc)  logs.push({ id, name: e.name, action, field: 'target_calls',    o: oc,  n: nc });
            if (nv !== ov)  logs.push({ id, name: e.name, action, field: 'target_visits',   o: ov,  n: nv });
            if (nb !== ob)  logs.push({ id, name: e.name, action, field: 'target_bookings', o: ob,  n: nb });
            if (nr !== orv) logs.push({ id, name: e.name, action, field: 'target_revenue',  o: orv, n: nr });
        }

        await client.query('RELEASE SAVEPOINT sp_targets');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/kpi/targets] save failed:', err.message);
        req.flash('error', 'Could not save targets — see server log.');
        return res.redirect('/admin/kpi/targets?month=' + encodeURIComponent(mm));
    } finally {
        client.release();
    }

    // History per changed cell — never blocks the response.
    for (const l of logs) {
        try {
            await logFromRequest(req, {
                entityType: 'monthly_target', entityId: l.id, action: l.action,
                fieldName: l.field, oldValue: l.o, newValue: l.n,
                notes: `KPI target ${mm} — ${l.name}`,
            });
        } catch (e) { /* logging never blocks */ }
    }

    req.flash('success', changed
        ? `Saved targets for ${changed} executive${changed === 1 ? '' : 's'} (${mm}).`
        : `No changes to save (${mm}).`);
    return res.redirect('/admin/kpi/targets?month=' + encodeURIComponent(mm));
});

module.exports = router;
