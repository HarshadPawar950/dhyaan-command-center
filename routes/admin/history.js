// =============================================================
// routes/admin/history.js
// Day 3 — Change History (audit trail viewer)
//
// Routes:
//   GET /admin/history       → full audit log with filters
//
// Reads from: private.history_log (created Day 1)
//   Columns: id, entity_type, entity_id, action, field_name,
//            old_value, new_value, changed_by_code, changed_by_name,
//            changed_by_role, ip_address, user_agent, notes, created_at
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/history] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 140).replace(/\s+/g, ' '));
        return fallback;
    }
}

// =============================================================
// GET /admin/history
//
// Query params:
//   ?entity=lead | employee | property | login | logout
//   ?action=assign | update | create | login
//   ?actor=E003     (filter by employee code who did the action)
//   ?q=text         (search notes / field_name / values)
//   ?days=7         (date range, default 30)
// =============================================================
router.get('/history', ensureAdmin, ensurePermission('reports.view'), async (req, res) => {

    const f = {
        entity: (req.query.entity || '').trim().toLowerCase(),
        action: (req.query.action || '').trim().toLowerCase(),
        actor:  (req.query.actor  || '').trim(),
        q:      (req.query.q      || '').trim(),
        days:   parseInt(req.query.days || '30', 10) || 30,
    };

    // Clamp days range
    if (f.days < 1) f.days = 1;
    if (f.days > 365) f.days = 365;

    const conds = [`h.created_at >= NOW() - INTERVAL '${f.days} days'`];
    const params = [];
    let i = 1;

    if (f.entity) {
        conds.push(`LOWER(COALESCE(h.entity_type, '')) = $${i++}`);
        params.push(f.entity);
    }
    if (f.action) {
        conds.push(`LOWER(COALESCE(h.action, '')) = $${i++}`);
        params.push(f.action);
    }
    if (f.actor) {
        conds.push(`COALESCE(h.changed_by_code, '') = $${i++}`);
        params.push(f.actor);
    }
    if (f.q) {
        conds.push(`(
            LOWER(COALESCE(h.notes, ''))         LIKE $${i}
         OR LOWER(COALESCE(h.field_name, ''))    LIKE $${i}
         OR LOWER(COALESCE(h.old_value, ''))     LIKE $${i}
         OR LOWER(COALESCE(h.new_value, ''))     LIKE $${i}
         OR LOWER(COALESCE(h.entity_id, ''))     LIKE $${i}
        )`);
        params.push('%' + f.q.toLowerCase() + '%');
        i++;
    }

    const whereClause = 'WHERE ' + conds.join(' AND ');

    const entries = await safe(
        `SELECT h.id,
                COALESCE(h.entity_type, '')       AS entity_type,
                COALESCE(h.entity_id, '')         AS entity_id,
                COALESCE(h.action, '')            AS action,
                COALESCE(h.field_name, '')        AS field_name,
                COALESCE(h.old_value, '')         AS old_value,
                COALESCE(h.new_value, '')         AS new_value,
                COALESCE(h.changed_by_code, '')   AS changed_by_code,
                COALESCE(h.changed_by_name, '')   AS changed_by_name,
                COALESCE(h.changed_by_role, '')   AS changed_by_role,
                COALESCE(h.notes, '')             AS notes,
                COALESCE(h.ip_address::text, '')  AS ip_address,
                h.created_at
           FROM private.history_log h
           ${whereClause}
       ORDER BY h.created_at DESC
          LIMIT 500`,
        params,
        []
    );

    // Stats: total entries in current range + distribution
    const stats = await safe(
        `SELECT
             (SELECT COUNT(*)::int FROM private.history_log) AS total_all_time,
             (SELECT COUNT(*)::int FROM private.history_log
                WHERE created_at >= NOW() - INTERVAL '${f.days} days') AS in_range,
             (SELECT COUNT(*)::int FROM private.history_log
                WHERE created_at >= NOW() - INTERVAL '1 day') AS last_24h,
             (SELECT COUNT(DISTINCT changed_by_code)::int FROM private.history_log
                WHERE created_at >= NOW() - INTERVAL '${f.days} days') AS distinct_actors`,
        [],
        [{ total_all_time: 0, in_range: 0, last_24h: 0, distinct_actors: 0 }]
    );

    // Filter dropdown values
    const entityTypes = await safe(
        `SELECT DISTINCT entity_type FROM private.history_log
          WHERE entity_type IS NOT NULL AND entity_type <> ''
       ORDER BY entity_type`,
        [], []
    );
    const actions = await safe(
        `SELECT DISTINCT action FROM private.history_log
          WHERE action IS NOT NULL AND action <> ''
       ORDER BY action`,
        [], []
    );
    const actors = await safe(
        `SELECT DISTINCT changed_by_code, changed_by_name FROM private.history_log
          WHERE changed_by_code IS NOT NULL AND changed_by_code <> ''
       ORDER BY changed_by_name`,
        [], []
    );

    res.render('admin/history', {
        pageTitle: 'Change History',
        user: req.session.user,
        entries,
        stats: stats[0],
        filters: f,
        entityTypes: entityTypes.map(r => r.entity_type),
        actions: actions.map(r => r.action),
        actors,
        showing: entries.length,
    });
});

module.exports = router;
