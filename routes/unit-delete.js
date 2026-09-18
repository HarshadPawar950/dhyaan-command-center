// ============================================================
// routes/unit-delete.js
// REQUEST Property Unit Deletion (Approval-Gated)
//
// Route:
//   POST /properties/:id/delete  -> creates a PENDING approval ticket
//
// APPROVAL ENGINE (Super Admin = God of System):
// Deletion no longer happens immediately. It raises a pending
// ticket in the Approval Center. The unit is only soft-deleted
// when a Super Admin APPROVES the request. Rejection discards it.
// The actual soft-delete (deleted_at = NOW()) is executed by the
// approval engine's 'unit_delete' executor on approval.
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

// D4 fix: requesting an inventory delete is a manager action (matches /admin/projects gate).
const propsManageGate = [ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('properties.manage')];

function isSuper(u) { return !!u && (u.role === 'super_admin' || u.access_role === 'super_admin'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// POST /properties/:id/delete  -> request deletion (creates ticket)
// ============================================================
router.post('/:id/delete', ensureAuthenticated, propsManageGate, async (req, res) => {
  const user = req.session.user;
  const unitId = req.params.id;
  const reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();

  if (!UUID_RE.test(unitId)) {
    return res.status(404).render('404', { pageTitle: 'Not Found' });
  }

  try {
    // Confirm the unit exists and isn't already deleted; grab a label + snapshot.
    const result = await pool.query(
      `SELECT property_id, project_id, config
         FROM private.properties
        WHERE property_id = $1 AND deleted_at IS NULL`,
      [unitId]
    );

    if (result.rows.length === 0) {
      req.session.unitFlash = {
        type: 'error',
        text: 'Unit not found or already deleted.'
      };
      return res.redirect('/admin/properties');
    }

    const unit = result.rows[0];

    // SUPER ADMIN GOD MODE: super_admin deletes execute IMMEDIATELY (soft-delete,
    // no ticket). Admin + employees fall through to the FROZEN ticket flow below.
    if (isSuper(user)) {
      const r = await executeDirect('unit_delete', unit.property_id);
      if (!r.ok) {
        req.session.unitFlash = { type: 'error', text: 'Could not delete unit: ' + r.error };
        return res.redirect('/admin/properties');   // inventory list (null-safe for standalone units)
      }
      try {
        await logFromRequest(req, {
          entityType: 'property_unit', entityId: unit.property_id, action: 'delete',
          notes: `${user.name} (super_admin) directly deleted unit "${unit.config}" — direct super_admin action`,
        });
      } catch (_) {}
      req.session.unitFlash = { type: 'success', text: `Unit "${unit.config}" deleted (direct super_admin action).` };
      return res.redirect('/admin/properties');   // inventory list (null-safe for standalone units)
    }

    // Don't raise a duplicate ticket if one is already pending for this unit.
    const dup = await pool.query(
      `SELECT 1 FROM private.approvals
        WHERE target_table = 'property_units'
          AND target_id = $1
          AND action_type = 'unit_delete'
          AND status = 'pending'`,
      [unitId]
    );

    if (dup.rows.length > 0) {
      req.session.unitFlash = {
        type: 'error',
        text: `A deletion request for unit "${unit.config}" is already awaiting Super Admin approval.`
      };
      return res.redirect('/admin/properties');   // inventory list (null-safe for standalone units)
    }

    // Raise the pending approval ticket (FROZEN - nothing deleted yet).
    await createApprovalTicket({
      actionType: 'unit_delete',
      targetTable: 'property_units',
      targetId: unit.property_id,
      targetLabel: `${unit.config}`,
      requestedBy: user.employee_id || user.id,
      requestedByName: user.name || 'Unknown',
      reason: reason || null,
      oldValue: {
        project_id: unit.project_id,
        config: unit.config
      },
      newValue: null // deletion has no "new" value
    });

    req.session.unitFlash = {
      type: 'success',
      text: `Deletion request for unit "${unit.config}" sent to Super Admin for approval. The unit stays active until approved.`
    };
    return res.redirect('/admin/properties');   // inventory list (null-safe for standalone units)

  } catch (err) {
    console.error('[units/delete] error:', err);
    req.session.unitFlash = {
      type: 'error',
      text: userSafeError(err, 'Could not submit the deletion request. Please try again.')
    };
    return res.redirect('/admin/properties');
  }
});

module.exports = router;
