// =============================================================
// lib/assistant-kb.js — LOCAL knowledge base for the portal assistant.
// Zero-cost, zero external calls: a curated Q&A set + a simple keyword scorer.
// Paths/labels below were verified against the REAL sidebars
// (views/admin/layout/sidebar.ejs, views/layout/sidebar.ejs, views/hr/layout).
// This module is PURE (no DB, no I/O) so it is trivially unit-testable and
// contains ZERO personal data — the employee-data refusal is guaranteed by
// construction.
// =============================================================

const ENTRIES = [
    // ---------------- LEADS ----------------
    { cat: 'leads', keywords: ['add lead', 'new lead', 'create lead', 'make lead', 'register lead', 'capture lead', 'add a lead'],
      question: 'How do I add a new lead?',
      answer: 'Open your leads list from the sidebar (employees: Manage → My Leads; admins: Manage → All Leads) and click the gold "+ Add New Lead" button. Fill in name, phone, budget, location and requirement, then save.',
      link: '/leads/new' },
    { cat: 'leads', keywords: ['duplicate', 'duplicate phone', 'already exists', 'same number', 'dedup', 'override duplicate', 'number already'],
      question: 'The phone number is flagged as a duplicate — what do I do?',
      answer: 'The system checks the phone number when you add a lead and warns you if it already exists, so the same client is not entered twice. Confirm whether it is truly the same person; if it is a genuinely different lead, follow the on-screen override prompt to proceed.' },
    { cat: 'leads', keywords: ['sla', 'sla badge', 'overdue', 'first touch', 'response time', 'red badge', 'badge'],
      question: 'What do the SLA badges on the leads list mean?',
      answer: 'Each lead row shows an SLA badge based on how long since it was assigned and first contacted. An overdue badge means the first-touch window has passed — call that lead first. Record feedback to update its status.' },
    { cat: 'leads', keywords: ['my team', 'team filter', 'team leads', 'see team', 'view team', 'team leader'],
      question: 'How does the My Team filter work?',
      answer: 'If you are a team leader, your My Leads page shows a Mine / My Team filter. "My Team" adds the active leads of the people who report to you (one level down), deduplicated. Regular members see only their own leads.',
      link: '/leads' },
    { cat: 'leads', keywords: ['feedback', 'add feedback', 'lead note', 'update lead', 'call note'],
      question: 'How do I record feedback on a lead?',
      answer: 'Use Manage → Add Feedback, or open the lead and add a feedback entry. Feedback keeps the lead status and timeline up to date after every call or visit.',
      link: '/feedback' },
    { cat: 'leads', keywords: ['closure', 'close lead', 'mark closed', 'mark closure', 'won', 'lost', 'booked lead'],
      question: 'How do I mark a lead as closed?',
      answer: 'Go to Manage → Mark Closure to record the outcome of a lead (for example booked or lost). This moves it out of your active pipeline.',
      link: '/closure' },
    { cat: 'leads', keywords: ['assign', 'reassign', 'allocate lead', 'transfer lead', 'lead assignment', 'give lead'],
      question: 'How are leads assigned or reassigned?',
      answer: 'Admins use Manage → Lead Assignment to allocate or reassign leads to team members. Ownership lives in the assignment record, so reassigning simply changes who the lead belongs to.',
      link: '/admin/assign' },
    { cat: 'leads', keywords: ['find matches', 'match', 'suggest property', 'best property', 'recommend property', 'suggested properties', 'property match'],
      question: 'How do I find matching properties for a lead?',
      answer: 'Open the lead and click "Find Matches" in the Suggested Properties panel. It scores our live inventory against the lead\'s budget, location and configuration and shows the top 5 with a fit score and reasons, plus a one-click Cost Sheet link.' },
    { cat: 'leads', keywords: ['hot', 'warm', 'cold', 'lead status', 'lead stage', 'status meaning'],
      question: 'What do the lead statuses (hot/warm/cold) mean?',
      answer: 'Statuses are a quick read on how likely a lead is to convert — hot is most engaged, cold is least. Update the status through feedback as the conversation progresses.' },
    { cat: 'leads', keywords: ['follow up', 'followup', 'follow-up', 'next action', 'reminder', 'callback'],
      question: 'Where do I see follow-ups due?',
      answer: 'Admins can review pending follow-ups under Manage → Follow-Ups. Set a next action and date on a lead so it shows up as due.',
      link: '/admin/follow-ups' },

    // ---------------- BOOKINGS & RECEIPTS ----------------
    { cat: 'bookings', keywords: ['booking', 'record booking', 'new booking', 'book flat', 'make booking', 'create booking'],
      question: 'How do I record a booking?',
      answer: 'Go to Manage → Bookings and create a new booking against the property and client. The booking becomes the anchor for token receipts and commission.',
      link: '/admin/bookings' },
    { cat: 'bookings', keywords: ['receipt', 'token receipt', 'make receipt', 'issue receipt', 'payment receipt', 'reciept', 'recipt', 'money receipt'],
      question: 'How do I issue a token receipt?',
      answer: 'Open Manage → Token Receipts to issue a receipt against a booking. Receipt numbers are gapless and sequential, so each receipt gets the next number automatically.',
      link: '/admin/receipts' },
    { cat: 'bookings', keywords: ['booking stage', 'booking status', 'stage', 'booking progress'],
      question: 'What are the booking stages?',
      answer: 'A booking moves through stages as payments come in (for example token received, then further payments). The stage updates as you record receipts against it under Manage → Bookings.',
      link: '/admin/bookings' },
    { cat: 'bookings', keywords: ['receipt number', 'gapless', 'sequence', 'receipt sequence', 'missing receipt number'],
      question: 'Why are receipt numbers sequential with no gaps?',
      answer: 'Receipts use a gapless counter so the numbering is audit-clean — no skipped or duplicated numbers. The next receipt always takes the next number automatically.' },

    // ---------------- COST SHEETS ----------------
    { cat: 'costsheet', keywords: ['cost sheet', 'generate cost sheet', 'costsheet', 'pricing sheet', 'quotation', 'quote', 'price sheet'],
      question: 'How do I generate a cost sheet?',
      answer: 'Go to Manage → Cost Sheets and pick the builder, then the project, then the unit. Review the pricing inputs and click Generate to produce a branded Maharashtra cost sheet (base price, stamp duty, GST, registration).',
      link: '/admin/cost-sheet' },
    { cat: 'costsheet', keywords: ['attach lead', 'cost sheet for lead', 'prepared for', 'cost sheet lead', 'link lead'],
      question: 'Can I attach a lead to a cost sheet?',
      answer: 'Yes — while generating the cost sheet you can type a lead name or phone in the "For Lead" field. The sheet then prints "Prepared for: <name>" and is saved against that lead.',
      link: '/admin/cost-sheet' },
    { cat: 'costsheet', keywords: ['cost sheet history', 'past cost sheets', 'view generated', 'previous cost sheets', 'old cost sheet'],
      question: 'Where do I find previously generated cost sheets?',
      answer: 'Every generated sheet is saved. Use the History link on the Cost Sheets page to browse past sheets by property, lead or date, and reopen the branded view.',
      link: '/admin/cost-sheet/history' },
    { cat: 'costsheet', keywords: ['stamp duty', 'gst', 'registration', 'maharashtra', 'charges', 'taxes'],
      question: 'What charges does the cost sheet calculate?',
      answer: 'The cost sheet builds the Maharashtra all-in figure — base price plus stamp duty, GST and registration, with any floor rise, PLC or other charges you enter. The frozen snapshot is what is saved and printed.',
      link: '/admin/cost-sheet' },

    // ---------------- COMMISSIONS ----------------
    { cat: 'commissions', keywords: ['commission', 'commision', 'brokerage', 'commission lifecycle', 'commission flow'],
      question: 'How does a commission move through the system?',
      answer: 'When a deal closes, a commission receivable is created against the builder. It starts as accrued (earned but unpaid) and becomes payable/received as you record the builder\'s payments under Manage → Commissions.',
      link: '/admin/commissions' },
    { cat: 'commissions', keywords: ['commission receipt', 'record commission', 'commission payment', 'received commission', 'builder paid'],
      question: 'How do I record a commission receipt?',
      answer: 'Open Manage → Commissions, find the receivable, and record the receipt for the amount the builder paid. The outstanding balance updates automatically.',
      link: '/admin/commissions' },
    { cat: 'commissions', keywords: ['status flip', 'auto flip', 'status changed', 'accrued to payable', 'changed automatically', 'why status'],
      question: 'Why did a commission status change on its own?',
      answer: 'Commission status is receipt-gated: it flips from accrued to received once the matching payment is recorded. It is not edited by hand — recording the receipt is what advances it.',
      link: '/admin/commissions' },
    { cat: 'commissions', keywords: ['outstanding', 'unpaid commission', 'receivable', 'pending commission', 'how much commission'],
      question: 'Where do I see outstanding commission?',
      answer: 'Manage → Commissions lists receivables with their outstanding balance. Outstanding is what is still due from builders after the receipts recorded so far.',
      link: '/admin/commissions' },

    // ---------------- SITE VISITS ----------------
    { cat: 'visits', keywords: ['site visit', 'schedule visit', 'book visit', 'plan visit', 'arrange visit', 'visit'],
      question: 'How do I schedule a site visit?',
      answer: 'Go to Manage → Site Visits to schedule a visit for a client and property. You can view visits as a list or on the calendar.',
      link: '/admin/site-visits' },
    { cat: 'visits', keywords: ['calendar', 'month view', 'visit calendar', 'visits calendar', 'week view'],
      question: 'Is there a calendar view for site visits?',
      answer: 'Yes — the Site Visits page has a calendar view showing scheduled visits by day. On a phone it scrolls sideways so every day stays reachable.',
      link: '/admin/site-visits' },
    { cat: 'visits', keywords: ['visit outcome', 'mark visited', 'converted', 'visit result', 'log visit', 'visit done'],
      question: 'How do I log the outcome of a site visit?',
      answer: 'Update the visit under Manage → Site Visits with what happened (completed, booked, cancelled, and so on). This feeds the conversion tracking on the Site Visits dashboard.',
      link: '/admin/site-visits' },

    // ---------------- DAILY REPORTS ----------------
    { cat: 'reports', keywords: ['daily report', 'evening report', 'submit report', 'calls made', 'end of day report', 'my report'],
      question: 'How do I submit my daily report?',
      answer: 'Use Reports → Daily Reports to record your day (calls, follow-ups and notes). This is the evening reporting discipline that sits alongside the system\'s own activity data.',
      link: '/admin/reports/daily' },
    { cat: 'reports', keywords: ['self report', 'system truth', 'discrepancy', 'report mismatch', 'numbers dont match'],
      question: 'Why does my report differ from the system numbers?',
      answer: 'Daily Reports show your self-reported activity next to what the system recorded, so any gap is visible. Both are shown on purpose — record your report honestly and the two should line up.',
      link: '/admin/reports/daily' },

    // ---------------- LEAVE ----------------
    { cat: 'leave', keywords: ['leave', 'apply leave', 'request leave', 'time off', 'off day', 'holiday', 'my leave', 'take leave'],
      question: 'How do I apply for leave?',
      answer: 'Open Manage → My Leave from the sidebar and submit a leave request with the dates and reason. Your manager or HR reviews it from there.',
      link: '/leave' },
    { cat: 'leave', keywords: ['approve leave', 'leave approval', 'pending leave', 'leave requests', 'accept leave'],
      question: 'How do I approve leave requests? (HR/managers)',
      answer: 'HR and managers review requests under the HR Console → Leave Approvals. Approve or reject each pending request there.',
      link: '/hr/leave' },
    { cat: 'leave', keywords: ['leave balance', 'how many leaves', 'remaining leave', 'balance', 'leaves left'],
      question: 'Where do I see my leave balance?',
      answer: 'Your leave balance is shown on the My Leave page along with your past and pending requests.',
      link: '/leave' },

    // ---------------- KPI & TARGETS ----------------
    { cat: 'kpi', keywords: ['kpi', 'performance', 'leaderboard', 'my numbers', 'scorecard', 'target'],
      question: 'Where do I see KPIs and the leaderboard?',
      answer: 'Reports → KPI & Targets shows per-person tiles (leads, conversions, bookings, commission) and a leaderboard for the month.',
      link: '/admin/kpi' },
    { cat: 'kpi', keywords: ['set target', 'monthly target', 'edit target', 'change target', 'assign target'],
      question: 'How are monthly targets set?',
      answer: 'On Reports → KPI & Targets, senior staff can edit the monthly targets used to measure each person. Performance is then shown against those targets.',
      link: '/admin/kpi' },

    // ---------------- LOGIN / PASSWORD ----------------
    { cat: 'login', keywords: ['login', 'log in', 'sign in', 'access portal', 'cant login', 'unable to login'],
      question: 'How do I log in?',
      answer: 'Open the portal in your browser and enter your work email and password on the login page. You will land on your dashboard based on your role.',
      link: '/login' },
    { cat: 'login', keywords: ['password', 'forgot password', 'reset password', 'change password', 'new password', 'locked out'],
      question: 'I forgot my password — how do I reset it?',
      answer: 'There is no self-service reset. Ask an admin to reset your password for you; they can set a new one and you can change it after logging in.' },

    // ---------------- ROLES / ACCESS ----------------
    { cat: 'roles', keywords: ['who can see', 'roles', 'permission', 'access', 'admin employee', 'what can i see', 'visibility'],
      question: 'Who can see what in the portal?',
      answer: 'In plain terms: employees see their own leads and tools; team leaders also see their team\'s leads; admins see everything for the office; super admins additionally manage system settings. Menus you don\'t have access to simply don\'t appear.' },
    { cat: 'roles', keywords: ['missing menu', 'cant see menu', 'no access', 'hidden menu', 'menu missing', 'option missing'],
      question: 'Why can\'t I see a menu that a colleague has?',
      answer: 'The sidebar is role-based, so it only shows what your role can open. If you need a section you don\'t see, ask an admin to grant the right access.' },
    { cat: 'roles', keywords: ['super admin', 'builder master', 'audit log', 'approval center', 'restore', 'export control', 'lead scoring'],
      question: 'What is in the Super Admin area?',
      answer: 'Super Admin (senior staff only) holds Builder Master, Lead Scoring, Owner Dashboard, Audit Log, Restore Archive, Export Control and the Approval Center. These control master data, system oversight and sensitive actions.' },

    // ---------------- FINANCE ----------------
    { cat: 'finance', keywords: ['add expense', 'record expense', 'new expense', 'log expense', 'enter expense', 'expense entry'],
      question: 'How do I add a company expense?',
      answer: 'Open Finance → Expenses from the admin sidebar and click "+ Add Expense". Pick a category (required), enter the date, amount, who it was paid to and the payment mode, and save. You can also attach it to a project or campaign. Expenses above the approval limit go to the Boss for approval before they post.',
      link: '/admin/finance/expenses' },
    { cat: 'finance', keywords: ['expense approval', 'fifty thousand', '50000', '50,000', 'approval limit', 'expense limit', 'big expense', 'approve expense'],
      question: 'What happens to an expense above Rs.50,000?',
      answer: 'Any expense over Rs.50,000 is not saved straight away — it becomes a pending request sent to the super admin (Boss) for approval. It only appears in the expense ledger once approved. At or below Rs.50,000 it saves directly.',
      link: '/admin/finance/expenses' },
    { cat: 'finance', keywords: ['expense category', 'categories', 'category required', 'manage categories', 'add category'],
      question: 'Why does an expense need a category?',
      answer: 'Every expense must have a category (like Rent, Marketing or Travel) so the P&L and GST views can group spending correctly. Managers add or edit categories from the Categories link on the Expenses page.',
      link: '/admin/finance/categories' },
    { cat: 'finance', keywords: ['gst', 'gst summary', 'cash flow', 'cashflow', 'profit and loss', 'p&l', 'pnl', 'profit loss', 'finance reports', 'where finance', 'p and l', 'p & l', 'profit', 'loss report', 'financial statement'],
      question: 'Where are the GST, Cash Flow and P&L reports?',
      answer: 'They live under the Finance section of the admin sidebar: GST Summary (output GST on commissions vs input GST on expenses, net by month), Cash Flow (money in vs money out per month) and Profit & Loss (revenue minus expenses, monthly and for the financial year). They are read-only reports built from live data.',
      link: '/admin/finance/pnl' },

    // ---------------- CLIENT PROFILE (Customer Management) ----------------
    { cat: 'clients', keywords: ['client tabs', 'client profile tabs', 'documents loan goals', 'client sections', 'client detail tabs', 'profile tabs'],
      question: 'What are the tabs on a client profile?',
      answer: 'Open a client from Manage → Client Database and you will see tabs across the top: Overview (contact and portfolio), Documents (KYC and agreements), Loan Status (home-loan progress), Goals (their budget and property preferences) and Referrals (who referred them and whom they referred).',
      link: '/admin/clients' },
    { cat: 'clients', keywords: ['upload kyc', 'client document', 'attach document', 'upload document', 'kyc document', 'client kyc', 'add document'],
      question: 'How do I upload a KYC document for a client?',
      answer: 'Open the client, go to the Documents tab, choose the file (PDF, JPG or PNG, up to 10 MB), pick the type (KYC, agreement, loan paper or other) and upload. The file is stored securely and can be downloaded again from the same tab.',
      link: '/admin/clients' },
    { cat: 'clients', keywords: ['who sees documents', 'document access', 'see kyc', 'private documents', 'document permission', 'view documents'],
      question: 'Who can see a client\'s documents?',
      answer: 'Client documents hold sensitive KYC and financial papers, so only admins and the super admin can view, upload or download them. Loan status and goals are also restricted to admin and super admin in this version.' },
    { cat: 'clients', keywords: ['loan status', 'home loan', 'loan progress', 'bank loan', 'loan stage', 'sanctioned'],
      question: 'Where do I track a client\'s home loan?',
      answer: 'On the client profile, open the Loan Status tab. You can record each loan: the bank, loan amount, sanctioned amount, stage (applied, sanctioned, disbursed or rejected) and the relevant dates. A client can have more than one loan record.',
      link: '/admin/clients' },
    { cat: 'clients', keywords: ['referral', 'referred by', 'who referred', 'referrals', 'referred client'],
      question: 'How do I record who referred a client?',
      answer: 'On the client profile, open the Referrals tab. Pick the referring client (or type a name if they are not in the system) and add any notes. The tab also lists the clients that this client has referred.',
      link: '/admin/clients' },

    // ---------------- LEGAL VAULT ----------------
    { cat: 'legal', keywords: ['legal vault', 'legal', 'agreement', 'noc', 'rera', 'mou', 'legal document', 'upload agreement'],
      question: 'What is the Legal Vault?',
      answer: 'Legal Vault (admin sidebar → Legal) is a secure store for legal papers — agreements, MOUs, RERA certificates, NOCs and KYC — that can be attached to a client, a builder or a project. Pick what it belongs to, choose the file (PDF, JPG or PNG), set the type, party, execution and expiry dates, and upload.',
      link: '/admin/legal' },
    { cat: 'legal', keywords: ['expiry', 'expiring', 'expiry alert', 'document expiry', 'noc expiry', 'rera expiry', 'expiring soon', 'renewal'],
      question: 'Does the system warn me before a legal document expires?',
      answer: 'Yes. Any legal document expiring within the next 30 days — or already past its expiry date and not yet marked expired — shows up in the admin Notifications, flagged so you can renew it in time. Set the expiry date when you upload the document.',
      link: '/admin/notifications' },

    // ---------------- BUILDER PRICE & OFFERS ----------------
    { cat: 'builder', keywords: ['price update', 'price history', 'price revision', 'new price', 'builder price', 'rate change', 'price change'],
      question: 'Where do I see or add builder price updates?',
      answer: 'Open a project (Properties → the project) and scroll to the Price Updates panel. It shows the current price (the latest effective date) with the history below. Managers can add a dated price revision there with the price or note and the source.' },
    { cat: 'builder', keywords: ['offer', 'promotion', 'scheme', 'builder offer', 'active offer', 'discount', 'deal'],
      question: 'Where do builder offers and promotions show?',
      answer: 'Offers appear in the Offers & Promotions panel on both the builder page and the project page. Only current offers are shown to everyone; expired ones drop off the active list automatically. Managers can add an offer with its valid-from and valid-to dates.' },

    // ---------------- POSSESSION ----------------
    { cat: 'possession', keywords: ['possession', 'possession status', 'handover', 'possession date', 'give possession', 'ready possession'],
      question: 'How do I update possession on a booking?',
      answer: 'Possession is tracked per booking. Open the client\'s profile and, in the property portfolio, use the Possession column to set the status (pending, offered or completed) and the possession date. Marking a possession completed requires a possession date.',
      link: '/admin/clients' },

    // ---------------- PAYROLL ----------------
    { cat: 'payroll', keywords: ['run payroll', 'payroll', 'process salary', 'salary run', 'monthly payroll', 'pay salary', 'payroll run'],
      question: 'How does HR run payroll?',
      answer: 'In the HR Console → Payroll, HR picks the month and clicks "Create Draft & Compute". The system prepares a draft payslip for every employee who has a salary structure, working out gross, PF, ESI, professional tax, TDS and any incentives. The draft then goes to the super admin to approve, and only after approval can it be marked paid.',
      link: '/hr/payroll' },
    { cat: 'payroll', keywords: ['approve payroll', 'boss approve', 'two hands', 'approve pay', 'draft approved paid', 'payroll approval'],
      question: 'Who approves payroll before it is paid?',
      answer: 'Payroll moves draft → approved → paid, and only the super admin (Boss) can approve a run and mark it paid — the person who runs payroll cannot approve their own run. This "two hands on salary" is deliberate: no one finalises pay on their own.',
      link: '/hr/payroll' },
    { cat: 'payroll', keywords: ['my payslip', 'payslip', 'salary slip', 'download payslip', 'view payslip', 'my payslips', 'pay slip'],
      question: 'Where do I find my payslips?',
      answer: 'Open "My Payslips" from your sidebar. It lists your finalised monthly payslips with a download button for each. You can only see your own payslips — no one else\'s — and they appear once payroll for the month is marked paid.',
      link: '/payslips' },
    { cat: 'payroll', keywords: ['tds', 'tax deducted', 'income tax', 'tds amount', 'tds calculation', 'how tds'],
      question: 'How is TDS worked out on a payslip?',
      answer: 'TDS is a figure entered by hand — HR types in the monthly TDS amount (based on what your CA provides) and the system carries it onto the payslip. The portal does not calculate income tax itself; only PF, ESI and professional tax are computed from the statutory rates.',
      link: '/hr/payroll' },

    // ---------------- OTHER MODULES ----------------
    { cat: 'other', keywords: ['attendance', 'mark attendance', 'check in', 'punch in', 'my attendance'],
      question: 'How do I mark attendance?',
      answer: 'Attendance is recorded by the HR team now — employees no longer self-punch. If your attendance needs a correction, speak to HR.' },
    { cat: 'other', keywords: ['incentive', 'my incentive', 'earnings', 'my incentives', 'bonus'],
      question: 'Where do I see my incentives?',
      answer: 'Manage → My Incentives shows your incentive earnings. Incentives are receipt-gated, so they firm up as payments are received on your deals.',
      link: '/incentives' },
    { cat: 'other', keywords: ['properties', 'inventory', 'projects', 'browse properties', 'property list', 'units'],
      question: 'Where is the property inventory?',
      answer: 'Open Properties from the sidebar to browse all projects and their units (price, configuration, location). You can share these with your leads.',
      link: '/projects' },
    { cat: 'other', keywords: ['client database', 'client', 'clients', 'promote client', 'client profile'],
      question: 'What is the Client Database?',
      answer: 'Manage → Client Database holds promoted clients and their profiles — the people who have moved beyond being just a lead. Admins manage entries there.',
      link: '/admin/clients' },
    { cat: 'other', keywords: ['walk in', 'walkin', 'walk-in', 'office visitor', 'walkins'],
      question: 'How do I record a walk-in?',
      answer: 'Use Manage → Walk-ins to log a client who walked into the office, so the visit is captured against them.',
      link: '/walkins' },
    { cat: 'other', keywords: ['notification', 'alert', 'notifications', 'bell'],
      question: 'Where are my notifications?',
      answer: 'Admins can review portal notifications under Manage → Notifications. These flag things that need attention.',
      link: '/admin/notifications' },
    { cat: 'help', keywords: ['help', 'what can you do', 'hello', 'hi', 'hey', 'what do you do'],
      question: 'What can this assistant help with?',
      answer: 'I answer how-to questions about using this portal — leads, bookings and receipts, cost sheets, commissions, site visits, daily reports, leave, KPIs, expenses and finance reports, client documents and loans, the legal vault, builder prices and offers, possession, payroll and payslips, and login basics. Ask me where a feature is or how to complete a task.' },
];

// The 6 most common questions, shown as tappable chips when the panel opens.
const QUICK_QUESTIONS = [
    'How do I add a new lead?',
    'How do I generate a cost sheet?',
    'How do I issue a token receipt?',
    'How do I record a booking?',
    'How do I apply for leave?',
    'How do I find matching properties for a lead?',
];

// Below-threshold fallback: friendly + 4 tappable suggestions.
const FALLBACK = {
    text: 'I can help with how-to questions about the portal. Try asking about leads, bookings, receipts, cost sheets, commissions, visits, reports, or leave.',
    suggestions: [
        'How do I add a new lead?',
        'How do I issue a token receipt?',
        'How do I generate a cost sheet?',
        'How do I apply for leave?',
    ],
};

const STOP = new Set(['the', 'a', 'an', 'is', 'do', 'i', 'how', 'to', 'in', 'on', 'of', 'for', 'my', 'me', 'can', 'you', 'what', 'where', 'and', 'this', 'that', 'it', 'with', 'am']);

function tokenize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Score every entry against the query; return the best if it clears threshold.
// Phrase keywords match when ALL their (non-stopword) words appear anywhere in
// the query — order- and adjacency-free, so paraphrases like "make a new
// client lead" still hit the "new lead" keyword. They weigh by word count.
// Single-word keywords weigh 1 and tolerate simple prefix typos
// ("bookin" ~ "booking", "matching" ~ "match").
function match(query, entries = ENTRIES, threshold = 1) {
    const toks = tokenize(query);
    const meaningful = toks.filter(t => !STOP.has(t));
    let best = null, bestScore = 0;

    for (const e of entries) {
        let score = 0;
        for (const k of e.keywords) {
            const words = k.toLowerCase().split(' ').filter(w => !STOP.has(w));
            if (words.length > 1) {
                if (words.every(w => toks.includes(w))) score += words.length;
            } else if (words.length === 1) {
                const kw = words[0];
                const hit = meaningful.some(t =>
                    t === kw || (kw.length >= 4 && (t.startsWith(kw) || kw.startsWith(t))));
                if (hit) score += 1;
            }
        }
        if (score > bestScore) { bestScore = score; best = e; }
    }
    return bestScore >= threshold ? { entry: best, score: bestScore } : null;
}

module.exports = { ENTRIES, QUICK_QUESTIONS, FALLBACK, tokenize, match };
