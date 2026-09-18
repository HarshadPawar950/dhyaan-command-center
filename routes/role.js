// =====================================================================
// routes/role.js  —  Role Panels (Batch 1: Sales Hierarchy)
// Mount: app.use('/role', require('./routes/role'))
//
//   GET /role            -> index of all role panels the viewer may see
//   GET /role/:roleKey   -> one role's panel (renderPartial pattern)
//
// Identity + permissions come from private.roles (DB source of truth).
// Presentation (widgets/sections) comes from config/rolePages.js.
//
// Gating (this batch — people not yet mapped):
//   - super_admin / admin  -> may view ANY role panel (preview mode)
//   - everyone else        -> only roles assigned to them in
//                             private.employee_roles (currently none)
// =====================================================================

const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const rolePages = require('../config/rolePages');
const roleModules = require('../config/roleModules');

// ---- safe read wrapper (read-only; mutations are out of scope here) ----
async function safe(sql, params = [], fallback = []) {
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (err) {
    console.error('[role] query failed:', err.message);
    return fallback;
  }
}

// ---- render an EMPLOYEE-side layout partial to an HTML string ----
// (renderPartial pattern — avoids the "include is not a function" EJS error)
async function renderPartial(name, data) {
  try {
    return await ejs.renderFile(
      path.join(__dirname, '..', 'views', 'layout', name + '.ejs'),
      data
    );
  } catch (e) {
    console.error('[role] partial ' + name + ' failed:', e.message);
    return '';
  }
}

// ---- minimal icon set (name -> inner SVG markup) ----
const ICONS = {
  shield:   '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  eye:      '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
  briefcase:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  layers:   '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  map:      '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4"/><line x1="8" y1="6" x2="8" y2="6"/><line x1="12" y1="6" x2="12" y2="6"/>',
  users:    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
  star:     '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  user:     '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  phone:    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  handshake:'<path d="M11 17l2 2a1 1 0 0 0 3-3"/><path d="M14 14l2.5 2.5a1 1 0 0 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 0 1-1.42 0l-2.12-2.12a1 1 0 0 0-1.41 0L2 12"/><path d="M21 3l-6 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  'map-pin':'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  flag:     '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  share:    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  'file-text':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  'trending-up':'<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  send:     '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  'pen-tool':'<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  image:    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  'dollar-sign':'<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  book:     '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  cpu:      '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  award:      '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
  'user-check':'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
  calendar:   '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  'credit-card':'<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
};

// ---- does this viewer get to see a given role panel? ----
function isStaffAdmin(user) {
  return user && (user.access_role === 'admin' || user.access_role === 'super_admin');
}

async function viewableRoleKeys(user) {
  if (isStaffAdmin(user)) {
    // preview mode: all INTERNAL roles (external portal is a separate boundary)
    const rows = await safe(
      `SELECT role_key FROM private.roles WHERE is_external = false ORDER BY sort_order`
    );
    return rows.map(r => r.role_key);
  }
  // regular staff: only roles explicitly assigned to them (none yet this batch)
  const rows = await safe(
    `SELECT role_key FROM private.employee_roles WHERE employee_id = $1`,
    [user.employee_id]
  );
  return rows.map(r => r.role_key);
}

// ---- resolve effective permissions by walking the inherits chain ----
async function resolvePermissions(roleKey) {
  const out = [];
  const seen = new Set();
  let key = roleKey;
  let guard = 0;
  while (key && !seen.has(key) && guard++ < 20) {
    seen.add(key);
    const rows = await safe(
      `SELECT permissions, inherits FROM private.roles WHERE role_key = $1`,
      [key]
    );
    if (!rows.length) break;
    const perms = rows[0].permissions || [];
    perms.forEach(p => { if (!out.includes(p)) out.push(p); });
    key = rows[0].inherits;
  }
  return out;
}

// ---------------------------------------------------------------------
// INDEX
// ---------------------------------------------------------------------
router.get('/', ensureAuthenticated, async (req, res) => {
  const allowed = await viewableRoleKeys(req.session.user);
  if (allowed.length === 0) {
    return res.status(403).send('You have no role panels assigned yet.');
  }
  const roles = await safe(
    `SELECT role_key, name, category, sort_order, description
       FROM private.roles
      WHERE role_key = ANY($1)
      ORDER BY sort_order`,
    [allowed]
  );

  // group by category for display
  const CATS = [
    { key: 'sales',      label: 'Sales Hierarchy' },
    { key: 'operations', label: 'Operations & Support' },
    { key: 'hr',         label: 'HR' },
    { key: 'external',   label: 'External' },
  ];
  const groups = CATS
    .map(c => ({ label: c.label, roles: roles.filter(r => r.category === c.key) }))
    .filter(g => g.roles.length > 0);

  const data = { user: req.session.user, pageTitle: 'Role Panels' };
  res.render('role-index', {
    pageTitle: 'Role Panels',
    user: req.session.user,
    sidebarHtml: await renderPartial('sidebar', data),
    topbarHtml: await renderPartial('topbar', data),
    groups,
    totalRoles: roles.length,
  });
});

// ---------------------------------------------------------------------
// ONE ROLE PANEL
// ---------------------------------------------------------------------
router.get('/:roleKey', ensureAuthenticated, async (req, res) => {
  const roleKey = req.params.roleKey;

  const rows = await safe(
    `SELECT role_key, name, category, sort_order, is_external, inherits, permissions, description
       FROM private.roles WHERE role_key = $1`,
    [roleKey]
  );
  if (!rows.length) {
    return res.status(404).render('404', { pageTitle: 'Role Not Found' });
  }
  const role = rows[0];

  const allowed = await viewableRoleKeys(req.session.user);
  if (!allowed.includes(roleKey)) {
    return res.status(403).send('You do not have access to this role panel.');
  }

  const cfg = rolePages[roleKey] || { tagline: role.description, widgets: [], sections: [] };
  // merge phase-tagged capabilities/roadmap (Tech Document) from roleModules
  cfg.modules = roleModules[roleKey] || cfg.modules || [];
  const effectivePermissions = await resolvePermissions(roleKey);
  const heroIconPath = ICONS[cfg.icon] || ICONS.user;

  const data = { user: req.session.user, pageTitle: role.name };
  res.render('role-page', {
    pageTitle: role.name,
    user: req.session.user,
    sidebarHtml: await renderPartial('sidebar', data),
    topbarHtml: await renderPartial('topbar', data),
    role,
    cfg,
    effectivePermissions,
    heroIconPath,
  });
});

module.exports = router;
