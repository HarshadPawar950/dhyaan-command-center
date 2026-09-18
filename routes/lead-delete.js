// =============================================================
// routes/lead-delete.js
// REQUEST Lead Deletion (Approval-Gated)
//
// Route:
//   POST /leads/:id/delete  -> creates a PENDING approval ticket
//
// APPROVAL ENGINE (Super Admin = God of System):
// Deletion no longer happens immediately. It raises a pending
// ticket in the Approval Center. The lead is only soft-deleted
// when a Super Admin APPROVES the request. Rejection discards it.
// The actual soft-delete (deleted_at = NOW()) is executed by the
// approval engine's 'lead_delete' executor on approval.
// =============================================================

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { userSafeError } = require('../lib/safeDbError');
const { ensureAuthenticated } = require('../middleware/auth');
const { createApprovalTicket, executeDirect } = require('../middleware/approvalEngine');
const { logFromRequest } = require('../middleware/historyLogger');

function isSuper(u) { return !!u && (u.role === 'super_admin' || u.access_role === 'super_admin'); }
function isAdminish(u) { return isSuper(u) || (!!u && (u.role === 'admin' || u.access_role === 'admin')); }

// Ownership guard — an employee may delete ONLY a lead assigned to them.
// Lead ownership lives in private.assignments (never on the leads row).
// super_admin + admin bypass. Fail-CLOSED: a DB error → "not owner" → deny.
async function ownsLead(user, leadId) {
  if (isAdminish(user)) return true;
  try {
    const r = await pool.query(
      `SELECT 1 FROM private.assignments WHERE lead_id = $1 AND employee_id = $2 LIMIT 1`,
      [leadId, user && user.id]
    );
    return r.rows.length > 0;
  } catch (_) { return false; }
}

// Role-aware flash + list redirect. Admins land on the admin leads console
// (the session-flash convention it reads); employees land on their own /leads
// list with connect-flash (the only convention that view surfaces).
function flashAndBack(req, user, type, text) {
  if (isAdminish(user)) {
    req.session.leadsListFlash = { type, text };
    return '/admin/leads';
  }
  req.flash(type === 'success' ? 'success_msg' : 'error_msg', text);
  return '/leads';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =============================================================
// POST /leads/:id/delete  -> request deletion (creates ticket)
// =============================================================
router.post('/:id/delete', ensureAuthenticated, async (req, res) => {
  const user = req.session.user;
  const leadId = req.params.id;
  const reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();

  if (!UUID_RE.test(leadId)) {
    return res.status(404).render('404', { pageTitle: 'Not Found' });
  }

  // Ownership gate — employees may delete ONLY their own assigned leads
  // (super_admin + admin bypass). Non-owner employee → denied.
  if (!(await ownsLead(user, leadId))) {
    req.flash('error_msg', 'You can only delete your own leads');
    return res.redirect('/leads');
  }

  try {
    // Confirm the lead exists and isn't already deleted; grab a label + snapshot.
    const result = await pool.query(
      `SELECT lead_id, external_id, name, phone, status
         FROM private.leads
        WHERE lead_id = $1 AND deleted_at IS NULL`,
      [leadId]
    );

    if (result.rows.length === 0) {
      return res.redirect(flashAndBack(req, user, 'error', 'Lead not found or already deleted.'));
    }

    const lead = result.rows[0];

    // SUPER ADMIN GOD MODE: super_admin deletes execute IMMEDIATELY (soft-delete,
    // no ticket). Admin + employees fall through to the FROZEN ticket flow below.
    if (isSuper(user)) {
      const r = await executeDirect('lead_delete', lead.lead_id);
      if (!r.ok) {
        return res.redirect(flashAndBack(req, user, 'error', 'Could not delete lead: ' + r.error));
      }
      try {
        await logFromRequest(req, {
          entityType: 'lead', entityId: lead.external_id, action: 'delete',
          notes: `${user.name} (super_admin) directly deleted lead "${lead.name}" — direct super_admin action`,
        });
      } catch (_) {}
      return res.redirect(flashAndBack(req, user, 'success', `Lead "${lead.name}" deleted (direct super_admin action).`));
    }

    // Don't raise a duplicate ticket if one is already pending for this lead.
    const dup = await pool.query(
      `SELECT 1 FROM private.approvals
        WHERE target_table = 'leads'
          AND target_id = $1
          AND action_type = 'lead_delete'
          AND status = 'pending'
        LIMIT 1`,
      [leadId]
    );
    if (dup.rows.length > 0) {
      return res.redirect(flashAndBack(req, user, 'error', `A deletion request for "${lead.name}" is already awaiting Super Admin approval.`));
    }

    // Raise the pending approval ticket (FROZEN — nothing deleted yet).
    await createApprovalTicket({
      actionType: 'lead_delete',
      targetTable: 'leads',
      targetId: lead.lead_id,
      targetLabel: `${lead.name}${lead.phone ? ' · ' + lead.phone : ''}`,
      requestedBy: user.employee_id || user.id,
      requestedByName: user.name || 'Unknown',
      reason: reason || null,
      oldValue: {
        external_id: lead.external_id,
        name: lead.name,
        phone: lead.phone,
        status: lead.status,
      },
      newValue: null, // deletion has no "new" value
    });

    return res.redirect(flashAndBack(req, user, 'success', `Deletion request for "${lead.name}" sent to Super Admin for approval. The lead stays active until approved.`));

  } catch (err) {
    console.error('[leads/delete] error:', err);
    return res.redirect(flashAndBack(req, user, 'error', userSafeError(err, 'Could not submit the deletion request. Please try again.')));
  }
});

module.exports = router;
