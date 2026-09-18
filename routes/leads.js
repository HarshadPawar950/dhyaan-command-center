// =============================================================
// routes/leads.js — Employee "My Leads"
// Day 7: soft-delete aware (deleted_at IS NULL filter added)
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { sealEmployeeWorld } = require('../middleware/sealEmployeeWorld');
const { homeFor, backFor } = require('../lib/navHome');
const { can } = require('../middleware/permissions');
const { runMatches } = require('../middleware/matcherService');

// Team set for a manager: active REAL humans (E[0-9]{3,}) whose reports_to = him.
// Depth-1 only. Role-logins excluded. `idx` = the $N param carrying the
// manager's employee_id, so this subquery composes into either query safely.
const teamSubquery = (idx) => `
  SELECT employee_id FROM private.employees
   WHERE reports_to = $${idx}
     AND status = 'active'::private.employee_status
     AND external_id ~ '^E[0-9]{3,}$'
     AND email NOT LIKE '%@dhyaan.local'
`;

// List leads assigned to the employee. If the employee holds leads.view_team
// (via a fine role), the list expands to own + team's, deduped and sectioned.
router.get('/', ensureAuthenticated, sealEmployeeWorld, async (req, res) => {
  try {
    const employeeId = req.session.user.id;
    const seesTeam = await can(req.session.user, 'leads.view_team', req);

    let result;
    if (seesTeam) {
      // own + team, one row per lead (DISTINCT ON), "mine" winning ties so a
      // lead assigned to both me and a teammate shows once as mine.
      const query = `
        SELECT * FROM (
          SELECT DISTINCT ON (l.lead_id)
                 l.*,
                 (a.employee_id = $1) AS is_mine,
                 oe.external_id       AS owner_code,
                 oe.name              AS owner_name
            FROM private.leads l
            JOIN private.assignments a  ON a.lead_id = l.lead_id
            JOIN private.employees  oe  ON oe.employee_id = a.employee_id
           WHERE l.deleted_at IS NULL
             AND ( a.employee_id = $1 OR a.employee_id IN (${teamSubquery(1)}) )
           ORDER BY l.lead_id, (a.employee_id = $1) DESC, a.assigned_at DESC
        ) t
        ORDER BY t.is_mine DESC, t.created_at DESC
      `;
      result = await pool.query(query, [employeeId]);
    } else {
      // Unchanged own-only surface — byte-identical to pre-team behaviour.
      const query = `
        SELECT l.*
          FROM private.leads l
          JOIN private.assignments a ON a.lead_id = l.lead_id
         WHERE a.employee_id = $1
           AND l.deleted_at IS NULL
         ORDER BY l.created_at DESC
      `;
      result = await pool.query(query, [employeeId]);
    }

    res.render('leads', {
      pageTitle: 'My Leads',
      leads: result.rows,
      seesTeam
    });
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error fetching leads');
    res.redirect(homeFor(req.session.user));
  }
});

// View single lead details
router.get('/:id', ensureAuthenticated, sealEmployeeWorld, async (req, res) => {
  try {
    const leadId = req.params.id;
    const employeeId = req.session.user.id;
    const seesTeam = await can(req.session.user, 'leads.view_team', req);

    // Ensure the lead is assigned to this employee (or, with view_team, to one
    // of their depth-1 team members) AND not soft-deleted.
    const checkQuery = seesTeam
      ? `
      SELECT l.* FROM private.leads l
      JOIN private.assignments a ON a.lead_id = l.lead_id
      WHERE l.lead_id = $1
        AND ( a.employee_id = $2 OR a.employee_id IN (${teamSubquery(2)}) )
        AND l.deleted_at IS NULL
      LIMIT 1
    `
      : `
      SELECT l.* FROM private.leads l
      JOIN private.assignments a ON a.lead_id = l.lead_id
      WHERE l.lead_id = $1
        AND a.employee_id = $2
        AND l.deleted_at IS NULL
    `;
    const result = await pool.query(checkQuery, [leadId, employeeId]);

    if (result.rows.length === 0) {
      req.flash('error_msg', 'Lead not found or unauthorized');
      return res.redirect(backFor(req.session.user, 'leads'));
    }

    const lead = result.rows[0];

    // Get feedback for this lead
    const feedbackQuery = `
      SELECT * FROM private.feedback WHERE lead_id = $1 ORDER BY created_at DESC
    `;
    const feedbackResult = await pool.query(feedbackQuery, [leadId]);

    res.render('lead_details', {
      pageTitle: 'Lead Details',
      lead: lead,
      feedbacks: feedbackResult.rows
    });

  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error fetching lead details');
    res.redirect(backFor(req.session.user, 'leads'));
  }
});

// GET /leads/:id/matches — deterministic property suggestions (JSON), gated
// to leads this employee owns (or, with view_team, their depth-1 team's).
router.get('/:id/matches', ensureAuthenticated, async (req, res) => {
  try {
    const leadId = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    const employeeId = req.session.user.id;
    const seesTeam = await can(req.session.user, 'leads.view_team', req);

    const checkQuery = seesTeam
      ? `SELECT l.* FROM private.leads l
           JOIN private.assignments a ON a.lead_id = l.lead_id
          WHERE l.lead_id = $1
            AND ( a.employee_id = $2 OR a.employee_id IN (${teamSubquery(2)}) )
            AND l.deleted_at IS NULL
          LIMIT 1`
      : `SELECT l.* FROM private.leads l
           JOIN private.assignments a ON a.lead_id = l.lead_id
          WHERE l.lead_id = $1 AND a.employee_id = $2 AND l.deleted_at IS NULL
          LIMIT 1`;
    const result = await pool.query(checkQuery, [leadId, employeeId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const out = await runMatches(result.rows[0], req);
    res.json(out);
  } catch (err) {
    console.error('[leads] matcher failed:', err.message);
    res.status(500).json({ error: 'Matcher unavailable' });
  }
});

module.exports = router;
