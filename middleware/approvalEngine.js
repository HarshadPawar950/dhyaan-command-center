// =============================================================
// middleware/approvalEngine.js
// THE APPROVAL ENGINE  —  Super Admin = God of System
//
// FROZEN MODEL: a critical action does NOT happen immediately.
// It creates a PENDING ticket. The change is applied ONLY when
// a Super Admin approves it. Rejection discards it. Everything
// is recorded permanently.
//
// Public functions:
//   createApprovalTicket(opts)        -> raise a pending ticket
//   getPendingApprovals()             -> feed the Super Admin inbox
//   getApprovalById(id)               -> one ticket (for review screen)
//   getApprovalHistory(limit)         -> decided tickets (audit view)
//   countPending()                    -> badge count for the inbox
//   decideApproval(id, decision, ...) -> approve (executes) or reject
// =============================================================

const pool = require('../db');

// ---- which actions the engine knows how to EXECUTE on approval ----
// Each handler receives a DB client (inside a transaction) + the ticket row.
// Add new action types here as we route more actions through approval.
const EXECUTORS = {
  // Soft-delete a lead (sets deleted_at). Reversible, safe.
  lead_delete: async (client, ticket) => {
    await client.query(
      `UPDATE private.leads
          SET deleted_at = NOW()
        WHERE lead_id = $1
          AND deleted_at IS NULL`,
      [ticket.target_id]
    );
  },

  // Soft-delete a property unit.
  site_visit_delete: async (client, ticket) => {
    await client.query(
      `UPDATE private.site_visits
          SET deleted_at = NOW()
        WHERE visit_id = $1
          AND deleted_at IS NULL`,
      [ticket.target_id]
    );
  },

  // Soft-delete a property unit.
  unit_delete: async (client, ticket) => {
    await client.query(
      `UPDATE private.properties
          SET deleted_at = NOW()
        WHERE property_id = $1
          AND deleted_at IS NULL`,
      [ticket.target_id]
    );
  },

  // Soft-delete a property.
  property_delete: async (client, ticket) => {
    await client.query(
      `UPDATE private.projects
          SET deleted_at = NOW()
        WHERE project_id = $1
          AND deleted_at IS NULL`,
      [ticket.target_id]
    );
  },

  // Soft-delete a booking (= a payments row). Ruling #3.
  booking_delete: async (client, ticket) => {
    await client.query(
      `UPDATE private.payments
          SET deleted_at = NOW()
        WHERE payment_id = $1
          AND deleted_at IS NULL`,
      [ticket.target_id]
    );
  },

  // Create a company expense above the approval threshold (Finance Phase 1).
  // FROZEN: no expenses row exists until the Boss approves — the full payload
  // rides in ticket.new_value, and target_id is the pre-generated expense_id so
  // the ticket names a stable reference. On approval we assign the EXP- number
  // (from the ('EXP', year) counter, isolated from DHY-RCPT-) and insert live.
  expense_create: async (client, ticket) => {
    const v = ticket.new_value || {};
    const year = new Date().getFullYear();
    const seqQ = await client.query(
      `INSERT INTO private.receipt_counters (series, year, last_seq) VALUES ('EXP', $1, 1)
         ON CONFLICT (series, year) DO UPDATE SET last_seq = private.receipt_counters.last_seq + 1
         RETURNING last_seq`,
      [year]
    );
    const extId = `EXP-${year}-${String(Number(seqQ.rows[0].last_seq)).padStart(4, '0')}`;
    await client.query(
      `INSERT INTO private.expenses
         (expense_id, external_id, expense_date, category_id, amount, paid_to, payment_mode,
          project_id, campaign_id, notes, receipt_reference, gst_input_amount,
          is_input_gst_eligible, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'approved',$14)`,
      [ticket.target_id, extId, v.expense_date, v.category_id, v.amount, v.paid_to, v.payment_mode,
       v.project_id || null, v.campaign_id || null, v.notes || null, v.receipt_reference || null,
       v.gst_input_amount != null ? v.gst_input_amount : null, !!v.is_input_gst_eligible, v.created_by || null]
    );
  },

  // Edit a lead — applies the JSON in new_value (column -> value).
  lead_edit: async (client, ticket) => {
    const changes = ticket.new_value || {};
    const cols = Object.keys(changes);
    if (cols.length === 0) return;
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const vals = cols.map((c) => changes[c]);
    vals.push(ticket.target_id);
    await client.query(
      `UPDATE private.leads SET ${sets} WHERE lead_id = $${vals.length}`,
      vals
    );
  },
};

// -------------------------------------------------------------
// createApprovalTicket
// Raises a pending ticket. Returns the new ticket row.
// opts = {
//   actionType, targetTable, targetId, targetLabel,
//   requestedBy (employee_id uuid), requestedByName,
//   reason, oldValue (obj|null), newValue (obj|null)
// }
// -------------------------------------------------------------
async function createApprovalTicket(opts) {
  const {
    actionType, targetTable, targetId, targetLabel,
    requestedBy, requestedByName, reason,
    oldValue = null, newValue = null,
  } = opts;

  const { rows } = await pool.query(
    `INSERT INTO private.approvals
       (action_type, target_table, target_id, target_label,
        requested_by, requested_by_name, reason, old_value, new_value, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
     RETURNING *`,
    [
      actionType, targetTable, targetId, targetLabel || null,
      requestedBy, requestedByName || null, reason || null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
    ]
  );
  return rows[0];
}

// -------------------------------------------------------------
// getPendingApprovals — newest first (Super Admin inbox)
// -------------------------------------------------------------
async function getPendingApprovals() {
  const { rows } = await pool.query(
    `SELECT * FROM private.approvals
      WHERE status = 'pending'
      ORDER BY created_at DESC`
  );
  return rows;
}

// -------------------------------------------------------------
// getApprovalById
// -------------------------------------------------------------
async function getApprovalById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM private.approvals WHERE approval_id = $1`,
    [id]
  );
  return rows[0] || null;
}

// -------------------------------------------------------------
// getApprovalHistory — decided tickets (approved/rejected)
// -------------------------------------------------------------
async function getApprovalHistory(limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM private.approvals
      WHERE status <> 'pending'
      ORDER BY decided_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// -------------------------------------------------------------
// countPending — for the inbox badge
// -------------------------------------------------------------
async function countPending() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM private.approvals WHERE status = 'pending'`
  );
  return rows[0].n;
}

// -------------------------------------------------------------
// decideApproval
// decision = 'approved' | 'rejected'
// On 'approved': runs the matching executor INSIDE a transaction,
// then marks the ticket. On 'rejected': just marks the ticket.
// Returns { ok, ticket, error }.
// -------------------------------------------------------------
async function decideApproval(id, decision, deciderId, deciderName, note) {
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, error: 'Invalid decision' };
  }

  const ticket = await getApprovalById(id);
  if (!ticket) return { ok: false, error: 'Approval ticket not found' };
  if (ticket.status !== 'pending') {
    return { ok: false, error: 'This ticket has already been decided' };
  }

  // REJECT — no change to data, just record the decision.
  if (decision === 'rejected') {
    const { rows } = await pool.query(
      `UPDATE private.approvals
          SET status = 'rejected', decided_by = $1, decided_by_name = $2,
              decided_at = NOW(), decision_note = $3
        WHERE approval_id = $4
        RETURNING *`,
      [deciderId, deciderName || null, note || null, id]
    );
    return { ok: true, ticket: rows[0] };
  }

  // APPROVE — execute the change and mark the ticket atomically.
  const executor = EXECUTORS[ticket.action_type];
  if (!executor) {
    return { ok: false, error: `No executor for action '${ticket.action_type}'` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await executor(client, ticket);            // apply the real change
    const { rows } = await client.query(
      `UPDATE private.approvals
          SET status = 'approved', decided_by = $1, decided_by_name = $2,
              decided_at = NOW(), decision_note = $3
        WHERE approval_id = $4
        RETURNING *`,
      [deciderId, deciderName || null, note || null, id]
    );
    await client.query('COMMIT');
    return { ok: true, ticket: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approvalEngine] execution failed:', err);
    return { ok: false, error: 'Execution failed: ' + err.message };
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// executeDirect — run an action's executor IMMEDIATELY, no ticket.
// Used ONLY by the super_admin bypass: super_admin's deletes execute at once
// (still soft-delete; the CALLER writes the history_log "direct super_admin
// action" entry). The FROZEN ticket flow (createApprovalTicket / decideApproval)
// is UNCHANGED and remains the path for admin + employees — Mukul→Munish is
// byte-identical. Reuses the same EXECUTORS map = one source of the delete SQL.
// Returns { ok, error }.
// -------------------------------------------------------------
async function executeDirect(actionType, targetId, newValue = null) {
  const executor = EXECUTORS[actionType];
  if (!executor) return { ok: false, error: `No executor for action '${actionType}'` };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await executor(client, { target_id: targetId, new_value: newValue });
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approvalEngine] direct execution failed:', err);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = {
  createApprovalTicket,
  getPendingApprovals,
  getApprovalById,
  getApprovalHistory,
  countPending,
  decideApproval,
  executeDirect, // super_admin bypass (additive; admin flow unchanged)
  EXECUTORS, // exported so we can register more actions later
};
