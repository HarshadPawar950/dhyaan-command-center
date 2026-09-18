// ============================================================
// routes/property-delete.js
// REQUEST Property Deletion (Approval-Gated)
//
// Route:
//   POST /projects/:id/delete  -> creates a PENDING approval ticket
//
// APPROVAL ENGINE (Super Admin = God of System):
// Deletion no longer happens immediately. It raises a pending
// ticket in the Approval Center. The property is only soft-deleted
// when a Super Admin APPROVES the request. Rejection discards it.
// The actual soft-delete (deleted_at = NOW()) is executed by the
// approval engine's 'property_delete' executor on approval.
// ============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAuthenticated } = require('../middleware/auth');
const { createApprovalTicket, executeDirect } = require('../middleware/approvalEngine');
const { logFromRequest } = require('../middleware/historyLogger');
const { ensurePermission } = require('../middleware/permissions');
const { ensureAdminOrRole } = require('../middleware/ensureAdminOrRole');

// D4 fix: requesting a catalog delete is a manager action (matches /admin/projects gate).
const propsManageGate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

function isSuper(u) { return !!u && (u.role === 'super_admin' || u.access_role === 'super_admin'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// POST /projects/:id/delete  -> request deletion (creates ticket)
// ============================================================
router.post('/:id/delete', ensureAuthenticated, propsManageGate, async (req, res) => {
  const user = req.session.user;
  const propertyId = req.params.id;
  const reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();

  if (!UUID_RE.test(propertyId)) {
    return res.status(404).render('404', { pageTitle: 'Not Found' });
  }

  try {
    // Confirm the property exists and isn't already deleted; grab a label + snapshot.
    const result = await pool.query(
      `SELECT project_id, external_id, title
         FROM private.projects
        WHERE project_id = $1 AND deleted_at IS NULL`,
      [propertyId]
    );

    if (result.rows.length === 0) {
      req.session.propertyEditFlash = {
        type: 'error',
        text: 'Property not found or already deleted.'
      };
      return res.redirect('/admin/projects');
    }

    const property = result.rows[0];

    // SUPER ADMIN GOD MODE: super_admin deletes execute IMMEDIATELY (soft-delete,
    // no ticket). Admin + employees fall through to the FROZEN ticket flow below.
    if (isSuper(user)) {
      const r = await executeDirect('property_delete', property.project_id);
      if (!r.ok) {
        req.session.propertiesListFlash = { type: 'error', text: 'Could not delete property: ' + r.error };
        return res.redirect('/admin/projects');
      }
      try {
        await logFromRequest(req, {
          entityType: 'property', entityId: property.external_id, action: 'delete',
          notes: `${user.name} (super_admin) directly deleted property "${property.title}" — direct super_admin action`,
        });
      } catch (_) {}
      req.session.propertiesListFlash = { type: 'success', text: `Property "${property.title}" deleted (direct super_admin action).` };
      return res.redirect('/admin/projects');
    }

    // Don't raise a duplicate ticket if one is already pending for this property.
    const dup = await pool.query(
      `SELECT 1 FROM private.approvals
        WHERE target_table = 'properties'
          AND target_id = $1
          AND action_type = 'property_delete'
          AND status = 'pending'`,
      [propertyId]
    );

    if (dup.rows.length > 0) {
      req.session.propertiesListFlash = {
        type: 'error',
        text: `A deletion request for "${property.title}" is already awaiting Super Admin approval.`
      };
      return res.redirect('/admin/projects');
    }

    // Raise the pending approval ticket (FROZEN - nothing deleted yet).
    await createApprovalTicket({
      actionType: 'property_delete',
      targetTable: 'properties',
      targetId: property.project_id,
      targetLabel: `${property.title}`,
      requestedBy: user.employee_id || user.id,
      requestedByName: user.name || 'Unknown',
      reason: reason || null,
      oldValue: {
        external_id: property.external_id,
        title: property.title
      },
      newValue: null // deletion has no "new" value
    });

    req.session.propertiesListFlash = {
      type: 'success',
      text: `Deletion request for "${property.title}" sent to Super Admin for approval. The property stays active until approved.`
    };
    return res.redirect('/admin/projects');

  } catch (err) {
    console.error('[properties/delete] error:', err);
    req.session.propertyEditFlash = {
      type: 'error',
      text: userSafeError(err, 'Could not submit the deletion request. Please try again.')
    };
    return res.redirect(`/admin/projects/${propertyId}`);
  }
});

module.exports = router;
