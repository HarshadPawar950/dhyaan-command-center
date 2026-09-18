// =====================================================================
// routes/hr.js  —  HR Manager Console
// Mount: app.use('/hr', require('./routes/hr'))
// Gated by ensureRole('hr_manager') — HR Manager + admin/super_admin only.
//
//   GET /hr , /hr/dashboard  -> real headcount KPIs + recent joiners + by-role
//   GET /hr/employees        -> live employee directory (read-only)
//   GET /hr/recruitment|onboarding|exits|grievances -> workflow workspaces
//
// All staff queries EXCLUDE the generated role-login accounts
// (external_id LIKE 'ROLE-LOGIN-%') so HR sees only real people.
// Read-only; renderPartial pattern (HR layout).
// =====================================================================

const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const pool = require('../db');
const { ensureRole } = require('../middleware/roleGate');

const ensureHr = ensureRole('hr_manager', 'HR Manager');

// only real staff — hide system role-logins
const REAL_STAFF = `COALESCE(external_id,'') NOT LIKE 'ROLE-LOGIN-%'`;

async function safe(sql, params = [], fallback = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch (err) { console.error('[hr] query failed:', err.message); return fallback; }
}

async function renderPartial(name, data) {
  try {
    return await ejs.renderFile(path.join(__dirname, '..', 'views', 'hr', 'layout', name + '.ejs'), data);
  } catch (e) { console.error('[hr] partial ' + name + ' failed:', e.message); return ''; }
}

async function shell(req, pageTitle) {
  const user = req.session.user;

  // navPerms: reuse the per-request grant set the global middleware attaches to
  // the session user (tier + fine-role grants). The HR sidebar gates its
  // Property Segment link on properties.manage, so it MUST receive this — the
  // manually-rendered partial doesn't inherit res.locals.
  const navPerms = (user && user.navPerms) || [];

  // roleLabel: the human designation (private.employees.role, e.g. "HR Manager")
  // — NOT user.role, which auth.js aliases to the access TIER ("employee"). Falls
  // back to the tier if the lookup yields nothing. Display-only.
  let roleLabel = (user && user.role) || '';
  try {
    const r = await pool.query(
      `SELECT role FROM private.employees WHERE employee_id = $1`,
      [user && (user.employee_id || user.id)]
    );
    if (r.rows[0] && r.rows[0].role) roleLabel = r.rows[0].role;
  } catch (_) { /* keep tier fallback */ }

  const data = { user, pageTitle, navPerms, roleLabel };
  return {
    sidebarHtml: await renderPartial('sidebar', data),
    topbarHtml: await ejs.renderFile(path.join(__dirname, '..', 'views', 'layout', 'topbar.ejs'), data),
  };
}

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
async function dashboard(req, res) {
  const kRows = await safe(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='active')::int   AS active,
        COUNT(*) FILTER (WHERE status='on_leave')::int AS on_leave,
        COUNT(*) FILTER (WHERE status='inactive')::int AS inactive,
        COUNT(*) FILTER (WHERE hired_at >= date_trunc('month', CURRENT_DATE))::int AS new_this_month
       FROM private.employees WHERE ${REAL_STAFF}`,
    [], [{ total: 0, active: 0, on_leave: 0, inactive: 0, new_this_month: 0 }]
  );

  const recentHires = await safe(
    `SELECT name, role, status::text AS status, hired_at
       FROM private.employees WHERE ${REAL_STAFF}
      ORDER BY hired_at DESC NULLS LAST LIMIT 6`
  );

  const byRole = await safe(
    `SELECT COALESCE(role,'Unassigned') AS role, COUNT(*)::int AS cnt
       FROM private.employees WHERE ${REAL_STAFF}
      GROUP BY role ORDER BY cnt DESC, role`
  );

  const { sidebarHtml, topbarHtml } = await shell(req, 'HR Dashboard');
  res.render('hr/dashboard', {
    pageTitle: 'HR Dashboard', user: req.session.user,
    sidebarHtml, topbarHtml,
    k: kRows[0], recentHires, byRole,
  });
}

router.get('/', ensureHr, dashboard);
router.get('/dashboard', ensureHr, dashboard);

// ---------------------------------------------------------------------
// EMPLOYEE DIRECTORY (live)
// ---------------------------------------------------------------------
router.get('/employees', ensureHr, async (req, res) => {
  const employees = await safe(
    `SELECT name, role, status::text AS status, email, phone, hired_at
       FROM private.employees WHERE ${REAL_STAFF}
      ORDER BY (status='active') DESC, name`
  );
  const { sidebarHtml, topbarHtml } = await shell(req, 'Employee Directory');
  res.render('hr/employees', {
    pageTitle: 'Employee Directory', user: req.session.user,
    sidebarHtml, topbarHtml, employees,
  });
});

// ---------------------------------------------------------------------
// WORKFLOW WORKSPACES (scope sourced from Tech Document §6)
// ---------------------------------------------------------------------
const WORKFLOWS = {
  recruitment: {
    title: 'Recruitment', ref: '§6 (HR Module)',
    tagline: 'Lightweight applicant tracking — from job description to offer.',
    stages: ['Open Roles', 'Applied', 'Interview', 'Offer', 'Joined'],
    scope: [
      'Job descriptions per open role',
      'Candidate pipeline with stage tracking',
      'Interview scheduling',
      'Offer roll-out and acceptance',
    ],
  },
  onboarding: {
    title: 'Onboarding', ref: '§6 (HR Module)',
    tagline: 'Structured joining for every new hire.',
    stages: ['Pending', 'Docs Collected', 'Setup', 'Complete'],
    scope: [
      'Joining checklist per new employee',
      'Document collection (ID proof, education, offer letter)',
      'Asset / access setup',
      'Probation tracking',
    ],
  },
  exits: {
    title: 'Exits', ref: '§6 (HR Module)',
    tagline: 'Resignation to full-and-final, cleanly tracked.',
    stages: ['Resigned', 'Notice', 'Clearance', 'F&F', 'Closed'],
    scope: [
      'Resignation workflow',
      'Notice-period tracking',
      'Clearance checklist',
      'Full & Final (F&F) settlement',
    ],
  },
  grievances: {
    title: 'Grievances', ref: '§6 (HR Module)',
    tagline: 'Confidential case intake, assignment, and resolution.',
    stages: ['Open', 'In Review', 'Resolved'],
    scope: [
      'Grievance intake with category',
      'Assignment to handler',
      'Resolution notes and timeline',
      'Closure with outcome',
    ],
  },
};

router.get('/:wf', ensureHr, async (req, res, next) => {
  const wf = WORKFLOWS[req.params.wf];
  if (!wf) return next();
  const { sidebarHtml, topbarHtml } = await shell(req, wf.title);
  res.render('hr/workflow', {
    pageTitle: wf.title, user: req.session.user,
    sidebarHtml, topbarHtml, wf,
  });
});

module.exports = router;
