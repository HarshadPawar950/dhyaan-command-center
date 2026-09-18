// routes/dashboard.js
// SUPER DASHBOARD - Everything in ONE page (Leads + Properties + Feedback + KPIs)

const express = require('express');
const router = express.Router();
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');

router.get('/', ensureAuthenticated, async (req, res) => {
  // WORLD-SEALING: the employee super-dashboard is an employee-world surface. Any
  // non-employee (admin, super_admin, hr_manager, role console) is bounced to
  // their own home by sealEmployeeWorld, mounted on '/dashboard' in server.js —
  // one source of truth for the seal (CAPTAIN ruling 2026-07-30, extends 07-26).
  try {
    const employeeId = req.session.user.employee_id;

    // Run ALL queries in parallel (FAST!)
    const [
      kpiFollowUps,
      kpiActiveDeals,
      kpiCommission,
      kpiAttendance,
      hotLeads,
      warmLeads,
      recentFeedback,
      topProperties,
      propertyStats,
      upcomingVisits,
      todayReport,
      todaySystem
    ] = await Promise.all([
      // KPI 1: Follow-ups due
      db.query(`
        SELECT COUNT(DISTINCT l.lead_id) AS cnt
        FROM private.leads l
        JOIN private.assignments a ON a.lead_id = l.lead_id
        LEFT JOIN private.feedback f ON f.lead_id = l.lead_id
        WHERE a.employee_id = $1
        GROUP BY l.lead_id
        HAVING MAX(f.created_at) < NOW() - INTERVAL '7 days' OR MAX(f.created_at) IS NULL
      `, [employeeId]),

      // KPI 2: Active deals
      db.query(`
        SELECT COUNT(*) AS cnt
        FROM private.leads l
        JOIN private.assignments a ON a.lead_id = l.lead_id
        WHERE a.employee_id = $1 AND l.deleted_at IS NULL AND l.status IN ('hot', 'converted')
      `, [employeeId]),

      // KPI 3: Commission
      db.query(`
        SELECT COALESCE(SUM(employee_share), 0) AS total
        FROM private.commission_ledger
        WHERE employee_id = $1
      `, [employeeId]),

      // KPI 4: Today's attendance
      db.query(`
        SELECT status FROM private.attendance
        WHERE employee_id = $1 AND date = CURRENT_DATE
      `, [employeeId]),

      // Hot leads (TOP 5)
      db.query(`
        SELECT l.lead_id, l.name, l.phone, l.budget, l.requirement, l.location, l.last_feedback
        FROM private.leads l
        JOIN private.assignments a ON a.lead_id = l.lead_id
        WHERE a.employee_id = $1 AND l.deleted_at IS NULL AND l.status = 'hot'
        ORDER BY l.created_at DESC
        LIMIT 5
      `, [employeeId]),

      // Warm leads (TOP 5)
      db.query(`
        SELECT l.lead_id, l.name, l.phone, l.budget, l.requirement
        FROM private.leads l
        JOIN private.assignments a ON a.lead_id = l.lead_id
        WHERE a.employee_id = $1 AND l.deleted_at IS NULL AND l.status = 'warm'
        ORDER BY l.created_at DESC
        LIMIT 5
      `, [employeeId]),

      // Recent feedback (last 5)
      db.query(`
        SELECT f.feedback_id, f.comments, f.rating, f.created_at, l.name AS lead_name
        FROM private.feedback f
        JOIN private.leads l ON l.lead_id = f.lead_id
        JOIN private.assignments a ON a.lead_id = l.lead_id
        WHERE a.employee_id = $1 AND l.deleted_at IS NULL
        ORDER BY f.created_at DESC
        LIMIT 5
      `, [employeeId]),

      // Featured properties (top 6 premium/luxury)
      db.query(`
        SELECT p.project_id, p.title, p.builder, p.area_zone,
               p.configurations, p.price_range, p.tier
        FROM private.projects p
        WHERE p.tier IN ('Luxury', 'Premium')
        ORDER BY 
          CASE p.tier WHEN 'Luxury' THEN 1 WHEN 'Premium' THEN 2 ELSE 3 END,
          p.title
        LIMIT 6
      `),

      // Property inventory stats
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM private.projects) AS total_projects,
          (SELECT COUNT(*) FROM private.properties) AS total_units,
          (SELECT COUNT(DISTINCT area_zone) FROM private.projects) AS total_zones,
          (SELECT COUNT(DISTINCT builder) FROM private.projects) AS total_builders
      `),

      // My upcoming site visits (next 7 days)
      db.query(`
        SELECT sv.visit_id, sv.scheduled_at, sv.status::text AS status,
               l.name AS lead_name, p.title AS property_title
          FROM private.site_visits sv
          JOIN private.leads l      ON l.lead_id = sv.lead_id
          JOIN private.projects p ON p.project_id = sv.project_id
         WHERE sv.employee_id = $1 AND sv.deleted_at IS NULL
           AND sv.scheduled_at >= CURRENT_DATE
           AND sv.scheduled_at <  CURRENT_DATE + INTERVAL '7 days'
           AND sv.status NOT IN ('cancelled', 'no_show')
         ORDER BY sv.scheduled_at
         LIMIT 10
      `, [employeeId]),

      // Today's evening report (if already submitted)
      db.query(`
        SELECT calls_made, followups_done, visits_done, new_leads, notes, submitted_at, updated_at
          FROM private.daily_reports
         WHERE employee_id = $1 AND report_date = CURRENT_DATE AND deleted_at IS NULL
      `, [employeeId]),

      // System-counted truth for TODAY (self-report vs system, side by side)
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM private.follow_ups f
             WHERE f.employee_id = $1 AND f.deleted_at IS NULL AND f.created_at::date = CURRENT_DATE)::int AS sys_followups,
          (SELECT COUNT(*) FROM private.site_visits sv
             WHERE sv.employee_id = $1 AND sv.deleted_at IS NULL
               AND sv.scheduled_at::date = CURRENT_DATE
               AND sv.status IN ('completed','booked'))::int AS sys_visits,
          (SELECT COUNT(*) FROM private.assignments a
             WHERE a.employee_id = $1 AND a.assigned_at::date = CURRENT_DATE)::int AS sys_new_leads
      `, [employeeId])
    ]);

    res.render('dashboard', {
      pageTitle: 'Dashboard',
      user: req.session.user,
      kpis: {
        followUps: kpiFollowUps.rows.length || 0,
        activeDeals: parseInt(kpiActiveDeals.rows[0]?.cnt || 0),
        commission: parseFloat(kpiCommission.rows[0]?.total || 0),
        attendance: kpiAttendance.rows[0]?.status || 'Not Checked In'
      },
      hotLeads: hotLeads.rows || [],
      warmLeads: warmLeads.rows || [],
      recentFeedback: recentFeedback.rows || [],
      topProperties: topProperties.rows || [],
      propertyStats: propertyStats.rows[0] || { total_projects: 0, total_units: 0, total_zones: 0, total_builders: 0 },
      upcomingVisits: upcomingVisits.rows || [],
      todayReport: todayReport.rows[0] || null,
      todaySystem: todaySystem.rows[0] || { sys_followups: 0, sys_visits: 0, sys_new_leads: 0 }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Something went wrong loading your dashboard. Please try again.');
  }
});

module.exports = router;
