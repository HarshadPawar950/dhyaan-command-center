// =====================================================================
// routes/admin/builder-pricing.js — PHASE 3 · B + C
// Builder price updates (per project) + offers (builder and/or project).
// Mount: '/admin'. Writes gated by builder.pricing.manage (super+admin).
// Reads surface inside the existing project & builder detail views.
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();

// ---------------------------------------------------------------------
// B. PROJECT PRICE UPDATES
// ---------------------------------------------------------------------
router.post('/projects/:id/price-updates', ensureAdmin, ensurePermission('builder.pricing.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/projects?msg=' + encodeURIComponent('Invalid project id'));
    const effective_date = t(req.body.effective_date);
    const price_note = t(req.body.price_note);
    const source = t(req.body.source);
    const back = (m) => '/admin/projects/' + id + '?err=' + encodeURIComponent(m) + '#pricing';
    if (!effective_date) return res.redirect(back('Effective date is required'));
    if (!price_note) return res.redirect(back('Price / note is required'));
    const u = req.session.user; const by = (u && (u.employee_id || u.id)) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_pu');
        await client.query(
            `INSERT INTO private.project_price_updates (project_id, effective_date, price_note, source, created_by)
             VALUES ($1,$2,$3,$4,$5)`, [id, effective_date, price_note, source, by]);
        await client.query('RELEASE SAVEPOINT sp_pu'); await client.query('COMMIT');
        res.redirect('/admin/projects/' + id + '?msg=' + encodeURIComponent('Price update added') + '#pricing');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not add the price update. Please try again.')));
    } finally { client.release(); }
});

router.post('/projects/:id/price-updates/:puId/delete', ensureAdmin, ensurePermission('builder.pricing.manage'), async (req, res) => {
    const { id, puId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(puId)) return res.redirect('/admin/projects?msg=' + encodeURIComponent('Invalid id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_pud');
        await client.query(`UPDATE private.project_price_updates SET deleted_at=now() WHERE price_update_id=$1 AND project_id=$2 AND deleted_at IS NULL`, [puId, id]);
        await client.query('RELEASE SAVEPOINT sp_pud'); await client.query('COMMIT');
        res.redirect('/admin/projects/' + id + '?msg=' + encodeURIComponent('Price update removed') + '#pricing');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect('/admin/projects/' + id + '?err=' + encodeURIComponent('Could not remove price update') + '#pricing');
    } finally { client.release(); }
});

// ---------------------------------------------------------------------
// C. OFFERS — builder and/or project. Contextual create + delete.
//    Active-list auto-hide of expired is query-side (in the read routes).
// ---------------------------------------------------------------------
function cleanOffer(b) {
    const st = t(b.status);
    return {
        offer_text: t(b.offer_text),
        valid_from: t(b.valid_from),
        valid_to: t(b.valid_to),
        status: (st === 'inactive') ? 'inactive' : 'active',
    };
}

// offer scoped to a BUILDER (may also carry a project_id to scope it further)
router.post('/builders/:id/offers', ensureAdmin, ensurePermission('builder.pricing.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Invalid builder id'));
    const d = cleanOffer(req.body);
    const projectId = (t(req.body.project_id) && UUID_RE.test(req.body.project_id)) ? req.body.project_id : null;
    const back = (m) => '/admin/builders/' + id + '?err=' + encodeURIComponent(m) + '#offers';
    if (!d.offer_text) return res.redirect(back('Offer text is required'));
    const u = req.session.user; const by = (u && (u.employee_id || u.id)) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_of');
        await client.query(
            `INSERT INTO private.offers (builder_id, project_id, offer_text, valid_from, valid_to, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, projectId, d.offer_text, d.valid_from, d.valid_to, d.status, by]);
        await client.query('RELEASE SAVEPOINT sp_of'); await client.query('COMMIT');
        res.redirect('/admin/builders/' + id + '?msg=' + encodeURIComponent('Offer added') + '#offers');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not add the offer. Please try again.')));
    } finally { client.release(); }
});

// offer scoped to a PROJECT
router.post('/projects/:id/offers', ensureAdmin, ensurePermission('builder.pricing.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.redirect('/admin/projects?msg=' + encodeURIComponent('Invalid project id'));
    const d = cleanOffer(req.body);
    const back = (m) => '/admin/projects/' + id + '?err=' + encodeURIComponent(m) + '#offers';
    if (!d.offer_text) return res.redirect(back('Offer text is required'));
    const u = req.session.user; const by = (u && (u.employee_id || u.id)) || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_ofp');
        await client.query(
            `INSERT INTO private.offers (project_id, offer_text, valid_from, valid_to, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6)`, [id, d.offer_text, d.valid_from, d.valid_to, d.status, by]);
        await client.query('RELEASE SAVEPOINT sp_ofp'); await client.query('COMMIT');
        res.redirect('/admin/projects/' + id + '?msg=' + encodeURIComponent('Offer added') + '#offers');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back(userSafeError(e, 'Could not add the offer. Please try again.')));
    } finally { client.release(); }
});

router.post('/offers/:offerId/delete', ensureAdmin, ensurePermission('builder.pricing.manage'), async (req, res) => {
    const id = req.params.offerId;
    const back = t(req.body.back) || '/admin/builders';
    if (!UUID_RE.test(id)) return res.redirect('/admin/builders?msg=' + encodeURIComponent('Invalid offer id'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SAVEPOINT sp_ofd');
        await client.query(`UPDATE private.offers SET deleted_at=now() WHERE offer_id=$1 AND deleted_at IS NULL`, [id]);
        await client.query('RELEASE SAVEPOINT sp_ofd'); await client.query('COMMIT');
        res.redirect(back + '?msg=' + encodeURIComponent('Offer removed') + '#offers');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.redirect(back + '?err=' + encodeURIComponent('Could not remove offer') + '#offers');
    } finally { client.release(); }
});

module.exports = router;
