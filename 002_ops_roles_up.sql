-- =====================================================================
-- 002_ops_roles_up.sql  —  Operations & Support roles (Batch 3)
-- Additive & reversible. Seeds the 13 Operations roles into private.roles.
-- Operations roles are functional silos (flat — no inheritance chain),
-- each carrying its own explicit permission set.
-- Down-migration: 002_ops_roles_down.sql
-- =====================================================================

BEGIN;

INSERT INTO private.roles (role_key, name, category, sort_order, inherits, permissions, description) VALUES
 ('builder_kam','Builder Relationship / KAM','operations',11,NULL,
   '["builders.manage","commission.terms","inventory.sync","payouts.followup"]',
   'Owns builder tie-ups, commission terms, inventory sync, payout follow-up.'),

 ('crm_ops_manager','CRM / Operations Manager','operations',12,NULL,
   '["routing.configure","leads.dedup","system.config","leads.view.all"]',
   'Lead routing rules, deduplication, system configuration.'),

 ('sitevisit_coordinator','Site Visit Coordinator','operations',13,NULL,
   '["sitevisits.schedule","cabs.allocate","gallery.roster"]',
   'Cab allocation, visit scheduling, sales-gallery roster.'),

 ('event_coordinator','Exhibition / Event Coordinator','operations',14,NULL,
   '["events.manage","stall.logistics","leads.capture.onground","events.roi"]',
   'Plans exhibitions, stall logistics, on-ground lead capture, event ROI.'),

 ('subbroker_manager','Sub-broker Manager','operations',15,NULL,
   '["subbroker.onboard","subbroker.payout.approve"]',
   'Sub-broker onboarding, payout approvals.'),

 ('booking_crm_executive','Booking / CRM Executive','operations',16,NULL,
   '["bookings.manage","documents.manage","customer.comms"]',
   'Post-booking operations, documentation, customer communications.'),

 ('marketing_manager','Marketing Manager','operations',17,NULL,
   '["campaigns.manage","utm.attribution","budget.manage","marketing.insights"]',
   'Campaigns, UTM, attribution, budget, AI marketing insights.'),

 ('marketing_executive','Marketing Executive','operations',18,NULL,
   '["campaigns.execute","leadsource.reports"]',
   'Campaign execution, lead-source quality reports.'),

 ('creative_lead','Creative / Design Lead','operations',19,NULL,
   '["designs.review","designs.approve","designer.queue.manage","brand.guidelines"]',
   'Reviews and approves designs, manages designer queue, brand guidelines.'),

 ('graphic_designer','Graphic Designer','operations',20,NULL,
   '["designs.queue.work","designs.upload"]',
   'Works the auto-generated design task queue; uploads creatives for approval.'),

 ('finance_accounts','Finance / Accounts','operations',21,NULL,
   '["commission.receivable","commission.payable","receipts.manage","refunds.manage","tds.manage"]',
   'Commission receivable/payable, receipts, refunds, TDS.'),

 ('legal','Legal','operations',22,NULL,
   '["agreements.templates","contracts.builder","rera.manage","documents.review"]',
   'Agreement templates, builder contracts, RERA, document review.'),

 ('it_admin','IT Admin','operations',23,NULL,
   '["users.manage","integrations.manage","audit.view"]',
   'User accounts, integrations, audit logs. (Current admin role.)')
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
