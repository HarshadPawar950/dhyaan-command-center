// =====================================================================
// routes/admin/clients.js â€” CLIENT DATABASE (admin + boss)
// Mount: app.use('/admin', adminClientsRoutes)
// Routes:
//   GET  /admin/clients              -> list clients + portfolio summary
//   GET  /admin/clients/promote      -> list eligible leads to promote
//   POST /admin/clients/promote/:leadId -> create client from lead (SAVEPOINT)
//   GET  /admin/clients/view/:id     -> client detail + property portfolio
//   GET  /admin/clients/edit/:id     -> edit profile form
//   POST /admin/clients/edit/:id     -> update profile (SAVEPOINT)
//   POST /admin/clients/delete/:id   -> SOFT delete
// Eligible lead = has a booking (payment) OR status='converted', not already a client.
// Portfolio derived from payments(lead_id) -> properties.
// Soft-delete only â€” never hard-delete.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission, can } = require('../../middleware/permissions');
const ejs = require('ejs');
const path = require('path');
async function renderPartial(name, data) {
  try { return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data); }
  catch (e) { console.error('partial ' + name + ' failed:', e.message); return ''; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_TYPES = ['buyer', 'investor', 'end_user'];
const CLIENT_STATUSES = ['active', 'past', 'dormant'];

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/clients] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

function cleanBody(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    let ctype = t(b.client_type) || 'buyer';
    if (!CLIENT_TYPES.includes(ctype)) ctype = 'buyer';
    let status = t(b.status) || 'active';
    if (!CLIENT_STATUSES.includes(status)) status = 'active';
    return {
        name: t(b.name),
        phone: t(b.phone),
        email: t(b.email),
        location: t(b.location),
        client_type: ctype,
        preferences: t(b.preferences),
        investment_profile: t(b.investment_profile),
        requirement: t(b.requirement),
        budget: t(b.budget),
        notes: t(b.notes),
        status: status
    };
}

// ---------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------
router.get('/clients', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const clients = await safe(
        `SELECT c.client_id, c.name, c.phone, c.email, c.location,
                c.client_type, c.status, c.converted_at,
                COUNT(DISTINCT pay.project_id) FILTER (WHERE pay.project_id IS NOT NULL) AS properties,
                COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0)::numeric AS total_paid
           FROM private.clients c
           LEFT JOIN private.payments pay ON pay.lead_id = c.lead_id
          WHERE c.deleted_at IS NULL
          GROUP BY c.client_id
          ORDER BY c.converted_at DESC NULLS LAST, c.name ASC`,
        [], []
    );

    const totalsRow = await safe(
        `SELECT COUNT(*)::int AS total_clients,
                COUNT(*) FILTER (WHERE client_type = 'investor')::int AS investors,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active_clients
           FROM private.clients WHERE deleted_at IS NULL`,
        [], [{ total_clients: 0, investors: 0, active_clients: 0 }]
    );

    res.render('admin/clients-list', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Client Database',
        user: req.session.user,
        clients,
        totals: totalsRow[0],
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// PROMOTE â€” list eligible leads
// ---------------------------------------------------------------------
router.get('/clients/promote', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const leads = await safe(
        `SELECT DISTINCT l.lead_id, l.name, l.phone, l.email, l.status::text AS status,
                l.budget, l.requirement,
                EXISTS (SELECT 1 FROM private.payments p WHERE p.lead_id = l.lead_id) AS has_booking
           FROM private.leads l
          WHERE l.deleted_at IS NULL
            AND (
                  l.status = 'converted'
                  OR EXISTS (SELECT 1 FROM private.payments p WHERE p.lead_id = l.lead_id)
                )
            AND NOT EXISTS (SELECT 1 FROM private.clients c WHERE c.lead_id = l.lead_id AND c.deleted_at IS NULL)
          ORDER BY l.name ASC`,
        [], []
    );

    res.render('admin/clients-promote', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Promote Lead to Client',
        user: req.session.user,
        leads,
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// PROMOTE â€” create client from lead
// ---------------------------------------------------------------------
router.post('/clients/promote/:leadId', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const leadId = req.params.leadId;
    if (!UUID_RE.test(leadId)) return res.redirect('/admin/clients/promote?msg=' + encodeURIComponent('Invalid lead id'));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_promote');

        // Pull the lead
        const leadRows = await client.query(
            `SELECT lead_id, name, phone, email, location, requirement, budget
               FROM private.leads WHERE lead_id = $1 AND deleted_at IS NULL`,
            [leadId]
        );
        if (!leadRows.rows.length) {
            await client.query('ROLLBACK');
            return res.redirect('/admin/clients/promote?msg=' + encodeURIComponent('Lead not found'));
        }
        const l = leadRows.rows[0];

        // Already a client?
        const exists = await client.query(
            `SELECT 1 FROM private.clients WHERE lead_id = $1 AND deleted_at IS NULL`, [leadId]
        );
        if (exists.rows.length) {
            await client.query('ROLLBACK');
            return res.redirect('/admin/clients?msg=' + encodeURIComponent(l.name + ' is already a client'));
        }

        await client.query(
            `INSERT INTO private.clients
                (lead_id, name, phone, email, location, requirement, budget)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [l.lead_id, l.name, l.phone, l.email, l.location, l.requirement, l.budget]
        );
        await client.query('RELEASE SAVEPOINT sp_promote');
        await client.query('COMMIT');
        res.redirect('/admin/clients?msg=' + encodeURIComponent(l.name + ' promoted to client'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/clients] promote failed:', err.message);
        res.redirect('/admin/clients/promote?msg=' + encodeURIComponent(userSafeError(err, 'Could not promote the lead. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// VIEW â€” client detail + portfolio
// ---------------------------------------------------------------------
router.get('/clients/view/:id', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));

    const rows = await safe(
        `SELECT * FROM private.clients WHERE client_id = $1 AND deleted_at IS NULL`, [id], []
    );
    if (!rows.length) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Client not found'));
    const clientRec = rows[0];

    // Portfolio: properties this client has payments against
    const portfolio = await safe(
        `SELECT pr.title, pr.location, pr.builder,
                pay.payment_id, pay.amount, pay.status::text AS pay_status, pay.method, pay.paid_at,
                pay.possession_date, pay.possession_status
           FROM private.payments pay
           LEFT JOIN private.projects pr ON pr.project_id = pay.project_id
          WHERE pay.lead_id = $1
          ORDER BY pay.paid_at DESC NULLS LAST`,
        [clientRec.lead_id], []
    );

    const summaryRow = await safe(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::numeric AS paid,
                COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','partial')),0)::numeric AS outstanding,
                COUNT(DISTINCT project_id)::int AS property_count
           FROM private.payments WHERE lead_id = $1`,
        [clientRec.lead_id], [{ paid: 0, outstanding: 0, property_count: 0 }]
    );
    // Capability A — client documents (metadata only; files stream via gated route)
    const canDocs = await can(req.session.user, 'clients.documents.manage', req);
    const documents = canDocs ? await safe(
        `SELECT doc_id, doc_type, original_name, mime_type, file_size_bytes, notes, created_at
           FROM private.client_documents
          WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC`, [id], []) : [];

    // Capability B — loan records (finance-gated)
    const canFinance = await can(req.session.user, 'clients.finance.manage', req);
    const loans = await safe(
        `SELECT loan_id, bank_name, loan_amount, sanctioned_amount, stage,
                applied_on, sanctioned_on, disbursed_on, notes
           FROM private.client_loans
          WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC`, [id], []);

    // Capability C — investment goals (1:1, finance-gated)
    const goalsRows = await safe(
        `SELECT budget_min, budget_max, property_type, preferred_locations, timeline, purpose, notes
           FROM private.client_goals WHERE client_id = $1 AND deleted_at IS NULL LIMIT 1`, [id], []);
    const goals = goalsRows[0] || null;

    // Capability D — referral: who referred this client + clients THEY referred
    const referrerRows = clientRec.referred_by_client_id ? await safe(
        `SELECT name FROM private.clients WHERE client_id = $1`, [clientRec.referred_by_client_id], []) : [];
    const referrerName = referrerRows.length ? referrerRows[0].name : null;
    const referredClients = await safe(
        `SELECT client_id, name, phone FROM private.clients
          WHERE referred_by_client_id = $1 AND deleted_at IS NULL ORDER BY name`, [id], []);
    const referrerOptions = await safe(
        `SELECT client_id, name FROM private.clients
          WHERE deleted_at IS NULL AND client_id <> $1 ORDER BY name`, [id], []);

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: clientRec.name });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: clientRec.name });
    res.render('admin/client-profile', {
        csrfToken: req.csrfToken(),
        pageTitle: clientRec.name,
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        client: clientRec,
        portfolio,
        summary: summaryRow[0],
        canDocs,
        documents,
        canFinance,
        loans,
        loanStages: ['applied', 'sanctioned', 'disbursed', 'rejected'],
        goals,
        propertyTypes: ['Apartment', 'Villa', 'Plot', 'Row House', 'Commercial', 'Office'],
        referrerName,
        referredClients,
        referrerOptions,
        canBookings: await can(req.session.user, 'bookings.manage', req),
        possessionStatuses: ['pending', 'offered', 'completed'],
        flash: req.query.msg || null,
        err: req.query.err || null
    });
});

// ---------------------------------------------------------------------
// EDIT (form)
// ---------------------------------------------------------------------
router.get('/clients/edit/:id', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));

    const rows = await safe(
        `SELECT * FROM private.clients WHERE client_id = $1 AND deleted_at IS NULL`, [id], []
    );
    if (!rows.length) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Client not found'));

    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Edit Client' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Edit Client' });
    res.render('admin/clients-edit', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Edit Client',
        user: req.session.user,
        sidebarHtml,
        topbarHtml,
        client: rows[0],
        clientTypes: CLIENT_TYPES,
        clientStatuses: CLIENT_STATUSES
    });
});

// ---------------------------------------------------------------------
// EDIT (update) â€” SAVEPOINT
// ---------------------------------------------------------------------
router.post('/clients/edit/:id', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));
    const d = cleanBody(req.body);
    if (!d.name) return res.redirect('/admin/clients/edit/' + id + '?err=' + encodeURIComponent('Name is required'));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_update');
        await client.query(
            `UPDATE private.clients SET
                name=$1, phone=$2, email=$3, location=$4, client_type=$5,
                preferences=$6, investment_profile=$7, requirement=$8,
                budget=$9, notes=$10, status=$11
             WHERE client_id=$12 AND deleted_at IS NULL`,
            [d.name, d.phone, d.email, d.location, d.client_type,
             d.preferences, d.investment_profile, d.requirement,
             d.budget, d.notes, d.status, id]
        );
        await client.query('RELEASE SAVEPOINT sp_update');
        await client.query('COMMIT');
        res.redirect('/admin/clients/view/' + id + '?msg=' + encodeURIComponent('Client updated'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/clients] update failed:', err.message);
        res.redirect('/admin/clients/edit/' + id + '?err=' + encodeURIComponent(userSafeError(err, 'Could not update the client. Please try again.')));
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------
// DELETE (soft)
// ---------------------------------------------------------------------
router.post('/clients/delete/:id', ensureAdmin, ensurePermission('clients.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/clients?msg=' + encodeURIComponent('Invalid client id'));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_softdel');
        await client.query(
            `UPDATE private.clients SET deleted_at = now() WHERE client_id = $1 AND deleted_at IS NULL`,
            [id]
        );
        await client.query('RELEASE SAVEPOINT sp_softdel');
        await client.query('COMMIT');
        res.redirect('/admin/clients?msg=' + encodeURIComponent('Client removed (soft-deleted)'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/clients] soft-delete failed:', err.message);
        res.redirect('/admin/clients?msg=' + encodeURIComponent('Could not remove client'));
    } finally {
        client.release();
    }
});

module.exports = router;






