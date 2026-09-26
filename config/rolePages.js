// =====================================================================
// config/rolePages.js  —  Presentation config per role (Batch 1: Sales)
//
// The DB table private.roles is the source of truth for IDENTITY +
// PERMISSIONS + INHERITANCE. THIS file is the source of truth for how a
// role's panel LOOKS — its widgets (KPI cards) and sections (work areas).
//
// Adding a new role's panel = add a config entry here + a row in
// private.roles. No template changes, no migration for the page itself.
//
// Widget/section content is sourced from:
//   - Dhyaan-Portal-Roles.pdf ("what it needs in the portal")
//   - Dhyaan-Tech-Document.pdf  §18 KPIs, §14 Owner view, §5 RBAC
//
// `widgets[].live`  = false means the KPI is scaffolded (label shown,
//   value pending a wired data source). We never show fabricated numbers.
// `sections[].href` = an existing working page this role links into.
// =====================================================================

module.exports = {

  super_admin: {
    icon: 'shield',
    tagline: 'Full control of the platform — users, roles, settings, and every dashboard.',
    readOnly: false,
    widgets: [
      { key: 'total_employees', label: 'Employees',        hint: 'Active + inactive', live: false },
      { key: 'total_roles',     label: 'Roles Defined',    hint: 'Across all categories', live: false },
      { key: 'open_approvals',  label: 'Open Approvals',   hint: 'Awaiting action', live: false },
      { key: 'audit_today',     label: 'Audit Events Today', hint: 'history_log', live: false },
    ],
    sections: [
      { label: 'Admin Dashboard',   href: '/admin/dashboard',  desc: 'Full operational control center.' },
      { label: 'Employee Management', href: '/admin/employees', desc: 'Provision, deactivate, assign roles.' },
      { label: 'History / Audit Log', href: '/admin/history',   desc: 'Immutable record of who changed what.' },
      { label: 'Role Panels',       href: '/role',             desc: 'Preview every role page.' },
    ],
  },

  owner_promoter: {
    icon: 'eye',
    tagline: 'Is my money working? Read-only oversight across spend, ROI, pipeline and cash — no operational editing.',
    readOnly: true,
    widgets: [
      { key: 'spend',         label: 'Spend (This Month)',   hint: 'Marketing outlay', live: false },
      { key: 'leads',         label: 'Leads',                hint: 'This month', live: false },
      { key: 'site_visits',   label: 'Site Visits',          hint: 'This month', live: false },
      { key: 'bookings',      label: 'Bookings',             hint: 'This month', live: false },
      { key: 'booking_value', label: 'Booking Value',        hint: 'Confirmed', live: false },
      { key: 'roi',           label: 'ROI',                  hint: 'Booking value ÷ spend', live: false },
      { key: 'pipeline_value',label: 'Pipeline Value',       hint: 'Weighted forecast', live: false },
      { key: 'cash_position', label: 'Cash Position',        hint: 'Collected vs committed', live: false },
    ],
    sections: [
      { label: 'Owner Dashboard', href: '/admin/owner-dashboard', desc: 'The 10-second snapshot + drill-downs.' },
      { label: 'High-Value Approvals', href: '/admin/approvals',  desc: 'Approve / reject big discounts.' },
    ],
  },

  ceo_director: {
    icon: 'briefcase',
    tagline: 'All read access across the business; approve high-value discounts.',
    readOnly: true,
    widgets: [
      { key: 'roi',            label: 'Overall ROI',     hint: 'Blended', live: false },
      { key: 'pipeline_value', label: 'Pipeline Value',  hint: 'Weighted', live: false },
      { key: 'bookings',       label: 'Bookings (MTD)',  hint: 'This month', live: false },
      { key: 'revenue',        label: 'Revenue (MTD)',   hint: 'Commission realized', live: false },
    ],
    sections: [
      { label: 'Management Dashboard', href: '/admin/dashboard', desc: 'Cross-business read view.' },
      { label: 'Discount Approvals',   href: '/admin/approvals', desc: 'High-value discount sign-off.' },
    ],
  },

  sales_head: {
    icon: 'layers',
    tagline: 'Cross-region view and approval workflows across all teams.',
    readOnly: false,
    widgets: [
      { key: 'all_region_leads', label: 'Leads (All Regions)', hint: 'Cross-region', live: false },
      { key: 'team_conversion',  label: 'Conversion %',        hint: 'Across teams', live: false },
      { key: 'revenue_vs_target',label: 'Revenue vs Target',   hint: 'This quarter', live: false },
      { key: 'pending_approvals',label: 'Pending Approvals',   hint: 'Cross-team', live: false },
    ],
    sections: [
      { label: 'All Leads',          href: '/admin/leads',     desc: 'Every region, every team.' },
      { label: 'Approval Workflows', href: '/admin/approvals', desc: 'Cross-team sign-off queue.' },
      { label: 'Sales Reports',      href: '/admin/sales',     desc: 'Funnel and performance.' },
    ],
  },

  regional_sales_manager: {
    icon: 'map',
    tagline: 'Own your region’s leads and team; reassign leads; region reports.',
    readOnly: false,
    widgets: [
      { key: 'region_leads',      label: 'Region Leads',     hint: 'Your micro-markets', live: false },
      { key: 'team_bookings',     label: 'Team Bookings',    hint: 'This month', live: false },
      { key: 'region_conversion', label: 'Region Conversion',hint: 'Visit → booking', live: false },
      { key: 'revenue_vs_target', label: 'Revenue vs Target',hint: 'Region', live: false },
    ],
    sections: [
      { label: 'Region Leads',     href: '/admin/leads',  desc: 'Leads scoped to your region.' },
      { label: 'Team Management',  href: '/admin/employees', desc: 'Your regional team.' },
      { label: 'Lead Reassignment',href: '/admin/assign', desc: 'Move leads within the region.' },
      { label: 'Region Reports',   href: '/admin/sales',  desc: 'Region funnel & ROI.' },
    ],
  },

  project_head: {
    icon: 'building',
    tagline: 'Single-project P&L; team management; discount approvals up to slab.',
    readOnly: false,
    widgets: [
      { key: 'project_pnl',     label: 'Project P&L',     hint: 'Spend vs revenue', live: false },
      { key: 'team_bookings',   label: 'Team Bookings',   hint: 'This month', live: false },
      { key: 'team_conversion', label: 'Team Conversion', hint: 'Visit → booking', live: false },
      { key: 'discount_queue',  label: 'Discount Queue',  hint: 'Up to slab', live: false },
    ],
    sections: [
      { label: 'Project Leads',     href: '/admin/leads',     desc: 'Leads on your project.' },
      { label: 'Team Management',   href: '/admin/employees', desc: 'Your project team.' },
      { label: 'Discount Approvals',href: '/admin/approvals', desc: 'Approve up to your slab.' },
    ],
  },

  team_leader: {
    icon: 'users',
    tagline: 'Your team’s leads, daily reviews, and reassignment within the team.',
    readOnly: false,
    widgets: [
      { key: 'team_leads',     label: 'Team Leads',     hint: 'Active', live: false },
      { key: 'team_conversion',label: 'Team Conversion',hint: 'This month', live: false },
      { key: 'sla_adherence',  label: 'SLA Adherence',  hint: 'First-contact', live: false },
      { key: 'daily_review',   label: 'Daily Review',   hint: 'Pending follow-ups', live: false },
    ],
    sections: [
      { label: 'Team Leads',       href: '/admin/leads',  desc: 'All leads owned by your team.' },
      { label: 'Reassign (Team)',  href: '/admin/assign', desc: 'Move leads within your team.' },
      { label: 'Follow-Ups',       href: '/admin/follow-ups', desc: 'Daily review queue.' },
    ],
  },

  senior_sales_executive: {
    icon: 'star',
    tagline: 'Own + assigned leads; site visits; can initiate bookings.',
    readOnly: false,
    widgets: [
      { key: 'my_leads',       label: 'My Leads',       hint: 'Own + assigned', live: false },
      { key: 'site_visits',    label: 'Site Visits',    hint: 'Scheduled', live: false },
      { key: 'bookings',       label: 'Bookings',       hint: 'Initiated', live: false },
      { key: 'conversion_pct', label: 'Conversion %',   hint: 'Your rate', live: false },
    ],
    sections: [
      { label: 'My Dashboard',  href: '/dashboard',  desc: 'Your daily working view.' },
      { label: 'My Leads',      href: '/leads',      desc: 'Own + assigned leads.' },
      { label: 'Mark Closure',  href: '/closure',    desc: 'Initiate a booking / closure.' },
    ],
  },

  sales_executive: {
    icon: 'user',
    tagline: 'Your own leads; status updates; site visits. Cannot reassign.',
    readOnly: false,
    widgets: [
      { key: 'calls_today',    label: 'Calls Today',    hint: 'Logged', live: false },
      { key: 'site_visits',    label: 'Site Visits',    hint: 'Scheduled', live: false },
      { key: 'leads_converted',label: 'Leads Converted',hint: 'This month', live: false },
      { key: 'bookings',       label: 'Bookings',       hint: 'This month', live: false },
      { key: 'revenue',        label: 'Revenue',        hint: 'Commission', live: false },
      { key: 'conversion_pct', label: 'Conversion %',   hint: 'Your rate', live: false },
    ],
    sections: [
      { label: 'My Dashboard',  href: '/dashboard',  desc: 'KPIs, hot & warm leads, properties.' },
      { label: 'My Leads',      href: '/leads',      desc: 'Update status, log activity.' },
      { label: 'Add Feedback',  href: '/feedback',   desc: 'Log a call / visit outcome.' },
    ],
  },

  presales_telecaller: {
    icon: 'phone',
    tagline: 'Lead qualification queue only. Qualify and route — cannot book.',
    readOnly: false,
    widgets: [
      { key: 'queue_size',     label: 'Queue Size',     hint: 'Awaiting qualification', live: false },
      { key: 'calls_today',    label: 'Calls Today',    hint: 'Logged', live: false },
      { key: 'qualified',      label: 'Qualified Today', hint: 'Moved forward', live: false },
    ],
    sections: [
      { label: 'Qualification Queue', href: '/leads',    desc: 'New leads to qualify.' },
      { label: 'Add Feedback',        href: '/feedback', desc: 'Log call disposition.' },
    ],
  },

  // ===================================================================
  // OPERATIONS & SUPPORT (13)
  // ===================================================================

  builder_kam: {
    icon: 'handshake',
    tagline: 'Own builder tie-ups, commission terms, inventory sync and payout follow-up.',
    readOnly: false,
    widgets: [
      { key: 'active_tieups',        label: 'Active Tie-ups',      hint: 'Builders represented', live: false },
      { key: 'inventory_freshness',  label: 'Inventory Freshness', hint: 'Days since last sync', live: false },
      { key: 'commission_accrued',   label: 'Commission Accrued',  hint: 'Receivable vs received', live: false },
      { key: 'payouts_followup',     label: 'Payouts to Follow Up',hint: 'Outstanding', live: false },
    ],
    sections: [
      { label: 'Builders',        href: '/admin/builders',   desc: 'Tie-ups, RERA, commission terms.' },
      { label: 'Inventory Sync',  href: '/admin/projects', desc: 'Keep availability current.' },
      { label: 'Payout Follow-up',planned: true,             desc: 'Commission ageing & reminders.' },
    ],
  },

  crm_ops_manager: {
    icon: 'settings',
    tagline: 'Lead routing rules, deduplication, and system configuration.',
    readOnly: false,
    widgets: [
      { key: 'routing_rules',   label: 'Routing Rules',     hint: 'Active', live: false },
      { key: 'duplicates',      label: 'Duplicates Flagged',hint: 'Awaiting merge', live: false },
      { key: 'unassigned',      label: 'Unassigned Leads',  hint: 'In fallback queue', live: false },
      { key: 'sla_breaches',    label: 'SLA Breaches',      hint: 'Today', live: false },
    ],
    sections: [
      { label: 'Lead Routing / Assign', href: '/admin/assign',  desc: 'Distribution & reassignment.' },
      { label: 'All Leads',             href: '/admin/leads',   desc: 'Dedupe & inspect.' },
      { label: 'Audit / History',       href: '/admin/history', desc: 'Configuration changes.' },
    ],
  },

  sitevisit_coordinator: {
    icon: 'map-pin',
    tagline: 'Cab allocation, visit scheduling, and the sales-gallery roster.',
    readOnly: false,
    widgets: [
      { key: 'visits_today',    label: 'Visits Today',    hint: 'Scheduled', live: false },
      { key: 'cabs_allocated',  label: 'Cabs Allocated',  hint: 'Today', live: false },
      { key: 'pending_pickups', label: 'Pending Pickups', hint: 'Unassigned', live: false },
      { key: 'gallery_slots',   label: 'Gallery Slots',   hint: 'Open today', live: false },
    ],
    sections: [
      { label: 'Site Visits',     href: '/admin/site-visits', desc: 'Schedule & track visits.' },
      { label: 'Cab Allocation',  planned: true,              desc: 'Assign drivers / pickups.' },
      { label: 'Gallery Roster',  planned: true,              desc: 'Sales-gallery staffing.' },
    ],
  },

  event_coordinator: {
    icon: 'flag',
    tagline: 'Plan exhibitions, stall logistics, on-ground lead capture and event ROI.',
    readOnly: false,
    widgets: [
      { key: 'upcoming_events', label: 'Upcoming Events', hint: 'Next 30 days', live: false },
      { key: 'leads_captured',  label: 'Leads Captured',  hint: 'Latest event', live: false },
      { key: 'footfall',        label: 'Footfall',        hint: 'Latest event', live: false },
      { key: 'event_roi',       label: 'Event ROI',       hint: 'Cost vs bookings', live: false },
    ],
    sections: [
      { label: 'Events / Exhibitions', planned: true, desc: 'Setup, logistics, roster.' },
      { label: 'On-ground Capture',    planned: true, desc: 'QR / card-scan lead forms.' },
      { label: 'Marketing',  href: '/admin/marketing',   desc: 'Tie events to campaigns.' },
    ],
  },

  subbroker_manager: {
    icon: 'share',
    tagline: 'Sub-broker onboarding and payout approvals.',
    readOnly: false,
    widgets: [
      { key: 'active_subbrokers', label: 'Active Sub-brokers', hint: 'Onboarded', live: false },
      { key: 'pending_onboard',   label: 'Pending Onboarding', hint: 'KYC in progress', live: false },
      { key: 'leads_via_cp',      label: 'Leads via CP',       hint: 'This month', live: false },
      { key: 'payouts_pending',   label: 'Payouts Pending',    hint: 'Approval', live: false },
    ],
    sections: [
      { label: 'Sub-broker Onboarding', planned: true, desc: 'KYC: PAN, GST, RERA agent reg.' },
      { label: 'Payout Approvals',      planned: true, desc: 'Sub-brokerage ledger + TDS.' },
    ],
  },

  booking_crm_executive: {
    icon: 'file-text',
    tagline: 'Post-booking operations, documentation, and customer communications.',
    readOnly: false,
    widgets: [
      { key: 'open_bookings', label: 'Open Bookings', hint: 'In progress', live: false },
      { key: 'docs_pending',  label: 'Docs Pending',  hint: 'Collection', live: false },
      { key: 'esign_pending', label: 'eSign Pending', hint: 'Awaiting customer', live: false },
      { key: 'customer_msgs', label: 'Customer Msgs',  hint: 'Open threads', live: false },
    ],
    sections: [
      { label: 'Bookings',  href: '/admin/bookings', desc: 'Post-booking workflow.' },
      { label: 'Clients',   href: '/admin/clients',  desc: 'Customer records & docs.' },
    ],
  },

  marketing_manager: {
    icon: 'trending-up',
    tagline: 'Campaigns, UTM, attribution, budget, and AI marketing insights.',
    readOnly: false,
    widgets: [
      { key: 'spend_mtd',       label: 'Spend (MTD)',      hint: 'All platforms', live: false },
      { key: 'cpl',             label: 'CPL',              hint: 'Cost per lead', live: false },
      { key: 'cost_per_booking',label: 'Cost / Booking',   hint: 'CPA', live: false },
      { key: 'roas',            label: 'ROAS',             hint: 'Return on ad spend', live: false },
      { key: 'budget_burn',     label: 'Budget Burn',      hint: 'vs monthly budget', live: false },
      { key: 'lead_quality',    label: 'Lead Quality',     hint: 'Avg score', live: false },
    ],
    sections: [
      { label: 'Marketing',    href: '/admin/marketing',     desc: 'Campaigns, UTM, attribution, budget.' },
      { label: 'Lead Scoring', href: '/admin/lead-scoring',  desc: 'Source quality & scoring.' },
    ],
  },

  marketing_executive: {
    icon: 'send',
    tagline: 'Campaign execution and lead-source quality reports.',
    readOnly: false,
    widgets: [
      { key: 'campaigns_live',    label: 'Campaigns Live',   hint: 'Running', live: false },
      { key: 'leads_today',       label: 'Leads Today',      hint: 'From campaigns', live: false },
      { key: 'ctr',               label: 'CTR',              hint: 'Click-through', live: false },
      { key: 'leadsource_quality',label: 'Source Quality',   hint: 'Top vs weak', live: false },
    ],
    sections: [
      { label: 'Marketing', href: '/admin/marketing', desc: 'Execute & monitor campaigns.' },
    ],
  },

  creative_lead: {
    icon: 'pen-tool',
    tagline: 'Review and approve designs, manage the designer queue, own brand guidelines.',
    readOnly: false,
    widgets: [
      { key: 'tasks_in_review',   label: 'Tasks in Review', hint: 'Awaiting you', live: false },
      { key: 'awaiting_approval', label: 'Awaiting Approval',hint: 'Final sign-off', live: false },
      { key: 'on_time_pct',       label: 'On-time %',       hint: 'Delivery', live: false },
      { key: 'performance_lift',  label: 'Performance Lift',hint: 'Creative impact', live: false },
    ],
    sections: [
      { label: 'Design Task Queue', planned: true, desc: 'Auto-generated briefs (AI-flagged).' },
      { label: 'Review & Approve',  planned: true, desc: 'Markup, versions, sign-off.' },
      { label: 'Brand Guidelines',  planned: true, desc: 'Brand kit & asset library.' },
    ],
  },

  graphic_designer: {
    icon: 'image',
    tagline: 'Work the auto-generated design task queue; upload creatives for approval.',
    readOnly: false,
    widgets: [
      { key: 'assigned_tasks', label: 'Assigned Tasks', hint: 'Your queue', live: false },
      { key: 'in_progress',    label: 'In Progress',    hint: 'Working', live: false },
      { key: 'in_review',      label: 'In Review',      hint: 'Submitted', live: false },
      { key: 'due_today',      label: 'Due Today',      hint: 'Deadlines', live: false },
    ],
    sections: [
      { label: 'My Design Tasks', planned: true, desc: 'Kanban: brief, assets, deadline, "why".' },
      { label: 'Upload Creative', planned: true, desc: 'Submit drafts for review.' },
    ],
  },

  finance_accounts: {
    icon: 'dollar-sign',
    tagline: 'Commission receivable / payable, receipts, refunds and TDS.',
    readOnly: false,
    widgets: [
      { key: 'commission_receivable', label: 'Receivable',   hint: 'From builders', live: false },
      { key: 'commission_payable',    label: 'Payable',      hint: 'To staff / CP', live: false },
      { key: 'receipts_mtd',          label: 'Receipts (MTD)',hint: 'Collected', live: false },
      { key: 'tds_deducted',          label: 'TDS Deducted', hint: 'By builders', live: false },
      { key: 'refunds_pending',       label: 'Refunds Pending',hint: 'To process', live: false },
    ],
    sections: [
      { label: 'Bookings & Payments', href: '/admin/bookings', desc: 'Receipts & token payments.' },
      { label: 'Commission Ledger',   planned: true,           desc: 'Receivable/payable, ageing, GST.' },
    ],
  },

  legal: {
    icon: 'book',
    tagline: 'Agreement templates, builder contracts, RERA, and document review.',
    readOnly: false,
    widgets: [
      { key: 'agreements_pending', label: 'Agreements Pending', hint: 'Drafting', live: false },
      { key: 'contracts_active',   label: 'Active Contracts',   hint: 'Builder tie-ups', live: false },
      { key: 'rera_docs',          label: 'RERA Docs',          hint: 'Per project', live: false },
      { key: 'reviews_pending',    label: 'Reviews Pending',    hint: 'Awaiting you', live: false },
    ],
    sections: [
      { label: 'Agreement Templates', planned: true, desc: 'Standard clauses, carpet-area only.' },
      { label: 'Builder Contracts',   planned: true, desc: 'Tie-up agreements & RERA.' },
      { label: 'Document Review',     planned: true, desc: 'Compliance sign-off.' },
    ],
  },

  it_admin: {
    icon: 'cpu',
    tagline: 'User accounts, integrations, and audit logs. (The current admin role.)',
    readOnly: false,
    widgets: [
      { key: 'total_users',     label: 'User Accounts',  hint: 'Active', live: false },
      { key: 'integrations',    label: 'Integrations',   hint: 'Connected', live: false },
      { key: 'audit_today',     label: 'Audit Events',   hint: 'Today', live: false },
      { key: 'open_issues',     label: 'Open Issues',    hint: 'Support', live: false },
    ],
    sections: [
      { label: 'Employee Management', href: '/admin/employees',       desc: 'Provision, deactivate, assign.' },
      { label: 'Audit / History Log', href: '/admin/history',         desc: 'Immutable change record.' },
      { label: 'Export Control',      href: '/admin/export-control',  desc: 'Data export governance.' },
    ],
  },

  // ===================================================================
  // HR (4)
  // ===================================================================

  hr_head: {
    icon: 'award',
    tagline: 'Policy, hiring approvals, and access to all employee data.',
    readOnly: false,
    widgets: [
      { key: 'headcount',         label: 'Headcount',        hint: 'Active employees', live: false },
      { key: 'attrition',         label: 'Attrition',        hint: 'Trailing 12 mo', live: false },
      { key: 'open_positions',    label: 'Open Positions',   hint: 'Hiring', live: false },
      { key: 'pending_approvals', label: 'Hiring Approvals', hint: 'Awaiting you', live: false },
    ],
    sections: [
      { label: 'All Employee Data', href: '/admin/employees', desc: 'Full access to employee records.' },
      { label: 'HR Policy',         planned: true,            desc: 'Policies & handbook.' },
      { label: 'Hiring Approvals',  planned: true,            desc: 'Approve offers & headcount.' },
    ],
  },

  hr_manager: {
    icon: 'user-check',
    tagline: 'Recruitment, onboarding, exits, and grievance handling.',
    readOnly: false,
    widgets: [
      { key: 'open_positions',     label: 'Open Positions',   hint: 'In pipeline', live: false },
      { key: 'candidates',         label: 'Candidates',       hint: 'In process', live: false },
      { key: 'onboarding',         label: 'Onboarding',       hint: 'In flight', live: false },
      { key: 'grievances_open',    label: 'Open Grievances',  hint: 'To resolve', live: false },
    ],
    sections: [
      { label: 'Employee Directory', href: '/admin/employees', desc: 'Records & manager mapping.' },
      { label: 'Recruitment',        planned: true,            desc: 'JD, pipeline, interviews, offer.' },
      { label: 'Onboarding / Exits', planned: true,            desc: 'Joining & F&F / clearance.' },
      { label: 'Grievances',         planned: true,            desc: 'Cases & resolution.' },
    ],
  },

  hr_executive: {
    icon: 'calendar',
    tagline: 'Attendance, leave, and document collection.',
    readOnly: false,
    widgets: [
      { key: 'present_today', label: 'Present Today', hint: 'Checked in', live: false },
      { key: 'on_leave',      label: 'On Leave',      hint: 'Today', live: false },
      { key: 'pending_leave', label: 'Leave Requests',hint: 'Pending', live: false },
      { key: 'docs_pending',  label: 'Docs Pending',  hint: 'Collection', live: false },
    ],
    sections: [
      { label: 'Employee Directory', href: '/admin/employees', desc: 'Contact & document status.' },
      { label: 'Attendance',         planned: true,            desc: 'Office & field check-ins.' },
      { label: 'Leave Management',    planned: true,            desc: 'CL/SL/PL, approvals, balances.' },
      { label: 'Document Collection', planned: true,            desc: 'ID, education, offer letters.' },
    ],
  },

  payroll_officer: {
    icon: 'credit-card',
    tagline: 'Salary processing and statutory filings (PF, ESI, PT, TDS).',
    readOnly: false,
    widgets: [
      { key: 'payroll_run',     label: 'Payroll Run',     hint: 'This month', live: false },
      { key: 'salary_processed',label: 'Salary Processed',hint: 'Employees', live: false },
      { key: 'statutory_due',   label: 'Statutory Due',   hint: 'PF/ESI/PT/TDS', live: false },
      { key: 'payslips_pending',label: 'Payslips Pending',hint: 'To issue', live: false },
    ],
    sections: [
      { label: 'Salary Processing', planned: true, desc: 'CTC structure, components, run.' },
      { label: 'Statutory Filings', planned: true, desc: 'PF, ESI, PT, TDS, Form 16.' },
    ],
  },

};
