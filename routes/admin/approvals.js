// =============================================================
// routes/admin/approvals.js
// Super Admin Approval Center
//   GET  /admin/approvals            -> inbox (pending) + history
//   POST /admin/approvals/:id/decide -> approve or reject a ticket
// Super-admin only (ensureSuperAdmin).
// =============================================================

const express = require('express');
const router = express.Router();

const { ensureSuperAdmin } = require('../../middleware/adminAuth');
const {
  getPendingApprovals,
  getApprovalHistory,
  decideApproval,
} = require('../../middleware/approvalEngine');
const { userSafeError } = require('../../lib/safeDbError');

// safe csrf token (won't crash if csurf not on this route)
function csrf(req) {
  try { return (typeof req.csrfToken === 'function') ? req.csrfToken() : ''; }
  catch (e) { return ''; }
}

// ---------- GET /admin/approvals ----------
router.get('/approvals', ensureSuperAdmin, async (req, res) => {
  try {
    const pending = await getPendingApprovals();
    const history = await getApprovalHistory(50);

    const stats = {
      pending: pending.length,
      approved: history.filter(h => h.status === 'approved').length,
      rejected: history.filter(h => h.status === 'rejected').length,
    };

    res.render('admin/approvals', {
      pageTitle: 'Approval Center',
      pending,
      history,
      stats,
      csrfToken: csrf(req),
      flash: req.query.msg || null,
      flashType: req.query.type || null,
    });
  } catch (err) {
    console.error('[admin/approvals] load error:', err);
    res.status(500).send(userSafeError(err, 'Failed to load the Approval Center. Please try again.'));
  }
});

// ---------- POST /admin/approvals/:id/decide ----------
router.post('/approvals/:id/decide', ensureSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const decision = req.body.decision; // 'approved' | 'rejected'
    const note = (req.body.note || '').trim();

    const deciderId = req.session.user.employee_id || req.session.user.id;
    const deciderName = req.session.user.name || 'Super Admin';

    const result = await decideApproval(id, decision, deciderId, deciderName, note);

    if (!result.ok) {
      return res.redirect('/admin/approvals?type=error&msg=' + encodeURIComponent(result.error));
    }

    const verb = decision === 'approved' ? 'approved and applied' : 'rejected';
    return res.redirect('/admin/approvals?type=success&msg=' + encodeURIComponent('Request ' + verb + '.'));
  } catch (err) {
    console.error('[admin/approvals] decide error:', err);
    return res.redirect('/admin/approvals?type=error&msg=' + encodeURIComponent('Something went wrong.'));
  }
});

module.exports = router;
