// =====================================================================
// routes/admin/finance-expenses.js — FINANCE MODULE (Phase 1) · Capability A
// Company EXPENSES ledger + managed categories.  Mount: app.use('/admin', ...)
//
// Gating (route-level, never button-level):
//   READ  (list/detail)  -> ensureAdminOrRole('hr_manager') + finance.expenses.view
//                           (admin/super_admin + Drishti read-only)
//   WRITE (new/edit/del,  -> ensureAdminOrRole('hr_manager') + finance.expenses.manage
//                            (mig 049: HR gets manage; >Rs.50k approval stays super)
//          categories)       (Drishti blocked at the tier gate)
//
// Approval (FROZEN): amount > Rs.50,000 raises an approval ticket
//   (action_type='expense_create', payload in new_value) — the expense is
//   NOT created until the Boss approves; the executor lives in approvalEngine.
//   At-or-below threshold saves direct (status='approved').
//
// external_id = EXP-<year>-#### from the ('EXP', year) counter (isolated from
//   DHY-RCPT- by migration 034's PK(series, year)). Soft-delete via deleted_at.
// =====================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const ejs = require('ejs');
const path = require('path');
const { ensureAdminOrRole } = require('../../middleware/ensureAdminOrRole');
const { ensurePermission, can } = require('../../middleware/permissions');
const { createApprovalTicket } = require('../../middleware/approvalEngine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_THRESHOLD = 50000;                 // Rs. — ruling (locked)
const MODES = ['cash', 'bank', 'upi', 'cheque', 'card'];

// READ-ONLY SELECT helper. Mutations below use pool.connect() + SAVEPOINT.
async function safe(sql, params = [], fallback = []) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) {
        console.error('[finance-expenses] query failed:', err.message);
        console.error('   SQL:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

async function renderPartial(name, data) {
    try {
        return await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'admin', 'layout', name + '.ejs'), data);
    } catch (e) { console.error('partial ' + name + ' failed:', e.message); return ''; }
}

// Normalise the expense form body -> clean values (null for blanks).
function cleanExpense(b) {
    const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    const num = (v) => { const n = t(v); return n === null ? null : Number(n); };
    const mode = t(b.payment_mode);
    return {
        expense_date: t(b.expense_date),
        category_id: t(b.category_id),
        amount: num(b.amount),
        paid_to: t(b.paid_to),
        payment_mode: (mode && MODES.includes(mode)) ? mode : null,
        project_id: (t(b.project_id) && UUID_RE.test(b.project_id)) ? b.project_id : null,
        campaign_id: (t(b.campaign_id) && UUID_RE.test(b.campaign_id)) ? b.campaign_id : null,
        notes: t(b.notes),
        receipt_reference: t(b.receipt_reference),
        gst_input_amount: num(b.gst_input_amount),
        is_input_gst_eligible: (b.is_input_gst_eligible === 'on' || b.is_input_gst_eligible === 'true' || b.is_input_gst_eligible === '1'),
    };
}

// Next EXP-<year>-#### using the isolated ('EXP', year) counter row.
async function nextExpenseNo(client) {
    const year = new Date().getFullYear();
    const q = await client.query(
        `INSERT INTO private.receipt_counters (series, year, last_seq) VALUES ('EXP', $1, 1)
           ON CONFLICT (series, year) DO UPDATE SET last_seq = private.receipt_counters.last_seq + 1
           RETURNING last_seq`,
        [year]
    );
    return `EXP-${year}-${String(Number(q.rows[0].last_seq)).padStart(4, '0')}`;
}

// Live categories + attribution option lists for the forms.
async function formOptions() {
    const categories = await safe(
        `SELECT category_id, name, is_input_gst_eligible FROM private.expense_categories
          WHERE deleted_at IS NULL AND active = true ORDER BY sort_order, name`, [], []);
    const projects = await safe(
        `SELECT project_id, title AS name FROM private.projects WHERE deleted_at IS NULL ORDER BY title`, [], []);
    const campaigns = await safe(
        `SELECT campaign_id, name FROM private.campaigns WHERE deleted_at IS NULL ORDER BY name`, [], []);
    return { categories, projects, campaigns };
}

// ---------------------------------------------------------------------
// LIST — expenses (read: admin/super/hr_manager)
// ---------------------------------------------------------------------
router.get('/finance/expenses', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.view'), async (req, res) => {
    const f = { q: (req.query.q || '').trim(), category: (req.query.category || '').trim() };
    const conds = ['e.deleted_at IS NULL'];
    const params = [];
    let i = 1;
    if (f.q) {
        conds.push(`(LOWER(COALESCE(e.paid_to,'')) LIKE $${i} OR LOWER(COALESCE(e.notes,'')) LIKE $${i}
                     OR LOWER(COALESCE(e.external_id,'')) LIKE $${i})`);
        params.push('%' + f.q.toLowerCase() + '%'); i++;
    }
    if (f.category && UUID_RE.test(f.category)) { conds.push(`e.category_id = $${i++}`); params.push(f.category); }
    const where = 'WHERE ' + conds.join(' AND ');

    const expenses = await safe(
        `SELECT e.expense_id, e.external_id, e.expense_date, e.amount, e.paid_to, e.payment_mode,
                e.receipt_reference, e.gst_input_amount, e.is_input_gst_eligible, e.status,
                c.name AS category_name, p.title AS project_name, cm.name AS campaign_name
           FROM private.expenses e
           LEFT JOIN private.expense_categories c ON c.category_id = e.category_id
           LEFT JOIN private.projects p ON p.project_id = e.project_id
           LEFT JOIN private.campaigns cm ON cm.campaign_id = e.campaign_id
           -- projects.title is the project name column (renamed in mig 018)
           ${where}
          ORDER BY e.expense_date DESC, e.created_at DESC`,
        params, []);

    const totalsRow = await safe(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total
           FROM private.expenses e WHERE ${conds.join(' AND ')}`, params, [{ n: 0, total: 0 }]);
    const cats = await safe(
        `SELECT category_id, name FROM private.expense_categories WHERE deleted_at IS NULL ORDER BY sort_order, name`, [], []);

    const canManage = await can(req.session.user, 'finance.expenses.manage', req);
    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Expenses' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Expenses' });

    res.render('admin/finance-expenses-list', {
        csrfToken: req.csrfToken(), pageTitle: 'Expenses', user: req.session.user,
        sidebarHtml, topbarHtml, expenses, filters: f, cats,
        totals: totalsRow[0], canManage, threshold: APPROVAL_THRESHOLD,
        flash: req.query.msg || null,
    });
});

// ---------------------------------------------------------------------
// NEW (form) — manage
// ---------------------------------------------------------------------
router.get('/finance/expenses/new', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const opts = await formOptions();
    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Add Expense' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Add Expense' });
    res.render('admin/finance-expense-new', {
        csrfToken: req.csrfToken(), pageTitle: 'Add Expense', user: req.session.user,
        sidebarHtml, topbarHtml, ...opts, modes: MODES, threshold: APPROVAL_THRESHOLD,
        err: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// NEW (create) — direct if <= threshold, else FROZEN approval ticket
// ---------------------------------------------------------------------
router.post('/finance/expenses/new', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const d = cleanExpense(req.body);
    const back = (m) => '/admin/finance/expenses/new?err=' + encodeURIComponent(m);
    if (!d.expense_date) return res.redirect(back('Expense date is required'));
    if (!d.category_id || !UUID_RE.test(d.category_id)) return res.redirect(back('Category is required'));
    if (d.amount === null || isNaN(d.amount) || d.amount <= 0) return res.redirect(back('Amount must be greater than 0'));

    const u = req.session.user;
    const createdBy = (u && (u.employee_id || u.id)) || null;

    // ABOVE threshold -> FROZEN ticket, no expense row until approved.
    if (d.amount > APPROVAL_THRESHOLD) {
        try {
            const preId = crypto.randomUUID();
            const catRow = (await safe(`SELECT name FROM private.expense_categories WHERE category_id=$1`, [d.category_id], []))[0];
            const label = `Expense Rs.${d.amount.toLocaleString('en-IN')} to ${d.paid_to || '—'} (${catRow ? catRow.name : 'category'})`;
            const ticket = await createApprovalTicket({
                actionType: 'expense_create', targetTable: 'expenses', targetId: preId, targetLabel: label,
                requestedBy: createdBy, requestedByName: (u && u.name) || null,
                reason: `Expense above Rs.${APPROVAL_THRESHOLD.toLocaleString('en-IN')} threshold`,
                newValue: { ...d, created_by: createdBy },
            });
            return res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent(
                `Expense above Rs.${APPROVAL_THRESHOLD.toLocaleString('en-IN')} — sent to Boss for approval (ticket ${String(ticket.approval_id).slice(0, 8)})`));
        } catch (err) {
            console.error('[finance-expenses] ticket failed:', err.message);
            return res.redirect(back(userSafeError(err, 'Could not raise the approval ticket. Please try again.')));
        }
    }

    // AT/BELOW threshold -> direct insert (SAVEPOINT).
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_ins');
        const extId = await nextExpenseNo(client);
        await client.query(
            `INSERT INTO private.expenses
               (external_id, expense_date, category_id, amount, paid_to, payment_mode, project_id,
                campaign_id, notes, receipt_reference, gst_input_amount, is_input_gst_eligible, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved',$13)`,
            [extId, d.expense_date, d.category_id, d.amount, d.paid_to, d.payment_mode, d.project_id,
             d.campaign_id, d.notes, d.receipt_reference, d.gst_input_amount, d.is_input_gst_eligible, createdBy]);
        await client.query('RELEASE SAVEPOINT sp_ins');
        await client.query('COMMIT');
        res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent(`Expense ${extId} recorded`));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[finance-expenses] insert failed:', err.message);
        res.redirect(back(userSafeError(err, 'Could not save the expense. Please try again.')));
    } finally { client.release(); }
});

// ---------------------------------------------------------------------
// EDIT (form) — manage
// ---------------------------------------------------------------------
router.get('/finance/expenses/edit/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Invalid expense id'));
    const rows = await safe(`SELECT * FROM private.expenses WHERE expense_id=$1 AND deleted_at IS NULL`, [id], []);
    if (!rows.length) return res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Expense not found'));
    const opts = await formOptions();
    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Edit Expense' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Edit Expense' });
    res.render('admin/finance-expense-edit', {
        csrfToken: req.csrfToken(), pageTitle: 'Edit Expense', user: req.session.user,
        sidebarHtml, topbarHtml, expense: rows[0], ...opts, modes: MODES,
        err: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// EDIT (update) — manage. Direct (already trusted, route-gated).
// ---------------------------------------------------------------------
router.post('/finance/expenses/edit/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Invalid expense id'));
    const d = cleanExpense(req.body);
    const back = (m) => '/admin/finance/expenses/edit/' + id + '?err=' + encodeURIComponent(m);
    if (!d.expense_date) return res.redirect(back('Expense date is required'));
    if (!d.category_id || !UUID_RE.test(d.category_id)) return res.redirect(back('Category is required'));
    if (d.amount === null || isNaN(d.amount) || d.amount <= 0) return res.redirect(back('Amount must be greater than 0'));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_upd');
        await client.query(
            `UPDATE private.expenses SET
                expense_date=$1, category_id=$2, amount=$3, paid_to=$4, payment_mode=$5, project_id=$6,
                campaign_id=$7, notes=$8, receipt_reference=$9, gst_input_amount=$10,
                is_input_gst_eligible=$11, updated_at=now()
              WHERE expense_id=$12 AND deleted_at IS NULL`,
            [d.expense_date, d.category_id, d.amount, d.paid_to, d.payment_mode, d.project_id,
             d.campaign_id, d.notes, d.receipt_reference, d.gst_input_amount, d.is_input_gst_eligible, id]);
        await client.query('RELEASE SAVEPOINT sp_upd');
        await client.query('COMMIT');
        res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Expense updated'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[finance-expenses] update failed:', err.message);
        res.redirect(back(userSafeError(err, 'Could not update the expense. Please try again.')));
    } finally { client.release(); }
});

// ---------------------------------------------------------------------
// DELETE (soft) — manage
// ---------------------------------------------------------------------
router.post('/finance/expenses/delete/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Invalid expense id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_del');
        await client.query(`UPDATE private.expenses SET deleted_at=now() WHERE expense_id=$1 AND deleted_at IS NULL`, [id]);
        await client.query('RELEASE SAVEPOINT sp_del');
        await client.query('COMMIT');
        res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Expense removed (soft-deleted)'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[finance-expenses] soft-delete failed:', err.message);
        res.redirect('/admin/finance/expenses?msg=' + encodeURIComponent('Could not remove expense'));
    } finally { client.release(); }
});

// ---------------------------------------------------------------------
// CATEGORIES — manage (list + create + edit + soft-delete)
// ---------------------------------------------------------------------
router.get('/finance/categories', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const categories = await safe(
        `SELECT c.category_id, c.name, c.is_input_gst_eligible, c.sort_order, c.active,
                COUNT(e.expense_id) FILTER (WHERE e.deleted_at IS NULL)::int AS used
           FROM private.expense_categories c
           LEFT JOIN private.expenses e ON e.category_id = c.category_id
          WHERE c.deleted_at IS NULL
          GROUP BY c.category_id
          ORDER BY c.sort_order, c.name`, [], []);
    const sidebarHtml = await renderPartial('sidebar', { user: req.session.user, pageTitle: 'Expense Categories' });
    const topbarHtml = await renderPartial('topbar', { user: req.session.user, pageTitle: 'Expense Categories' });
    res.render('admin/finance-categories', {
        csrfToken: req.csrfToken(), pageTitle: 'Expense Categories', user: req.session.user,
        sidebarHtml, topbarHtml, categories, flash: req.query.msg || null, err: req.query.err || null,
    });
});

router.post('/finance/categories/new', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const name = (req.body.name || '').trim();
    const elig = (req.body.is_input_gst_eligible === 'on');
    const sort = Number(req.body.sort_order) || 0;
    if (!name) return res.redirect('/admin/finance/categories?err=' + encodeURIComponent('Name is required'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_cat');
        await client.query(
            `INSERT INTO private.expense_categories (name, is_input_gst_eligible, sort_order) VALUES ($1,$2,$3)`,
            [name, elig, sort]);
        await client.query('RELEASE SAVEPOINT sp_cat');
        await client.query('COMMIT');
        res.redirect('/admin/finance/categories?msg=' + encodeURIComponent('Category added'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const m = /uq_expense_categories_name_live/.test(err.message) ? 'A category with that name already exists' : err.message;
        res.redirect('/admin/finance/categories?err=' + encodeURIComponent(m));
    } finally { client.release(); }
});

router.post('/finance/categories/edit/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/finance/categories?err=' + encodeURIComponent('Invalid category id'));
    const name = (req.body.name || '').trim();
    const elig = (req.body.is_input_gst_eligible === 'on');
    const active = (req.body.active === 'on');
    const sort = Number(req.body.sort_order) || 0;
    if (!name) return res.redirect('/admin/finance/categories?err=' + encodeURIComponent('Name is required'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_catu');
        await client.query(
            `UPDATE private.expense_categories SET name=$1, is_input_gst_eligible=$2, active=$3, sort_order=$4
              WHERE category_id=$5 AND deleted_at IS NULL`,
            [name, elig, active, sort, id]);
        await client.query('RELEASE SAVEPOINT sp_catu');
        await client.query('COMMIT');
        res.redirect('/admin/finance/categories?msg=' + encodeURIComponent('Category updated'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const m = /uq_expense_categories_name_live/.test(err.message) ? 'A category with that name already exists' : err.message;
        res.redirect('/admin/finance/categories?err=' + encodeURIComponent(m));
    } finally { client.release(); }
});

router.post('/finance/categories/delete/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.expenses.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/finance/categories?err=' + encodeURIComponent('Invalid category id'));
    // Block soft-delete if live expenses still reference it (keep aggregates honest).
    const used = await safe(`SELECT COUNT(*)::int n FROM private.expenses WHERE category_id=$1 AND deleted_at IS NULL`, [id], [{ n: 0 }]);
    if (used[0].n > 0) return res.redirect('/admin/finance/categories?err=' + encodeURIComponent(`Cannot remove — ${used[0].n} expense(s) still use it. Deactivate instead.`));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_catd');
        await client.query(`UPDATE private.expense_categories SET deleted_at=now(), active=false WHERE category_id=$1 AND deleted_at IS NULL`, [id]);
        await client.query('RELEASE SAVEPOINT sp_catd');
        await client.query('COMMIT');
        res.redirect('/admin/finance/categories?msg=' + encodeURIComponent('Category removed'));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect('/admin/finance/categories?err=' + encodeURIComponent('Could not remove category'));
    } finally { client.release(); }
});

module.exports = router;
