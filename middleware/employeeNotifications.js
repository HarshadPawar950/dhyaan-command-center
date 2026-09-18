const db = require('../db');

module.exports = async function (req, res, next) {
  res.locals.notif = { total: 0, overdue: 0, today: 0, hot: 0, items: [] };
  try {
    if (!req.session || !req.session.user || !req.session.user.employee_id) {
      return next();
    }
    const employeeId = req.session.user.employee_id;
    const result = await db.query(`
      SELECT l.lead_id, l.name, l.status, l.next_action, l.next_action_date, l.site_visit_date
      FROM private.leads l
      JOIN private.assignments a ON a.lead_id = l.lead_id
      WHERE a.employee_id = $1
        AND l.deleted_at IS NULL
        AND (
          (l.next_action_date IS NOT NULL AND l.next_action_date < CURRENT_DATE)
          OR (l.site_visit_date = CURRENT_DATE)
          OR (l.status = 'hot' AND l.next_action_date IS NULL)
        )
      ORDER BY l.next_action_date ASC NULLS LAST
      LIMIT 15
    `, [employeeId]);
    const rows = result.rows;
    const today0 = new Date(new Date().toDateString());
    const overdue = rows.filter(r => r.next_action_date && new Date(r.next_action_date) < today0).length;
    const today = rows.filter(r => r.site_visit_date && new Date(r.site_visit_date).toDateString() === new Date().toDateString()).length;
    const hot = rows.filter(r => r.status === 'hot' && !r.next_action_date).length;
    res.locals.notif = { total: rows.length, overdue, today, hot, items: rows };
  } catch (err) {
    console.error('Notification middleware error:', err.message);
  }
  next();
};

