const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { homeFor } = require('../lib/navHome');

router.get('/', ensureAuthenticated, async (req, res) => {
  // Pass leads assigned to user to pre-fill dropdown
  try {
     const employeeId = req.session.user.id;
     const leadsQuery = `
       SELECT l.lead_id, l.name, l.phone 
       FROM private.leads l
       JOIN private.assignments a ON a.lead_id = l.lead_id
       WHERE a.employee_id = $1
       ORDER BY l.name ASC
     `;
     const result = await pool.query(leadsQuery, [employeeId]);
     
     res.render('feedback', {
       pageTitle: 'Add Feedback',
       leads: result.rows
     });
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error loading feedback page');
    res.redirect(homeFor(req.session.user));
  }
});

router.post('/', ensureAuthenticated, async (req, res) => {
  const { lead_id, comments, rating } = req.body;
  try {
    // Generate UUID for feedback_id
    const result = await pool.query(
      `INSERT INTO private.feedback (feedback_id, lead_id, comments, rating, created_at) 
       VALUES (gen_random_uuid(), $1, $2, $3, NOW()) RETURNING *`,
      [lead_id, comments, rating]
    );

    // Update last_feedback in leads table
    await pool.query(
      `UPDATE private.leads SET last_feedback = $1 WHERE lead_id = $2`,
      [comments, lead_id]
    );

    req.flash('success_msg', 'Feedback added successfully');
    res.redirect('/leads/' + lead_id);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error adding feedback');
    res.redirect('/feedback');
  }
});

module.exports = router;
