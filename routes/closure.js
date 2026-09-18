const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { homeFor } = require('../lib/navHome');

router.get('/', ensureAuthenticated, async (req, res) => {
  try {
     const employeeId = req.session.user.id;
     // Only show leads that can be converted (e.g. warm or hot)
     const leadsQuery = `
       SELECT l.lead_id, l.name, l.phone, l.status 
       FROM private.leads l
       JOIN private.assignments a ON a.lead_id = l.lead_id
       WHERE a.employee_id = $1 AND l.status != 'converted'
       ORDER BY l.name ASC
     `;
     const result = await pool.query(leadsQuery, [employeeId]);
     
     res.render('closure', {
       pageTitle: 'Mark Deal as Closed',
       leads: result.rows
     });
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error loading closure page');
    res.redirect(homeFor(req.session.user));
  }
});

router.post('/', ensureAuthenticated, async (req, res) => {
  const { lead_id } = req.body;
  try {
    await pool.query(
      `UPDATE private.leads SET status = 'converted', closed_at = NOW() WHERE lead_id = $1`,
      [lead_id]
    );
    req.flash('success_msg', 'Deal marked as converted successfully! 🎉');
    res.redirect(homeFor(req.session.user));
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Error closing deal');
    res.redirect('/closure');
  }
});

module.exports = router;

