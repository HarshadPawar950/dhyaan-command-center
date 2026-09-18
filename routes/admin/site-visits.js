// ============================================================
// routes/admin/site-visits.js
// Site Visit Management (Architecture doc Section 3.3)
//
// Mounted at /admin/site-visits (admin-only).
// A lead can have MANY visits. Each links lead + property + exec.
// Delete is APPROVAL-GATED via the approval engine (action: 'site_visit_delete').
// ============================================================

const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { createApprovalTicket } = require('../../middleware/approvalEngine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['scheduled', 'confirmed', 'completed', 'no_show', 'cancelled', 'booked'];

function validMonth(mm) {
  if (!/^\d{4}-\d{2}$/.test(mm || '')) return null;
  const [y, m] = mm.split('-').map(Number);
  return (m >= 1 && m <= 12 && y >= 2000 && y <= 2100) ? mm : null;
}
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Pure: build Monday-start calendar weeks for a month, with each day's visits
// grouped onto it. Leading/trailing padding cells have day=null. Multi-visit
// days carry an array of chips. visits[].d must be 'YYYY-MM-DD' (scheduled day).
function buildCalendarWeeks(year, month, visits) {
  const byDay = {};
  (visits || []).forEach(v => { (byDay[v.d] = byDay[v.d] || []).push(v); });
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();   // 0=Sun..6=Sat
  const pad = (firstDow + 6) % 7;                           // Monday-start lead pad
  const cells = [];
  for (let i = 0; i < pad; i++) cells.push({ day: null, visits: [] });
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, ds, visits: byDay[ds] || [] });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, visits: [] });
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ============================================================
// GET /admin/site-visits  -> list all visits (soft-delete filtered)
// ============================================================
router.get('/', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  try {
    // Conversion (this month), TWO honest lines bracketing reality:
    //  1) module truth   — booked visits / conducted (completed+booked)
    //  2) system x-check  — conducted visits whose lead booked on/after the
    //                       visit (payment paid_at >= scheduled_at); a booking
    //                       BEFORE the visit never counts.
    // 'conducted' = the visit actually happened (status completed OR booked).
    const SYS_BOOKED = `EXISTS (SELECT 1 FROM private.payments p
                                WHERE p.lead_id = mv.lead_id AND p.paid_at >= mv.scheduled_at)`;
    const MONTH_VISITS = `
        SELECT sv.lead_id, sv.scheduled_at, sv.employee_id, sv.status::text AS status
          FROM private.site_visits sv
         WHERE sv.deleted_at IS NULL
           AND sv.scheduled_at >= date_trunc('month', CURRENT_DATE)
           AND sv.scheduled_at <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`;

    // List + both conversion aggregates are independent — run in parallel (FAST!).
    const [result, convRow, perExec] = await Promise.all([
      pool.query(
        `SELECT sv.visit_id, sv.scheduled_at, sv.status, sv.pickup_point,
                sv.outcome_notes, sv.next_action, sv.next_action_date, sv.created_at,
                l.name  AS lead_name,  l.phone AS lead_phone,
                p.title AS property_title,
                e.name  AS exec_name
           FROM private.site_visits sv
           JOIN private.leads l       ON l.lead_id = sv.lead_id
           JOIN private.projects p  ON p.project_id = sv.project_id
           LEFT JOIN private.employees e ON e.employee_id = sv.employee_id
          WHERE sv.deleted_at IS NULL
          ORDER BY sv.scheduled_at DESC`
      ),
      pool.query(
        `WITH mv AS (${MONTH_VISITS})
         SELECT COUNT(*) FILTER (WHERE status IN ('completed','booked'))::int AS conducted,
                COUNT(*) FILTER (WHERE status = 'booked')::int                AS booked,
                COUNT(*) FILTER (WHERE status IN ('completed','booked') AND ${SYS_BOOKED})::int AS sys_booked
           FROM mv`
      ),
      pool.query(
        `WITH mv AS (${MONTH_VISITS})
         SELECT COALESCE(e.name, 'Unassigned') AS exec_name, e.external_id AS exec_code,
                COUNT(*) FILTER (WHERE mv.status IN ('completed','booked'))::int AS conducted,
                COUNT(*) FILTER (WHERE mv.status = 'booked')::int                AS booked
           FROM mv
           LEFT JOIN private.employees e ON e.employee_id = mv.employee_id
          GROUP BY e.name, e.external_id
          ORDER BY conducted DESC, exec_name`
      ),
    ]);
    const cs = convRow.rows[0] || { conducted: 0, booked: 0, sys_booked: 0 };
    const convStats = cs;
    const bookedPct = cs.conducted > 0 ? Math.round(cs.booked / cs.conducted * 100) : 0;        // module truth
    const sysPct    = cs.conducted > 0 ? Math.round(cs.sys_booked / cs.conducted * 100) : 0;     // system x-check

    const flash = req.session.siteVisitsListFlash || null;
    delete req.session.siteVisitsListFlash;

    return res.render('admin/site-visits', {
      pageTitle: 'Site Visits',
      visits: result.rows,
      flash,
      convStats, bookedPct, sysPct, perExec: perExec.rows,
    });
  } catch (err) {
    console.error('[site-visits/list] error:', err);
    req.session.siteVisitsListFlash = { type: 'error', text: 'Something went wrong loading site visits.' };
    return res.redirect('/admin/dashboard');
  }
});

// ============================================================
// GET /admin/site-visits/new  -> schedule form
// ============================================================
router.get('/new', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  try {
    const [leads, properties, employees] = await Promise.all([
      pool.query(`SELECT lead_id, name, phone FROM private.leads
                   WHERE deleted_at IS NULL ORDER BY name`),
      pool.query(`SELECT project_id, title FROM private.projects
                   WHERE deleted_at IS NULL ORDER BY title`),
      pool.query(`SELECT employee_id, name FROM private.employees
                   WHERE status = 'active' ORDER BY name`)
    ]);

    const flash = req.session.siteVisitFormFlash || null;
    delete req.session.siteVisitFormFlash;

    return res.render('admin/site-visit-new', {
      pageTitle: 'Schedule Site Visit',
      leads: leads.rows,
      properties: properties.rows,
      employees: employees.rows,
      flash
    });
  } catch (err) {
    console.error('[site-visits/new form] error:', err);
    req.session.siteVisitsListFlash = { type: 'error', text: 'Something went wrong loading site visits.' };
    return res.redirect('/admin/dashboard');
  }
});

// ============================================================
// POST /admin/site-visits/new  -> create visit
// ============================================================
router.post('/new', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  const { lead_id, project_id, employee_id, scheduled_at, pickup_point } = req.body;

  if (!UUID_RE.test(lead_id || '') || !UUID_RE.test(project_id || '')) {
    req.session.siteVisitFormFlash = { type: 'error', text: 'Please select a valid lead and property.' };
    return res.redirect('/admin/site-visits/new');
  }
  if (!scheduled_at) {
    req.session.siteVisitFormFlash = { type: 'error', text: 'Please pick a date & time for the visit.' };
    return res.redirect('/admin/site-visits/new');
  }

  try {
    await pool.query(
      `INSERT INTO private.site_visits
         (lead_id, project_id, employee_id, scheduled_at, pickup_point, status)
       VALUES ($1, $2, $3, $4, $5, 'scheduled')`,
      [
        lead_id,
        project_id,
        UUID_RE.test(employee_id || '') ? employee_id : null,
        scheduled_at,
        (pickup_point || '').trim() || null
      ]
    );

    req.session.siteVisitsListFlash = { type: 'success', text: 'Site visit scheduled successfully.' };
    return res.redirect('/admin/site-visits');
  } catch (err) {
    console.error('[site-visits/create] error:', err);
    req.session.siteVisitFormFlash = { type: 'error', text: userSafeError(err, 'Could not schedule the visit. Please try again.') };
    return res.redirect('/admin/site-visits/new');
  }
});

// ============================================================
// GET /admin/site-visits/calendar  -> month grid of visits as chips
// MUST be declared BEFORE GET /:id (else '/calendar' matches the :id route).
// ============================================================
router.get('/calendar', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  try {
    const mm = validMonth(req.query.month) || currentMonth();
    const [year, month] = mm.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${mm}-01`;
    const monthEnd = `${mm}-${String(daysInMonth).padStart(2, '0')}`;

    const result = await pool.query(
      `SELECT sv.visit_id, sv.status::text AS status,
              to_char(sv.scheduled_at, 'YYYY-MM-DD') AS d,
              to_char(sv.scheduled_at, 'HH24:MI')    AS t,
              l.name  AS lead_name, p.title AS property_title, e.name AS exec_name
         FROM private.site_visits sv
         JOIN private.leads l       ON l.lead_id = sv.lead_id
         JOIN private.projects p  ON p.project_id = sv.project_id
         LEFT JOIN private.employees e ON e.employee_id = sv.employee_id
        WHERE sv.deleted_at IS NULL
          AND sv.scheduled_at >= $1::date
          AND sv.scheduled_at <  ($2::date + INTERVAL '1 day')
        ORDER BY sv.scheduled_at`,
      [monthStart, monthEnd]
    );

    const weeks = buildCalendarWeeks(year, month, result.rows);
    return res.render('admin/site-visits-calendar', {
      pageTitle: 'Site Visit Calendar',
      month: mm, weeks, totalVisits: result.rows.length,
    });
  } catch (err) {
    console.error('[site-visits/calendar] error:', err);
    req.session.siteVisitsListFlash = { type: 'error', text: 'Could not load the calendar.' };
    return res.redirect('/admin/site-visits');
  }
});

// ============================================================
// GET /admin/site-visits/:id  -> detail + edit form
// ============================================================
router.get('/:id', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  const visitId = req.params.id;
  if (!UUID_RE.test(visitId)) {
    return res.status(404).render('404', { pageTitle: 'Not Found' });
  }

  try {
    const result = await pool.query(
      `SELECT sv.*,
              l.name  AS lead_name,  l.phone AS lead_phone,
              p.title AS property_title,
              e.name  AS exec_name
         FROM private.site_visits sv
         JOIN private.leads l       ON l.lead_id = sv.lead_id
         JOIN private.projects p  ON p.project_id = sv.project_id
         LEFT JOIN private.employees e ON e.employee_id = sv.employee_id
        WHERE sv.visit_id = $1 AND sv.deleted_at IS NULL`,
      [visitId]
    );

    if (result.rows.length === 0) {
      return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const employees = await pool.query(
      `SELECT employee_id, name FROM private.employees WHERE status = 'active' ORDER BY name`
    );

    const flash = req.session.siteVisitDetailFlash || null;
    delete req.session.siteVisitDetailFlash;

    return res.render('admin/site-visit-detail', {
      pageTitle: 'Site Visit Detail',
      visit: result.rows[0],
      employees: employees.rows,
      statuses: VALID_STATUS,
      flash
    });
  } catch (err) {
    console.error('[site-visits/detail] error:', err);
    req.session.siteVisitsListFlash = { type: 'error', text: 'Something went wrong loading site visits.' };
    return res.redirect('/admin/dashboard');
  }
});

// ============================================================
// POST /admin/site-visits/:id/edit  -> update status/outcome/exec
// ============================================================
router.post('/:id/edit', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  const visitId = req.params.id;
  if (!UUID_RE.test(visitId)) {
    return res.status(404).render('404', { pageTitle: 'Not Found' });
  }

  const { status, employee_id, scheduled_at, pickup_point,
          outcome_notes, feedback, next_action, next_action_date } = req.body;

  if (status && !VALID_STATUS.includes(status)) {
    req.session.siteVisitDetailFlash = { type: 'error', text: 'Invalid status value.' };
    return res.redirect(`/admin/site-visits/${visitId}`);
  }

  try {
    await pool.query(
      `UPDATE private.site_visits
          SET status           = COALESCE($1, status),
              employee_id      = $2,
              scheduled_at     = COALESCE($3, scheduled_at),
              pickup_point     = $4,
              outcome_notes    = $5,
              feedback         = $6,
              next_action      = $7,
              next_action_date = $8,
              updated_at       = NOW()
        WHERE visit_id = $9 AND deleted_at IS NULL`,
      [
        status || null,
        UUID_RE.test(employee_id || '') ? employee_id : null,
        scheduled_at || null,
        (pickup_point || '').trim() || null,
        (outcome_notes || '').trim() || null,
        (feedback || '').trim() || null,
        (next_action || '').trim() || null,
        next_action_date || null,
        visitId
      ]
    );

    req.session.siteVisitDetailFlash = { type: 'success', text: 'Site visit updated.' };
    return res.redirect(`/admin/site-visits/${visitId}`);
  } catch (err) {
    console.error('[site-visits/edit] error:', err);
    req.session.siteVisitDetailFlash = { type: 'error', text: userSafeError(err, 'Could not update the visit. Please try again.') };
    return res.redirect(`/admin/site-visits/${visitId}`);
  }
});

// ============================================================
// POST /admin/site-visits/:id/delete  -> APPROVAL-GATED
// Creates a pending ticket; engine soft-deletes on approval.
// ============================================================
router.post('/:id/delete', ensureAdmin, ensurePermission('site_visits.manage'), async (req, res) => {
  const user = req.session.user;
  const visitId = req.params.id;
  const reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();

  if (!UUID_RE.test(visitId)) {
    return res.status(404).render('404', { pageTitle: 'Not Found' });
  }

  try {
    const result = await pool.query(
      `SELECT sv.visit_id, sv.scheduled_at, l.name AS lead_name, p.title AS property_title
         FROM private.site_visits sv
         JOIN private.leads l      ON l.lead_id = sv.lead_id
         JOIN private.projects p ON p.project_id = sv.project_id
        WHERE sv.visit_id = $1 AND sv.deleted_at IS NULL`,
      [visitId]
    );

    if (result.rows.length === 0) {
      req.session.siteVisitsListFlash = { type: 'error', text: 'Site visit not found or already deleted.' };
      return res.redirect('/admin/site-visits');
    }

    const visit = result.rows[0];
    const label = `${visit.lead_name} → ${visit.property_title}`;

    // Don't raise a duplicate ticket.
    const dup = await pool.query(
      `SELECT 1 FROM private.approvals
        WHERE target_table = 'site_visits'
          AND target_id = $1
          AND action_type = 'site_visit_delete'
          AND status = 'pending'`,
      [visitId]
    );

    if (dup.rows.length > 0) {
      req.session.siteVisitsListFlash = { type: 'error', text: `A deletion request for "${label}" is already awaiting Super Admin approval.` };
      return res.redirect('/admin/site-visits');
    }

    await createApprovalTicket({
      actionType: 'site_visit_delete',
      targetTable: 'site_visits',
      targetId: visit.visit_id,
      targetLabel: label,
      requestedBy: user.employee_id || user.id,
      requestedByName: user.name || 'Unknown',
      reason: reason || null,
      oldValue: {
        lead_name: visit.lead_name,
        property_title: visit.property_title,
        scheduled_at: visit.scheduled_at
      },
      newValue: null
    });

    req.session.siteVisitsListFlash = { type: 'success', text: `Deletion request for "${label}" sent to Super Admin for approval. The visit stays until approved.` };
    return res.redirect('/admin/site-visits');
  } catch (err) {
    console.error('[site-visits/delete] error:', err);
    req.session.siteVisitsListFlash = { type: 'error', text: userSafeError(err, 'Could not submit the deletion request. Please try again.') };
    return res.redirect('/admin/site-visits');
  }
});

module.exports = router;
module.exports.buildCalendarWeeks = buildCalendarWeeks;   // exposed for unit tests
