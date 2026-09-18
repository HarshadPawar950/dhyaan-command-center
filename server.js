require('dotenv').config();

// Fail-fast: refuse to boot without a real session secret. Signing sessions with
// a guessable literal ('secret') would allow session-cookie forgery, so an unset
// or blank SESSION_SECRET is a HARD boot error — never a silent fallback.
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim() === '') {
  console.error('FATAL: SESSION_SECRET is missing/blank. Refusing to boot. Set a strong SESSION_SECRET in .env.');
  process.exit(1);
}
const leadNewRoutes = require('./routes/lead-new');
const propertyNewRoutes = require('./routes/property-new');
const leadEditRoutes = require('./routes/lead-edit');
const propertyEditRoutes = require('./routes/property-edit');
const leadDeleteRoutes = require('./routes/lead-delete');
const propertyDeleteRoutes = require('./routes/property-delete');
const unitNewRoutes = require('./routes/unit-new');
const unitEditRoutes = require('./routes/unit-edit');
const unitDeleteRoutes = require('./routes/unit-delete');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const path = require('path');
const adminDashboardRoutes = require('./routes/admin/dashboard');
const adminEmployeesRoutes = require('./routes/admin/employees');
const adminLeadsRoutes = require('./routes/admin/leads');
const adminLeadsImportRoutes = require('./routes/admin/leads-import');
const adminAssignRoutes = require('./routes/admin/assign');
const adminPropertiesRoutes = require('./routes/admin/projects');
const propertiesRoutes = require('./routes/projects');
const adminHistoryRoutes = require('./routes/admin/history');
const adminSalesRoutes = require('./routes/admin/sales');
const adminApprovalsRoutes = require('./routes/admin/approvals');
const adminSiteVisitsRoutes = require('./routes/admin/site-visits');
const adminSuperRoutes = require('./routes/admin/super-dashboard');
const adminRestoreRoutes = require('./routes/admin/restore-archive');
const adminExportRoutes = require('./routes/admin/export-control');
const adminMarketingRoutes = require('./routes/admin/marketing');
const adminBookingsRoutes = require('./routes/admin/bookings');
const adminOwnerDashboardRoutes = require('./routes/admin/owner-dashboard');
const adminLeadScoringRoutes = require('./routes/admin/lead-scoring');
const adminKpiRoutes = require('./routes/admin/kpi');
const adminBuildersRoutes = require('./routes/admin/builders');
const adminContactsRoutes = require('./routes/admin/contacts');
const adminFinanceExpensesRoutes = require('./routes/admin/finance-expenses');
const adminFinanceReportsRoutes = require('./routes/admin/finance-reports');
const adminClientMgmtRoutes = require('./routes/admin/client-management');
const adminLegalRoutes = require('./routes/admin/legal');
const adminBuilderPricingRoutes = require('./routes/admin/builder-pricing');
const adminClientsRoutes = require('./routes/admin/clients');
const adminFollowUpsRoutes = require('./routes/admin/follow-ups');
const adminNotificationsRoutes = require('./routes/admin/notifications');
const adminCostSheetRoutes = require('./routes/admin/cost-sheet');
const adminCommissionsRoutes = require('./routes/admin/commissions');
const adminPermissionsRoutes = require('./routes/admin/permissions');
const adminReceiptsRoutes = require('./routes/admin/receipts');
const { grantsForTier, grantsForEmployeeRoles, tierOf } = require('./middleware/permissions');
const { propsBaseFor, unitsBaseFor } = require('./lib/propsNav');
const { homeFor, backFor } = require('./lib/navHome');
const { sealEmployeeWorld } = require('./middleware/sealEmployeeWorld');

const app = express();

// Trust the reverse proxy (nginx / ALB) so req.secure & X-Forwarded-Proto are
// honored behind HTTPS on a server. DEFAULT 0 = trust nothing = laptop behaves
// exactly as today (direct HTTP, no proxy). Server sets TRUST_PROXY=1.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);

// Cookie Secure flag is a SINGLE env-driven switch shared by the session cookie
// and the CSRF cookie. DEFAULT false: on the plain-HTTP office LAN a Secure
// cookie is silently dropped, so login would never persist. The server sets
// COOKIE_SECURE=true ONLY when TLS terminates in front of it. Never tie this to
// NODE_ENV — a 'production' start on the laptop must NOT flip it on.
const COOKIE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';

// Security headers with specific configurations for our needs
app.use(helmet({
  contentSecurityPolicy: false, // Disabling CSP for ease of development with inline scripts/styles if needed, adjust for production
}));

// Setup view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Sessions
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Served over plain HTTP on the office LAN (http://192.168.1.200:3000) — there
    // is NO TLS in the LAN deployment. A Secure cookie is silently DROPPED by
    // browsers/phones over http://, so the session would never persist: login 302s
    // then bounces back to /login, while curl/server-side probes still pass. So
    // secure is env-driven and DEFAULTS false (see COOKIE_SECURE above) — the
    // laptop/LAN stays secure:false; a TLS server sets COOKIE_SECURE=true. Never
    // tie this to NODE_ENV. sameSite:'lax' is explicit so the same-site login
    // POST always carries the cookie. (Behind TLS, also set TRUST_PROXY=1.)
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
}));

// Flash messages
app.use(flash());

// CSRF Protection — the CSRF cookie rides the SAME env-driven Secure flag as the
// session cookie (default false on LAN, true only when TLS terminates in front).
// sameSite:'lax' matches the session cookie so the login POST always carries it.
const csrfProtection = csurf({ cookie: { secure: COOKIE_SECURE, sameSite: 'lax' } });
// Apply CSRF protection globally, except where excluded (if needed)
app.use(csrfProtection);

// Global variables for templates
app.use(async (req, res, next) => {
  // Flash: merge BOTH key conventions (canonical *_msg + legacy bare keys)
  // into scalar strings so a route calling req.flash('success', ...) is never
  // silently dropped by a key mismatch. Single source of truth for all views.
  const merge = (...keys) => keys.flatMap(k => req.flash(k)).filter(Boolean).join(' ');
  res.locals.success_msg = merge('success_msg', 'success');
  res.locals.error_msg   = merge('error_msg', 'error');
  res.locals.success     = res.locals.success_msg; // alias for views reading bare key
  res.locals.error       = res.locals.error_msg;   // alias for views reading bare key
  res.locals.user = req.session.user || null;
  res.locals.csrfToken = req.csrfToken();

  // Live nav permissions for role-aware sidebar rendering. Computed fresh each
  // request so Permission-Editor changes take effect on the next page load.
  // Attached NON-ENUMERABLE so it never serializes into the session store (no
  // bloat, no resave). DISPLAY-ONLY — every route still enforces live via
  // ensurePermission, so a stale/failed nav can never grant real access.
  res.locals.propsBase = '/projects';   // safe default (overridden below once perms load)
  res.locals.unitsBase = '/projects';   // ditto for single-property back links
  // Role-aware "home" for EVERY error page / bounce — never depends on a DB call.
  res.locals.homePath = homeFor(req.session.user);
  // Role-aware "back" resolver for views: every breadcrumb root / "Cancel" /
  // "back to X" calls backFor('leads'|'projects'|'property'|'home') so no EJS
  // ever hardcodes an employee path a manager could be dropped onto.
  res.locals.backFor = (context) => backFor(req.session.user, context);
  const _u = req.session.user;
  if (_u) {
    try {
      const tier = tierOf(_u);
      let perms;
      if (tier === 'super_admin') {
        perms = ['*'];
      } else {
        // Tier grants + this person's FINE-ROLE grants (e.g. hr_manager →
        // properties.manage) so the role-aware sidebar reflects EVERY live grant
        // the human actually holds — matching can(). Additive + display-only;
        // routes still enforce via ensurePermission.
        const tierGrants = await grantsForTier(tier);
        const fineGrants = await grantsForEmployeeRoles(_u.employee_id || _u.id);
        perms = Array.from(new Set([...tierGrants, ...fineGrants]));
      }
      Object.defineProperty(_u, 'navPerms', { value: perms, enumerable: false, configurable: true, writable: true });
      res.locals.navPerms = perms;
      // Role-aware Properties nav base — ONE source for every property page's
      // back/browse link so admin/super/hr_manager never land on the employee
      // browse. propsBaseFor reads the navPerms we just attached.
      res.locals.propsBase = propsBaseFor(_u);
      res.locals.unitsBase = unitsBaseFor(_u);
    } catch (e) {
      // Fail-OPEN for display only (routes stay fail-closed): don't blank the
      // whole nav on a transient DB blip for a legitimately-signed-in admin.
      console.error('[navPerms] compute failed (nav falls back to show-all):', e.message);
    }
  }
  next();
});

// Routes
app.use('/leads', leadNewRoutes);
app.use('/leads', leadEditRoutes);
app.use('/projects', propertyEditRoutes);
app.use('/projects', require('./routes/property-images'));  // Launch Day: photo upload/delete
app.use('/leads', leadDeleteRoutes);
app.use('/projects', propertyDeleteRoutes);
app.use('/properties', unitNewRoutes);
app.use('/properties', unitEditRoutes);
app.use('/properties', require('./routes/unit-images'));   // 026: standalone-property media (POST /:id/images…)
app.use('/properties', unitDeleteRoutes);
app.use('/properties', require('./routes/unit-detail'));  // GET /properties/:id (after /new & /:id/edit)
// Bookmark redirects — old hierarchy paths → new (mig 018 Builder→Project→Property).
// /admin/properties = the real INVENTORY list (all saleable properties/units),
// distinct from /admin/projects (developments). Handled by routes/admin/projects.js.
// (The old 301 redirects here were a browser-cache trap — removed 2026-07-24.)
app.use('/admin', adminDashboardRoutes);
app.use('/admin', adminEmployeesRoutes);
app.use('/admin', adminLeadsImportRoutes);   // BEFORE adminLeadsRoutes: /leads/import must beat /leads/:id
app.use('/admin', adminLeadsRoutes);
app.use('/admin', adminAssignRoutes);
app.use('/admin', adminPropertiesRoutes);
app.use('/projects', propertyNewRoutes);
app.use('/projects', propertiesRoutes);
app.use('/admin', adminHistoryRoutes);
app.use('/admin', adminSalesRoutes);
app.use('/admin', adminApprovalsRoutes);
app.use('/admin', adminSuperRoutes);
app.use('/admin', adminRestoreRoutes);
app.use('/admin', adminExportRoutes);
app.use('/admin', adminMarketingRoutes);
app.use('/admin', adminBookingsRoutes);
app.use('/admin', adminReceiptsRoutes);
app.use('/admin', adminOwnerDashboardRoutes);
app.use('/admin', adminLeadScoringRoutes);
app.use('/admin', adminKpiRoutes);
app.use('/admin', require('./routes/admin/daily-reports'));  // /admin/reports/daily
app.use('/admin', adminBuildersRoutes);
app.use('/admin', adminContactsRoutes);
app.use('/admin', adminFinanceExpensesRoutes);
app.use('/admin', adminFinanceReportsRoutes);
app.use('/admin', adminClientsRoutes);
app.use('/admin', adminClientMgmtRoutes);
app.use('/admin', adminLegalRoutes);
app.use('/admin', adminBuilderPricingRoutes);
app.use('/admin', adminFollowUpsRoutes);
app.use('/admin', adminNotificationsRoutes);
app.use('/admin', adminCostSheetRoutes);
app.use('/admin', require('./routes/admin/project-cost-sheets'));  // mig 055 — internal builder cost sheets (off-public, gated)
app.use('/admin', adminCommissionsRoutes);
app.use('/admin', adminPermissionsRoutes);
app.use('/admin/site-visits', adminSiteVisitsRoutes);
app.get('/', (req, res) => {
  // Root always resolves through the ONE home resolver: login / admin dashboard /
  // hr dashboard / role console / employee dashboard — never a wrong-world hop.
  return res.redirect(homeFor(req.session.user));
});
app.use('/', require('./routes/auth'));
app.use(require('./middleware/employeeNotifications'));
app.use('/dashboard', sealEmployeeWorld, require('./routes/dashboard'));
app.use('/payslips', sealEmployeeWorld, require('./routes/payslips'));  // employee "My Payslips" — own only
app.use('/assistant', require('./routes/assistant'));  // AI Day F2 — floating how-to helper
app.use('/role', require('./routes/role'));
app.use('/hr', require('./routes/hr-payroll'));    // BEFORE hr.js so /hr/payroll* isn't swallowed by hr.js /:wf catch-all
app.use('/hr', require('./routes/hr'));
app.use('/hr', require('./routes/hr-leave'));      // /hr/leave — falls through hr.js /:wf catch-all
app.use('/hr', require('./routes/hr-incentive'));  // /hr/incentives + /hr/incentive-slabs
app.use('/hr', require('./routes/hr-attendance')); // /hr/attendance
app.use('/leads', require('./routes/leads'));
app.use('/feedback', sealEmployeeWorld, require('./routes/feedback'));
app.use('/closure', sealEmployeeWorld, require('./routes/closure'));
app.use('/walkins', sealEmployeeWorld, require('./routes/walkins'));
// Δ8: employee self-punch removed — attendance is HR/admin-only now (see /hr/attendance).
// (routes/attendance.js + views/attendance.ejs deleted; the sidebar link is gone.)
app.use('/leave', sealEmployeeWorld, require('./routes/leave'));
app.use('/incentives', sealEmployeeWorld, require('./routes/incentives'));
app.use('/reports', sealEmployeeWorld, require('./routes/reports'));

// Handle 404 — role-aware home link comes from res.locals.homePath (global mw).
app.use((req, res) => {
  res.status(404).render('404', { pageTitle: 'Page Not Found' });
});

// Global error handler (500) — role-aware, self-contained. An error page must
// never itself depend on the layout/DB that may have just failed, so it renders
// a standalone branded card whose ONE button goes to the actor's correct world.
app.use((err, req, res, next) => {
  // CSRF token failures are a mismatched/expired form, not a server fault —
  // bounce the actor home rather than showing a scary 500.
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.redirect(homeFor(req.session && req.session.user));
  }
  console.error('[500]', req.method, req.originalUrl, '-', err && err.message);
  const homePath = homeFor(req.session && req.session.user);
  try {
    return res.status(500).render('error', {
      pageTitle: 'Something went wrong',
      code: 500, title: 'Something went wrong',
      message: 'An unexpected error occurred. The team has been notified.',
      homePath,
    });
  } catch (_) {
    // Last-resort: never leave the actor on a blank/looping page.
    return res.status(500).send(`<h1>500</h1><p><a href="${homePath}">← Back</a></p>`);
  }
});

const PORT = process.env.PORT || 3000;

// Detect the actual current LAN IPv4 at boot instead of hardcoding it.
// If the office DHCP lease ever drifts off .200, the banner TELLS us the
// truth (and warns) rather than printing a stale address the team can't reach.
function detectLanIp() {
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // IPv4, routable (skip loopback / link-local 169.254.x.x)
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        return net.address;
      }
    }
  }
  return null;
}

const OFFICE_IP = '192.168.1.200';
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // On a real server the LAN-IP banner is meaningless — a PUBLIC_HOST env lets
  // the deploy print its true address instead. Cosmetic ONLY: binding is always
  // 0.0.0.0 above regardless. With PUBLIC_HOST unset the laptop prints the exact
  // LAN banner as before.
  if (process.env.PUBLIC_HOST) {
    console.log(`🌐 Public access: ${process.env.PUBLIC_HOST}`);
  } else {
    const lanIp = detectLanIp();
    if (lanIp) {
      console.log(`📡 Network access: http://${lanIp}:${PORT}`);
      if (lanIp !== OFFICE_IP) {
        console.log(`⚠️  LAN IP is ${lanIp}, NOT the office ${OFFICE_IP}.`);
        console.log(`⚠️  The team bookmark http://${OFFICE_IP}:${PORT} will NOT work until the .200 lease/reservation is restored.`);
      }
    } else {
      console.log(`⚠️  No routable LAN IPv4 detected — is Wi-Fi connected?`);
    }
  }
});






















