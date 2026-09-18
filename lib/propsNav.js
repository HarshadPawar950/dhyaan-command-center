// =============================================================
// lib/propsNav.js — role-aware Properties navigation base.
//
// ONE source of truth for "where do the Properties back/browse/redirect links
// point for THIS actor". Holders of properties.manage (admin, super_admin, and
// the hr_manager fine-role via its grant) manage from /admin/projects;
// everyone else browses the read-only /projects.
//
// Reads navPerms the global middleware attaches to the session user each
// request (tier + fine-role grants). Fails to the employee side. Display/nav
// only — every route still enforces access via its own gate.
// =============================================================

function _canManage(user) {
  const np = user && user.navPerms;
  return !!(np && (np.indexOf('*') !== -1 || np.indexOf('properties.manage') !== -1));
}

// Base for PROJECTS (developments): manager inventory of projects vs employee browse.
function propsBaseFor(user) {
  return _canManage(user) ? '/admin/projects' : '/projects';
}

// Base for a single standalone PROPERTY/UNIT (private.properties). Units live in
// the INVENTORY (/admin/properties), NOT the developments list — so a unit's
// "back to Properties" must land on the inventory for a manager, the employee
// browse otherwise. Using propsBaseFor here would 404-adjacent (wrong list).
function unitsBaseFor(user) {
  return _canManage(user) ? '/admin/properties' : '/projects';
}

module.exports = { propsBaseFor, unitsBaseFor, _canManage };
