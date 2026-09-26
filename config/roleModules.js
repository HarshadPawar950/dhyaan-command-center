// =====================================================================
// config/roleModules.js  —  Per-role "Capabilities & Roadmap"
//
// Each role's functional scope mapped DIRECTLY from the Dhyaan Tech
// Document, phase-tagged per §11 (Phased Rollout):
//   phase: 'now'    -> live (or partially live) in the portal today
//          'p2'     -> Phase 2 (site visit, booking, payments, CP, IVR, RBAC, reports)
//          'p3'     -> Phase 3 (HR, incentive engine, analytics, CRM sync, eSign, KYC)
//          'future' -> Phase 4 (ML scoring, predictive, AI, self-serve) / later
//
// Rendered by views/role-page.ejs as the "Capabilities & Roadmap" block.
// Pure config — add/adjust freely, no migration. Section refs (§) point
// back to the Tech Document so each line is traceable.
// =====================================================================

module.exports = {

  // ---------------- SALES (10) ----------------
  super_admin: [
    { name: 'Tenant Configuration & Settings', phase: 'now',    desc: '§5/§7: business hours, fiscal calendar, GST/stamp-duty rates, templates.' },
    { name: 'User & Role Management',           phase: 'now',    desc: '§7: provisioning, deactivation, role assignment, manager mapping (live).' },
    { name: 'Master Data',                      phase: 'now',    desc: '§7: locations, builders, projects, lead sources, lost reasons, dispositions.' },
    { name: 'Workflow Builder',                 phase: 'p2',     desc: '§7: configurable stages, SLA timers, escalation, mandatory fields.' },
    { name: 'Audit Logs (immutable)',           phase: 'now',    desc: '§7/§9: who changed what, when, from where (history_log + S3 archive).' },
    { name: 'All Dashboards & Reports',         phase: 'now',    desc: '§7: funnel, source ROI, SLA breaches, pipeline forecast.' },
    { name: 'Security & Integrations',          phase: 'p3',     desc: '§8/§9: MFA/SSO, KMS encryption, integration adapters.' },
  ],

  owner_promoter: [
    { name: 'Owner Home Snapshot',          phase: 'p2',     desc: '§14.1: spend | leads | visits | bookings | value | ROI at a glance.' },
    { name: 'Pipeline Value & Cash Position', phase: 'p2',   desc: '§14.1: weighted forecast + tokens/bookings collected vs committed.' },
    { name: 'Drill-downs',                  phase: 'p2',     desc: '§14.2: by project, micro-market, source/campaign, team/executive.' },
    { name: 'Spend vs Bookings Trend',      phase: 'p2',     desc: '§14.2: dual-axis monthly trend — the chart owners actually read.' },
    { name: 'High-value Approvals',         phase: 'p2',     desc: '§14.3: approve/reject discounts with one tap (read-only otherwise).' },
    { name: 'Daily WhatsApp / Weekly PDF',  phase: 'future', desc: '§14.3: 9 AM digest of 5 key numbers; auto-emailed weekly report.' },
  ],

  ceo_director: [
    { name: 'All-access Read Dashboards', phase: 'now', desc: '§5.1: full read across the business.' },
    { name: 'High-value Discount Approval', phase: 'p2', desc: '§5.1/§18: approve discounts above slab.' },
    { name: 'Pipeline Forecast & Funnel', phase: 'p2', desc: '§7: weighted pipeline, funnel by source/project/region.' },
    { name: 'Blended CAC / Overall ROI',  phase: 'p2', desc: '§18.3: owner-view KPIs, commission realized.' },
  ],

  sales_head: [
    { name: 'Cross-region Funnel View',     phase: 'now', desc: '§5.1: leads across all regions and teams.' },
    { name: 'Cross-team Approval Workflows', phase: 'p2', desc: '§5.1: route and clear approvals spanning teams.' },
    { name: 'Region/Team Performance Reports', phase: 'p2', desc: '§7/§18: bookings, conversion, revenue vs target.' },
    { name: 'Lead Export (watermarked)',    phase: 'p2', desc: '§12: anti-leakage controls on exports.' },
  ],

  regional_sales_manager: [
    { name: 'Region Leads & Team',        phase: 'now', desc: '§5.1: own the region’s leads and executives.' },
    { name: 'Lead Reassignment (region)', phase: 'now', desc: '§5.1: redistribute within the region (assign engine).' },
    { name: 'Region Reports',             phase: 'p2',  desc: '§7: region funnel, source ROI, SLA breaches.' },
    { name: 'Team KPI Attainment',        phase: 'p3',  desc: '§18.3: live attainment %, feeds incentive engine.' },
  ],

  project_head: [
    { name: 'Single-project P&L',          phase: 'p2',  desc: '§5.1: spend vs revenue for one project.' },
    { name: 'Team Management & Mapping',   phase: 'now', desc: '§5.1/§7: manage project team & manager mapping.' },
    { name: 'Discount Approvals (to slab)', phase: 'p2', desc: '§5.1/§18: approve discounts up to your slab.' },
    { name: 'Project Funnel & Inventory Pressure', phase: 'p2', desc: '§3.2: availability-aware project view.' },
  ],

  team_leader: [
    { name: 'Team Leads & Daily Review', phase: 'now', desc: '§5.1: team queue + daily review cadence.' },
    { name: 'Reassignment (within team)', phase: 'now', desc: '§5.1: move leads inside the team.' },
    { name: 'SLA Adherence Monitoring',  phase: 'p2',  desc: '§3.1: first-contact SLA, auto-escalation.' },
    { name: 'Follow-up Queue',           phase: 'now', desc: '§3.1: next-action + next-follow-up tracking (live).' },
  ],

  senior_sales_executive: [
    { name: 'Own + Assigned Leads',          phase: 'now',    desc: '§5.1: full lead workspace (live).' },
    { name: 'Site Visit Scheduling',         phase: 'p2',     desc: '§3.3: calendar, gallery, geo check-in.' },
    { name: 'Booking Initiation',            phase: 'p2',     desc: '§3.4: start token/booking workflow.' },
    { name: 'AI Next-best-action & Matches', phase: 'future', desc: '§15: matched properties + conversion guidance.' },
  ],

  sales_executive: [
    { name: 'My Leads + Status Updates',    phase: 'now',    desc: '§5.1: own leads, lifecycle updates (live).' },
    { name: 'Activity Log / Feedback',      phase: 'now',    desc: '§3.1: calls/visits, immutable timeline (live).' },
    { name: 'Site Visit + Geo Check-in',    phase: 'p2',     desc: '§3.3: scheduling + geo-fenced check-in.' },
    { name: 'Cost-sheet Share',             phase: 'p2',     desc: '§3.2: generate shareable cost-sheet PDF.' },
    { name: 'AI Match & Conversion Score',  phase: 'future', desc: '§15.1/§15.2: top properties + conversion probability.' },
    { name: 'Transparent Incentive Calculator', phase: 'p3', desc: '§18.2: see incentive on booking + collection.' },
  ],

  presales_telecaller: [
    { name: 'Lead Qualification Queue', phase: 'now',    desc: '§5.1: qualify and route; cannot book.' },
    { name: 'Call Disposition & Log',   phase: 'now',    desc: '§3.1: disposition tags + activity log (live).' },
    { name: 'Shift Management',          phase: 'p3',     desc: '§6: tele-caller shift scheduling.' },
    { name: 'Optimal Contact-time (AI)', phase: 'future', desc: '§15.2: best time to call from response patterns.' },
  ],

  // ---------------- OPERATIONS (13) ----------------
  builder_kam: [
    { name: 'Builder Master',            phase: 'now', desc: '§3.2: developer profile, RERA, GST, contacts, tie-up (live).' },
    { name: 'Commission Terms',          phase: 'p2',  desc: '§3.2/§18.1: flat % or slab by project/ticket size.' },
    { name: 'Inventory Sync',            phase: 'p2',  desc: '§3.2: API / shared-sheet / manual availability sync.' },
    { name: 'Commission Receivable Follow-up', phase: 'p3', desc: '§18.1: ageing, reminders, builder-confirmed → received.' },
  ],

  crm_ops_manager: [
    { name: 'Lead Routing / Distribution Rules', phase: 'p2',  desc: '§3.1: round-robin, weighted, skill/geo/time rules.' },
    { name: 'Deduplication',                     phase: 'p2',  desc: '§3.1: phone+email fuzzy match within window.' },
    { name: 'Workflow & SLA Configuration',      phase: 'p2',  desc: '§7: stages, SLA timers, escalation.' },
    { name: 'System Configuration / Master Data', phase: 'now', desc: '§7: sources, dispositions, lost reasons.' },
  ],

  sitevisit_coordinator: [
    { name: 'Visit Scheduling Calendar', phase: 'p2', desc: '§3.3: per-executive and per-gallery calendar.' },
    { name: 'Cab / Driver Allocation',   phase: 'p2', desc: '§3.3: Ola/Uber business or in-house fleet.' },
    { name: 'Sales-gallery Roster',      phase: 'p2', desc: '§3.3: gallery staffing & slots.' },
    { name: 'Geo Check-in/out + Feedback', phase: 'p2', desc: '§3.3: geo-fenced check-in, visit feedback, next action.' },
  ],

  event_coordinator: [
    { name: 'Event Setup',           phase: 'p2', desc: '§17: venue, dates, projects, budget, staff, targets.' },
    { name: 'Stall Logistics & Roster', phase: 'p2', desc: '§17: on-ground staffing and stall planning.' },
    { name: 'On-ground Lead Capture', phase: 'p2', desc: '§17: offline form + QR + business-card scan.' },
    { name: 'Live Event Dashboard',  phase: 'p3', desc: '§17: leads/hour, footfall, AI-flagged hot leads.' },
    { name: 'Post-event ROI',        phase: 'p3', desc: '§17: total cost vs leads, visits, bookings, commission.' },
  ],

  subbroker_manager: [
    { name: 'Sub-broker Onboarding + KYC', phase: 'p2', desc: '§3.5: PAN, GST, RERA agent registration.' },
    { name: 'Brochure / Price-list Portal', phase: 'p2', desc: '§3.5: CP-facing portal access.' },
    { name: 'Payout Ledger + TDS',          phase: 'p3', desc: '§3.5/§18.2: sub-brokerage payouts with TDS handling.' },
    { name: 'Sub-broker Performance Scoring', phase: 'future', desc: '§3.5: rank CP partners by quality.' },
  ],

  booking_crm_executive: [
    { name: 'Token Receipt Generation',   phase: 'p2', desc: '§3.4: sequential numbered receipts.' },
    { name: 'Booking → Allotment Workflow', phase: 'p2', desc: '§3.4: builder confirmation → allotment → agreement.' },
    { name: 'eSign + Document Vault',      phase: 'p3', desc: '§3.4: Digio/Leegality eSign; encrypted S3 vault.' },
    { name: 'Customer Communications',     phase: 'p2', desc: '§3.4: post-booking updates & documentation.' },
  ],

  marketing_manager: [
    { name: 'Campaign Management + UTM',     phase: 'p2',     desc: '§13.1: campaigns tagged to project/micro-market.' },
    { name: 'Spend Integrations',            phase: 'p2',     desc: '§4.2b: Meta/Google/portals/Supermetrics daily pull.' },
    { name: 'Attribution Model',             phase: 'p3',     desc: '§13.4: first/last/linear/position-based, offline buckets.' },
    { name: 'Budget Control + CPA Alerts',   phase: 'p2',     desc: '§13.5: live burn vs budget; kill/scale flags.' },
    { name: 'AI Marketing-response Insights', phase: 'future', desc: '§15.3: well-responding vs fatiguing creatives.' },
  ],

  marketing_executive: [
    { name: 'Campaign Execution',        phase: 'p2', desc: '§5.2: run and monitor live campaigns.' },
    { name: 'Lead-source Quality Reports', phase: 'p2', desc: '§5.2/§13.3: CPL, CPQL, source quality.' },
    { name: 'UTM Tagging & Landing Pages', phase: 'p2', desc: '§4.1: capture UTM on every ad lead.' },
  ],

  creative_lead: [
    { name: 'Design Task Queue Management', phase: 'p3',     desc: '§16.2: backlog → assigned → review → approved → published.' },
    { name: 'Review / Approve + Markup',    phase: 'p3',     desc: '§16.2/§16.3: comments, versions, sign-off.' },
    { name: 'Brand Kit / DAM Asset Library', phase: 'p3',    desc: '§16.2: tagged, reusable approved assets in S3.' },
    { name: 'AI-triggered Briefs',          phase: 'future', desc: '§16.1/§15.3: auto-created tasks from performance signals.' },
  ],

  graphic_designer: [
    { name: 'Kanban Task Board',          phase: 'p3', desc: '§16.3: brief, assets, deadline, and the "why".' },
    { name: 'Draft Upload + Versioning',  phase: 'p3', desc: '§16.3: one-click upload, version history.' },
    { name: 'Format / Platform Specs',    phase: 'p3', desc: '§16.2: platform-sized creative sets.' },
  ],

  finance_accounts: [
    { name: 'Commission Receivable + Ageing', phase: 'p3', desc: '§18.1: outstanding by builder, ageing, follow-up.' },
    { name: 'Commission Payable / Incentives', phase: 'p3', desc: '§18.2: staff & sub-broker payouts, cash-flow guardrail.' },
    { name: 'Receipts & Token Payments',      phase: 'p2', desc: '§3.4: Razorpay/PayU token receipts.' },
    { name: 'Refunds & TDS Tracking',         phase: 'p3', desc: '§18.1: TDS deducted by builder, refunds.' },
    { name: 'GST Invoicing',                  phase: 'p3', desc: '§18.1: commission invoicing with GST.' },
  ],

  legal: [
    { name: 'Agreement Templates',     phase: 'p3', desc: '§9: standard clauses, carpet-area-only in agreements.' },
    { name: 'Builder Contract Management', phase: 'p3', desc: '§3.2: tie-up agreements & exclusivity.' },
    { name: 'RERA Compliance',         phase: 'p2', desc: '§9: RERA reg. displayed on all promotion.' },
    { name: 'Document Review + DPDP',  phase: 'p3', desc: '§9: consent, purpose limitation, right to erasure.' },
  ],

  it_admin: [
    { name: 'User Accounts & Provisioning', phase: 'now', desc: '§7: create/deactivate users (live).' },
    { name: 'Integrations Management',      phase: 'p3',  desc: '§4: lead-source, CRM sync, comms adapters.' },
    { name: 'Audit Logs',                   phase: 'now', desc: '§7/§9: immutable append-only log + CloudTrail.' },
    { name: 'Access: MFA / SSO',            phase: 'p3',  desc: '§9: least-privilege, JIT elevation for admin actions.' },
  ],

  // ---------------- HR (4) ----------------
  hr_head: [
    { name: 'All Employee Data Access', phase: 'now', desc: '§6: full employee master visibility.' },
    { name: 'HR Policy & Handbook',     phase: 'p3',  desc: '§6: policies, leave types, holiday calendar.' },
    { name: 'Hiring Approvals & Headcount', phase: 'p3', desc: '§6: approve offers & headcount plans.' },
    { name: 'Attrition & HR Analytics', phase: 'p3',  desc: '§7: attrition, attendance, leave dashboards.' },
  ],

  hr_manager: [
    { name: 'Employee Master & Directory', phase: 'now', desc: 'Personal, employment, contact & document records (live).' },
    { name: 'Recruitment (lightweight ATS)', phase: 'p3', desc: '§6: JD, candidate pipeline, interview scheduling, offer.' },
    { name: 'Onboarding Workflow',         phase: 'p3', desc: '§6: structured joining checklist & document collection.' },
    { name: 'Exit Management',             phase: 'p3', desc: '§6: resignation workflow, F&F calculation, clearance.' },
    { name: 'Grievance Handling',          phase: 'p3', desc: 'Case intake, assignment, resolution tracking.' },
    { name: 'Performance (KRA / 1:1 / PIP)', phase: 'p3', desc: '§6: monthly KRA, dashboards, 1:1 notes, PIPs.' },
  ],

  hr_executive: [
    { name: 'Attendance', phase: 'p3', desc: '§6: office biometric/web + field geo-fenced selfie check-in.' },
    { name: 'Leave Management', phase: 'p3', desc: '§6: CL/SL/PL/comp-off, approval chain, balance, Maharashtra holidays.' },
    { name: 'Document Collection', phase: 'p3', desc: '§6: ID proof, education, offer letter intake.' },
    { name: 'Shift Management', phase: 'p3', desc: '§6: tele-caller / field shift scheduling.' },
  ],

  payroll_officer: [
    { name: 'Salary Processing & CTC',     phase: 'p3',     desc: '§6: CTC structure, components, deductions.' },
    { name: 'Statutory Filings',           phase: 'p3',     desc: '§6: PF, ESI, PT (Maharashtra), TDS, gratuity, Form 16.' },
    { name: 'Incentive Engine Payout',     phase: 'p3',     desc: '§6/§18.2: auto-compute on booking, payout on collection.' },
    { name: 'Payroll Integration',         phase: 'future', desc: '§6: export to Keka / Zoho People / Darwinbox / GreytHR.' },
  ],

};
