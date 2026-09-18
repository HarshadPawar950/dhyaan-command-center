// =====================================================================
// routes/admin/lead-scoring.js — LEAD SCORING + SLA (boss-only)
// Mount: app.use('/admin', adminLeadScoringRoutes)
// Routes:
//   GET /admin/lead-scoring  -> read-only scored lead list + SLA health
//
// READ-ONLY. Computed-live (no schema change). Score 0-100 from:
//   status (max 35) + closure_probability*0.25 (max 25)
//   + budget tier (max 25) + source quality (max 15)
// SLA buckets on next_action_date: breached / due today / on track / no action.
// budget is TEXT and often blank/"ND" -> parsed safely, unparseable = 0.
// closure_probability is 0-100 scale -> scaled *0.25.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/lead-scoring] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// ---------------------------------------------------------------------
// Shared scoring + SLA SQL fragments (kept identical across queries)
// ---------------------------------------------------------------------
// Budget parser: pull first number from text, multiply by Cr/Lakh unit.
// Mirrors the proven Hot Pipeline CASE logic.
const BUDGET_VALUE = `
    CASE
        WHEN budget IS NULL OR btrim(budget) = '' THEN 0
        WHEN budget ~* 'cr'   THEN COALESCE(NULLIF(regexp_replace(budget, '[^0-9.]', '', 'g'), '')::numeric, 0) * 10000000
        WHEN budget ~* 'lakh' OR budget ~* 'lac' OR budget ~* '\\mL\\M'
                              THEN COALESCE(NULLIF(regexp_replace(budget, '[^0-9.]', '', 'g'), '')::numeric, 0) * 100000
        ELSE COALESCE(NULLIF(regexp_replace(budget, '[^0-9.]', '', 'g'), '')::numeric, 0)
    END`;

const SCORE_SQL = `
    (
        -- status weight (max 35)
        CASE status
            WHEN 'hot' THEN 35
            WHEN 'converted' THEN 35
            WHEN 'warm' THEN 22
            WHEN 'cold' THEN 8
            ELSE 0
        END
        -- closure probability (0-100) scaled to max 25
        + LEAST(25, COALESCE(closure_probability, 0) * 0.25)
        -- budget tier (max 25)
        + CASE
            WHEN (${BUDGET_VALUE}) >= 10000000 THEN 25
            WHEN (${BUDGET_VALUE}) >= 5000000  THEN 18
            WHEN (${BUDGET_VALUE}) >= 2500000  THEN 12
            WHEN (${BUDGET_VALUE}) > 0         THEN 6
            ELSE 0
          END
        -- source quality (max 15)
        + CASE source
            WHEN 'referral' THEN 15
            WHEN 'walk_in' THEN 13
            WHEN 'website' THEN 10
            WHEN 'campaign' THEN 9
            WHEN 'social_media' THEN 7
            ELSE 4
          END
    )`;

const SLA_SQL = `
    CASE
        WHEN status IN ('converted', 'lost') THEN 'closed'
        WHEN next_action_date IS NULL THEN 'no_action'
        WHEN next_action_date < CURRENT_DATE THEN 'breached'
        WHEN next_action_date = CURRENT_DATE THEN 'due_today'
        ELSE 'on_track'
    END`;

// ---------------------------------------------------------------------
// DASHBOARD (read-only)
// ---------------------------------------------------------------------
router.get('/lead-scoring', ensureSuperAdmin, async (req, res) => {

    // ---- Scored lead list (top first) ----
    const leads = await safe(
        `SELECT lead_id, name, phone, status, source, budget,
                closure_probability, next_action, next_action_date,
                ROUND(${SCORE_SQL})::int AS score,
                ${SLA_SQL} AS sla
           FROM private.leads
          WHERE deleted_at IS NULL
            AND status NOT IN ('converted', 'lost')
          ORDER BY score DESC, next_action_date ASC NULLS LAST
          LIMIT 50`,
        [], []
    );

    // ---- Score band counts ----
    const bandsRow = await safe(
        `SELECT
            COUNT(*) FILTER (WHERE s >= 70)::int               AS hot_band,
            COUNT(*) FILTER (WHERE s >= 40 AND s < 70)::int    AS warm_band,
            COUNT(*) FILTER (WHERE s < 40)::int                AS cold_band,
            COALESCE(ROUND(AVG(s)), 0)::int                    AS avg_score
         FROM (
            SELECT ROUND(${SCORE_SQL})::int AS s
              FROM private.leads
             WHERE deleted_at IS NULL AND status NOT IN ('converted','lost')
         ) q`,
        [], [{ hot_band: 0, warm_band: 0, cold_band: 0, avg_score: 0 }]
    );
    const bands = bandsRow[0];

    // ---- SLA bucket counts ----
    const slaRow = await safe(
        `SELECT
            COUNT(*) FILTER (WHERE sla = 'breached')::int  AS breached,
            COUNT(*) FILTER (WHERE sla = 'due_today')::int AS due_today,
            COUNT(*) FILTER (WHERE sla = 'on_track')::int  AS on_track,
            COUNT(*) FILTER (WHERE sla = 'no_action')::int AS no_action
         FROM (
            SELECT ${SLA_SQL} AS sla
              FROM private.leads
             WHERE deleted_at IS NULL AND status NOT IN ('converted','lost')
         ) q`,
        [], [{ breached: 0, due_today: 0, on_track: 0, no_action: 0 }]
    );
    const sla = slaRow[0];

    res.render('admin/lead-scoring', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Lead Scoring & SLA',
        user: req.session.user,
        leads,
        bands,
        sla
    });
});

module.exports = router;
