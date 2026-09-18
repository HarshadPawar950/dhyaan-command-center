const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { normalizePhone, findActiveDuplicate } = require('../middleware/leadAssignment');
const { homeFor } = require('../lib/navHome');

// List walk-ins
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const employeeId = req.session.user.id;
    // Show walk-ins assigned to this employee
    const query = `
      SELECT l.*
      FROM private.leads l
      JOIN private.assignments a ON a.lead_id = l.lead_id
      WHERE a.employee_id = $1 AND l.source = 'walk_in'
      ORDER BY l.created_at DESC
    `;
    const result = await pool.query(query, [employeeId]);

    res.render('walkins', {
      pageTitle: 'Walk-ins',
      walkins: result.rows
    });
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error fetching walk-ins');
    res.redirect(homeFor(req.session.user));
  }
});

// Add new walk-in.
// Walk-ins are handled by whoever is at the desk, so the lead is assigned to the
// CREATOR (never round-robin — that would misroute a lead standing in front of a
// human). ACTIVE-DEDUP guard still blocks the same phone entering twice. Lead +
// assignment insert is wrapped in a proper SAVEPOINT transaction (CLAUDE.md §2).
router.post('/', ensureAuthenticated, async (req, res) => {
  const { name, phone, email, requirement, budget, location } = req.body;
  const employeeId = (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null;

  if (!name || !phone) {
    req.flash('error_msg', 'Name and phone are required.');
    return res.redirect('/walkins');
  }

  // Active-dedup — block if an ACTIVE lead already has this phone (last-10-digits).
  // Soft-deleted leads never block a genuine re-enquiry.
  const dup = await findActiveDuplicate(pool, normalizePhone(phone));
  if (dup) {
    req.flash('error_msg',
      `A lead with this phone already exists: ${dup.name} (${dup.external_id})` +
      (dup.owner_name ? `, owned by ${dup.owner_name}` : ' (unassigned)') + '.');
    return res.redirect('/walkins');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SAVEPOINT sp_walkin');

    const leadResult = await client.query(
      `INSERT INTO private.leads
       (lead_id, external_id, name, phone, email, source, requirement, budget, location, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'walk_in', $5, $6, $7, 'hot', NOW())
       RETURNING lead_id`,
      [phone, name, phone, email, requirement, budget, location]
    );
    const leadId = leadResult.rows[0].lead_id;

    // Assign to the employee who logged the walk-in (the desk exec).
    await client.query(
      `INSERT INTO private.assignments (assignment_id, lead_id, employee_id, assigned_at)
       VALUES (gen_random_uuid(), $1, $2, NOW())`,
      [leadId, employeeId]
    );

    await client.query('RELEASE SAVEPOINT sp_walkin');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[walkins] add failed:', err.message);
    if (err.code === '23505') req.flash('error_msg', 'A lead with this phone number already exists.');
    else req.flash('error_msg', 'Error adding walk-in');
    return res.redirect('/walkins');
  } finally {
    client.release();
  }

  req.flash('success_msg', 'Walk-in added and assigned to you successfully');
  return res.redirect('/walkins');
});

module.exports = router;
