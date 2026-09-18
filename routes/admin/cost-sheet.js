// =====================================================================
// routes/admin/cost-sheet.js — PRICING / COST-SHEET GENERATOR
// Mount: app.use('/admin', adminCostSheetRoutes)
// Routes:
//   GET  /admin/cost-sheet           -> cascading picker (builder -> property
//                                       -> unit) + pre-filled editable form
//   POST /admin/cost-sheet/generate  -> compute Maharashtra breakdown, freeze
//                                       a full JSONB snapshot into
//                                       private.cost_sheets (SAVEPOINT txn)
//   GET  /admin/cost-sheet/view/:id  -> branded breakdown, rendered from the
//                                       SNAPSHOT ONLY — never recomputed from
//                                       live pricing_config
// Reads: builders / properties / property_units / pricing_config,
//        all filtered deleted_at IS NULL at every level.
// Rates come from private.pricing_config — never inline.
// SNAPSHOT CONTRACT: snapshot JSONB holds inputs + rates_used + computed +
// display context. Any consumer (view, future PDF) reads the snapshot, so a
// sheet shown to a client is reproducible forever even after rate changes.
// =====================================================================
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
// mig 049: cost sheets gain a fine key. Gate = ensureAdminOrRole('hr_manager')
// (admin/super still pass) + ensurePermission('finance.costsheet.manage')
// (granted to super+admin+hr_manager, so no one with access today is locked out).
const { ensureAdminOrRole } = require('../../middleware/ensureAdminOrRole');
const { ensurePermission } = require('../../middleware/permissions');
const { logFromRequest } = require('../../middleware/historyLogger');

const PDF_DIR = path.join(__dirname, '..', '..', 'generated', 'cost-sheets');
const PDF_TEMPLATE = path.join(__dirname, '..', '..', 'views', 'admin', 'cost-sheet-pdf.ejs');

// One shared headless Chromium for the always-on server; relaunched if it
// ever dies. Launching per-request would cost ~2s every download.
let browserPromise = null;
async function getBrowser() {
    if (browserPromise) {
        try {
            const b = await browserPromise;
            if (b.connected) return b;
        } catch (err) { /* fall through to relaunch */ }
    }
    browserPromise = puppeteer.launch({ headless: true });
    return browserPromise;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM_RE = /^[0-9]+(\.[0-9]+)?$/;
const SQFT_PER_SQM = 10.7639;
const GST_STATUSES = ['pre_launch', 'under_construction'];

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/cost-sheet] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// numeric columns arrive from pg as strings; blanks/junk -> null
function num(v) {
    if (v === undefined || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------
// GET /admin/cost-sheet — picker + pre-filled pricing form
// ---------------------------------------------------------------------
router.get('/cost-sheet', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.costsheet.manage'), async (req, res) => {
    const q = req.query || {};
    const builderId  = UUID_RE.test(q.builder_id || '')  ? q.builder_id  : null;
    const propertyId = UUID_RE.test(q.project_id || '') ? q.project_id : null;
    const unitId     = UUID_RE.test(q.property_id || '')     ? q.property_id     : null;

    const builders = await safe(
        `SELECT builder_id, name
           FROM private.builders
          WHERE deleted_at IS NULL
          ORDER BY name ASC`,
        [], []
    );

    let properties = [];
    if (builderId) {
        properties = await safe(
            `SELECT project_id, title, construction_status, rera_number
               FROM private.projects
              WHERE builder_id = $1 AND deleted_at IS NULL
              ORDER BY title ASC`,
            [builderId], []
        );
    }

    // property must belong to the selected builder and be active
    const property = propertyId
        ? (properties.find(p => p.project_id === propertyId) || null)
        : null;

    let units = [];
    if (property) {
        units = await safe(
            `SELECT property_id, config, carpet_sqft, price_text, price_lakhs,
                    floor_number, floor_rise_per_sqft, plc_amount,
                    expected_price, carpet_area
               FROM private.properties
              WHERE project_id = $1 AND deleted_at IS NULL
              ORDER BY config ASC, COALESCE(expected_price/100000.0, price_lakhs) ASC NULLS LAST`,
            [property.project_id], []
        );
    }

    // unit must belong to the selected property and be active
    const unit = unitId ? (units.find(u => u.property_id === unitId) || null) : null;

    const rateRows = await safe(
        `SELECT key, value FROM private.pricing_config WHERE deleted_at IS NULL`,
        [], []
    );
    const rate = {};
    rateRows.forEach(r => { rate[r.key] = num(r.value); });

    // active leads for the optional "For lead" picker (walk-ins skip it)
    const leads = unit ? await safe(
        `SELECT lead_id, name, COALESCE(phone, '') AS phone
           FROM private.leads
          WHERE deleted_at IS NULL
          ORDER BY name ASC`,
        [], []
    ) : [];

    // ---- pre-fill: NULL-safe, dirty-data-safe, always editable ----
    let prefill = null;
    const hints = [];
    if (unit && property) {
        // 019: prefer expected_price (already ₹) then legacy price_lakhs.
        const expected = num(unit.expected_price);
        const priceLakhs = num(unit.price_lakhs);
        const basePrice = expected !== null ? Math.round(expected)
                        : (priceLakhs !== null ? Math.round(priceLakhs * 100000) : null);
        if (basePrice === null) {
            hints.push('No price on record for this unit — enter the base price manually.');
        }

        // 019: prefer numeric carpet_area, else parse the legacy carpet_sqft text.
        const carpetArea = num(unit.carpet_area);
        const rawCarpet = (unit.carpet_sqft || '').trim();
        const carpet = carpetArea !== null ? carpetArea
                     : (NUM_RE.test(rawCarpet) ? parseFloat(rawCarpet) : null);
        if (carpet === null && rawCarpet) {
            hints.push('Carpet area on record is "' + rawCarpet + '" — not a clean number, enter it manually.');
        } else if (carpet === null) {
            hints.push('No carpet area on record for this unit.');
        }

        const gstApplies = GST_STATUSES.includes(property.construction_status);
        if (!gstApplies) {
            hints.push('Project is ' + property.construction_status.replace(/_/g, ' ') + ' — GST does not apply (editable below).');
        }

        // affordable pre-hint ONLY when carpet parsed cleanly (manual decision)
        const carpetSqm = carpet !== null ? carpet / SQFT_PER_SQM : null;
        const affordableHint = !!(
            gstApplies &&
            carpetSqm !== null && basePrice !== null &&
            carpetSqm <= (rate.affordable_carpet_sqm || 60) &&
            basePrice <= (rate.affordable_value_cap || 4500000)
        );
        if (affordableHint) {
            hints.push('Unit fits the affordable-housing thresholds — GST 1% pre-selected, confirm before generating.');
        }

        if (!property.rera_number) {
            hints.push('This project has NO RERA number on record — the sheet will print "RERA: ____". Add it on the property for a compliant sheet.');
        }

        prefill = {
            base_price:          basePrice !== null ? basePrice : '',
            carpet_sqft:         carpet !== null ? carpet : '',
            raw_carpet:          rawCarpet,
            floor_number:        unit.floor_number !== null && unit.floor_number !== undefined ? unit.floor_number : '',
            floor_rise_per_sqft: num(unit.floor_rise_per_sqft) !== null ? num(unit.floor_rise_per_sqft) : '',
            plc_amount:          num(unit.plc_amount) !== null ? num(unit.plc_amount) : '',
            other_charges:       '',
            gst_applies:         gstApplies,
            gst_affordable:      affordableHint,
            women_buyer:         false
        };
    }

    res.render('admin/cost-sheet', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Cost Sheet Generator',
        user: req.session.user,
        builders,
        properties,
        units,
        selected: { builderId, propertyId, unitId },
        property,
        unit,
        prefill,
        hints,
        rate,
        leads,
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// GET /admin/cost-sheet/history — every generated sheet, newest first.
// 25/page; filters by project, lead name/phone, date range. All display
// values come from the frozen snapshot — never recomputed.
// ---------------------------------------------------------------------
router.get('/cost-sheet/history', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.costsheet.manage'), async (req, res) => {
    const q = req.query || {};
    const PER_PAGE = 25;
    let page = parseInt(q.page, 10);
    if (isNaN(page) || page < 1) page = 1;

    // sanitised filters (bad input degrades to "no filter", never to SQL)
    const fProperty = UUID_RE.test(q.project_id || '') ? q.project_id : null;
    const fLead = (q.lead_q || '').trim().slice(0, 80);
    const fFrom = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
    const fTo   = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '')   ? q.to   : null;

    const where = ['cs.deleted_at IS NULL'];
    const params = [];
    if (fProperty) {
        params.push(fProperty);
        where.push(`cs.snapshot->'context'->>'project_id' = $${params.length}`);
    }
    if (fLead) {
        params.push('%' + fLead + '%');
        where.push(`(cs.snapshot->'context'->>'lead_name' ILIKE $${params.length}
                     OR cs.snapshot->'context'->>'lead_phone' LIKE $${params.length})`);
    }
    if (fFrom) {
        params.push(fFrom);
        where.push(`cs.created_at >= $${params.length}::date`);
    }
    if (fTo) {
        params.push(fTo);
        where.push(`cs.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const whereSql = where.join(' AND ');

    const countRows = await safe(
        `SELECT count(*)::int AS n FROM private.cost_sheets cs WHERE ${whereSql}`,
        params, [{ n: 0 }]
    );
    const total = countRows[0].n;
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (page > totalPages) page = totalPages;

    // PER_PAGE/offset are code-controlled integers; user input stays in $n params
    const sheets = await safe(
        `SELECT cs.cost_sheet_id, cs.created_at,
                cs.snapshot->'context'->>'builder_name'      AS builder_name,
                cs.snapshot->'context'->>'property_title'    AS property_title,
                cs.snapshot->'context'->>'unit_config'       AS unit_config,
                cs.snapshot->'context'->>'lead_name'         AS lead_name,
                cs.snapshot->'context'->>'lead_phone'        AS lead_phone,
                cs.snapshot->'context'->>'generated_by_name' AS generated_by_name,
                cs.snapshot->'computed'->>'total_all_in'     AS total_all_in
           FROM private.cost_sheets cs
          WHERE ${whereSql}
       ORDER BY cs.created_at DESC
          LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
        params, []
    );

    // project filter options: only projects that actually have sheets
    const projects = await safe(
        `SELECT DISTINCT snapshot->'context'->>'project_id'    AS project_id,
                         snapshot->'context'->>'property_title' AS title
           FROM private.cost_sheets
          WHERE deleted_at IS NULL
            AND snapshot->'context'->>'project_id' IS NOT NULL
          ORDER BY 2 ASC`,
        [], []
    );

    res.render('admin/cost-sheet-history', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Cost Sheet History',
        user: req.session.user,
        sheets,
        projects,
        filters: { project_id: fProperty || '', lead_q: fLead, from: fFrom || '', to: fTo || '' },
        page, totalPages, total, perPage: PER_PAGE
    });
});

// ---------------------------------------------------------------------
// The one place the math lives. All rupee outputs are whole-rupee
// integers (Math.round) so the snapshot never carries float dust.
// ---------------------------------------------------------------------
function computeSheet(inputs, rate) {
    const floorRiseTotal = Math.round(
        (inputs.floor_rise_per_sqft || 0) * (inputs.floor_number || 0) * (inputs.carpet_sqft || 0)
    );
    const agreementValue = Math.round(inputs.base_price) + floorRiseTotal + Math.round(inputs.plc_amount || 0);

    const gstRate = inputs.gst_applies
        ? (inputs.gst_affordable ? rate.gst_affordable : rate.gst_standard)
        : 0;
    const gst = Math.round(agreementValue * gstRate);

    const stampDutyRate = inputs.women_buyer ? rate.stamp_duty_women : rate.stamp_duty;
    const stampDuty = Math.round(agreementValue * stampDutyRate);

    const registration = Math.min(
        Math.round(agreementValue * rate.registration_rate),
        Math.round(rate.registration_cap)
    );

    const otherCharges = Math.round(inputs.other_charges || 0);
    const totalAllIn = agreementValue + gst + stampDuty + registration + otherCharges;

    return {
        rates_used: {
            gst_rate: gstRate,
            stamp_duty_rate: stampDutyRate,
            registration_rate: rate.registration_rate,
            registration_cap: Math.round(rate.registration_cap)
        },
        computed: {
            floor_rise_total: floorRiseTotal,
            agreement_value: agreementValue,
            gst: gst,
            stamp_duty: stampDuty,
            registration: registration,
            other_charges: otherCharges,
            total_all_in: totalAllIn
        }
    };
}

// ---------------------------------------------------------------------
// POST /admin/cost-sheet/generate — compute + freeze snapshot
// ---------------------------------------------------------------------
router.post('/cost-sheet/generate', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.costsheet.manage'), async (req, res) => {
    const b = req.body || {};
    const backTo = '/admin/cost-sheet'
        + '?builder_id=' + encodeURIComponent(UUID_RE.test(b.builder_id || '') ? b.builder_id : '')
        + '&project_id=' + encodeURIComponent(UUID_RE.test(b.project_id || '') ? b.project_id : '')
        + '&property_id=' + encodeURIComponent(UUID_RE.test(b.property_id || '') ? b.property_id : '');
    const fail = (msg) => res.redirect(backTo + '&msg=' + encodeURIComponent(msg));

    if (!UUID_RE.test(b.property_id || '')) return fail('Invalid unit — pick again.');

    // Re-verify the unit server-side: active, and joined to its active
    // property + builder (never trust hidden form fields alone).
    const rows = await safe(
        `SELECT u.property_id, u.config, u.carpet_sqft,
                p.project_id, COALESCE(p.title, u.title) AS property_title,
                p.construction_status, p.rera_number,
                bl.builder_id, bl.name AS builder_name
           FROM private.properties u
           LEFT JOIN private.projects p ON p.project_id = u.project_id AND p.deleted_at IS NULL
           LEFT JOIN private.builders bl  ON bl.builder_id = p.builder_id  AND bl.deleted_at IS NULL
          WHERE u.property_id = $1 AND u.deleted_at IS NULL
          LIMIT 1`,
        [b.property_id], []
    );
    if (rows.length === 0) return fail('Unit not found or no longer active.');
    const ctx = rows[0];

    // Inputs: blanks -> 0 (NULL-safe rule), base price must be a real amount
    const inputs = {
        base_price:          num(b.base_price),
        carpet_sqft:         num(b.carpet_sqft) || 0,
        floor_number:        num(b.floor_number) || 0,
        floor_rise_per_sqft: num(b.floor_rise_per_sqft) || 0,
        plc_amount:          num(b.plc_amount) || 0,
        other_charges:       num(b.other_charges) || 0,
        gst_applies:         b.gst_applies === 'on',
        gst_affordable:      b.gst_affordable === 'on',
        women_buyer:         b.women_buyer === 'on'
    };
    if (inputs.base_price === null || inputs.base_price <= 0) {
        return fail('Base price is required and must be above zero.');
    }
    if (inputs.floor_number < 0 || inputs.floor_rise_per_sqft < 0 || inputs.plc_amount < 0 ||
        inputs.carpet_sqft < 0 || inputs.other_charges < 0) {
        return fail('Amounts cannot be negative.');
    }

    // Optional lead attachment. The typed text (lead_display) resolves to a
    // hidden lead_id in the browser; the server re-validates from scratch.
    let lead = null;
    const leadDisplay = (b.lead_display || '').trim();
    if (b.lead_id) {
        if (!UUID_RE.test(b.lead_id)) return fail('Lead not recognised — pick from the list or clear the field.');
        const leadRows = await safe(
            `SELECT lead_id, name, COALESCE(phone, '') AS phone
               FROM private.leads
              WHERE lead_id = $1 AND deleted_at IS NULL
              LIMIT 1`,
            [b.lead_id], []
        );
        if (leadRows.length === 0) return fail('Selected lead not found or no longer active.');
        lead = leadRows[0];
    } else if (leadDisplay !== '') {
        // text typed but never resolved to a real lead — don't silently drop it
        return fail('Lead "' + leadDisplay + '" not recognised — pick from the list or clear the field.');
    }

    // Load live rates ONCE, here. After this point everything is frozen
    // into the snapshot — the view/PDF never touch pricing_config again.
    const rateRows = await safe(
        `SELECT key, value FROM private.pricing_config WHERE deleted_at IS NULL`,
        [], []
    );
    const rate = {};
    rateRows.forEach(r => { rate[r.key] = num(r.value); });
    const REQUIRED = ['gst_affordable', 'gst_standard', 'stamp_duty', 'stamp_duty_women', 'registration_rate', 'registration_cap'];
    const missing = REQUIRED.filter(k => rate[k] === null || rate[k] === undefined);
    if (missing.length > 0) {
        return fail('pricing_config is missing rates: ' + missing.join(', ') + ' — refusing to guess.');
    }

    const result = computeSheet(inputs, rate);

    // v2: adds optional lead_* context fields (additive only — v1 sheets in
    // the DB are never modified, and consumers treat lead_name as optional).
    const snapshot = {
        version: 2,
        inputs: inputs,
        rates_used: result.rates_used,
        computed: result.computed,
        context: {
            builder_id: ctx.builder_id,
            builder_name: ctx.builder_name,
            project_id: ctx.project_id,
            property_title: ctx.property_title,
            construction_status: ctx.construction_status,
            rera_number: ctx.rera_number,           // null -> sheet prints "RERA: ____"
            property_id: ctx.property_id,
            unit_config: ctx.config,
            carpet_on_record: ctx.carpet_sqft,
            lead_id: lead ? lead.lead_id : null,
            lead_name: lead ? lead.name : null,
            lead_phone: lead ? lead.phone : null,
            generated_by_name: (req.session.user && req.session.user.name) || 'unknown'
        }
    };

    const client = await pool.connect();
    let sheetId = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_sheet');
        const ins = await client.query(
            `INSERT INTO private.cost_sheets (property_id, lead_id, generated_by, snapshot)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING cost_sheet_id`,
            [ctx.property_id, lead ? lead.lead_id : null, req.session.user.employee_id, JSON.stringify(snapshot)]
        );
        sheetId = ins.rows[0].cost_sheet_id;
        await client.query('RELEASE SAVEPOINT sp_sheet');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/cost-sheet] snapshot insert failed:', err.message);
        return fail(userSafeError(err, 'Could not save the cost sheet. Please try again.'));
    } finally {
        client.release();
    }

    try {
        await logFromRequest(req, {
            entityType: 'cost_sheet',
            entityId: sheetId,
            action: 'create',
            fieldName: null,
            oldValue: null,
            newValue: String(result.computed.total_all_in),
            notes: (req.session.user.name || 'admin') + ' generated cost sheet for '
                + ctx.property_title + ' / ' + (ctx.config || 'unit')
                + ' — total ₹' + result.computed.total_all_in
        });
    } catch (logErr) {
        console.warn('[admin/cost-sheet] audit log failed:', logErr.message);
    }

    return res.redirect('/admin/cost-sheet/view/' + sheetId);
});

// ---------------------------------------------------------------------
// GET /admin/cost-sheet/view/:id — breakdown FROM THE SNAPSHOT ONLY.
// Deliberately does NOT read pricing_config / properties / units for the
// numbers: what was frozen at generate time is what the client saw.
// ---------------------------------------------------------------------
router.get('/cost-sheet/view/:id', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.costsheet.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const rows = await safe(
        `SELECT cost_sheet_id, property_id, lead_id, generated_by, snapshot, created_at
           FROM private.cost_sheets
          WHERE cost_sheet_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [id], []
    );
    if (rows.length === 0) {
        return res.status(404).render('404', { pageTitle: 'Cost Sheet Not Found' });
    }
    const sheet = rows[0];

    res.render('admin/cost-sheet-view', {
        csrfToken: req.csrfToken(),
        pageTitle: 'Cost Sheet',
        user: req.session.user,
        sheetId: sheet.cost_sheet_id,
        snapshot: sheet.snapshot,
        createdAt: sheet.created_at,
        flash: req.query.msg || null
    });
});

// ---------------------------------------------------------------------
// GET /admin/cost-sheet/view/:id/pdf — branded A4 PDF, FROM THE SNAPSHOT
// ONLY. First download renders + saves the file and records pdf_path;
// later downloads stream the saved file (a quoted sheet never changes).
// ---------------------------------------------------------------------
router.get('/cost-sheet/view/:id/pdf', ensureAdminOrRole('hr_manager', 'HR Manager'), ensurePermission('finance.costsheet.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }

    const rows = await safe(
        `SELECT cost_sheet_id, snapshot, pdf_path, created_at
           FROM private.cost_sheets
          WHERE cost_sheet_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [id], []
    );
    if (rows.length === 0) {
        return res.status(404).render('404', { pageTitle: 'Cost Sheet Not Found' });
    }
    const sheet = rows[0];
    const cx = (sheet.snapshot && sheet.snapshot.context) || {};
    const niceName = ('Dhyaan_CostSheet_' + (cx.property_title || 'sheet') + '_' + (cx.unit_config || ''))
        .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/_$/, '') + '.pdf';

    // already rendered once -> stream the frozen file
    if (sheet.pdf_path && fs.existsSync(sheet.pdf_path)) {
        return res.download(sheet.pdf_path, niceName);
    }

    const filePath = path.join(PDF_DIR, sheet.cost_sheet_id + '.pdf');
    try {
        fs.mkdirSync(PDF_DIR, { recursive: true });
        const html = await ejs.renderFile(PDF_TEMPLATE, {
            snapshot: sheet.snapshot,
            createdAt: sheet.created_at
        });
        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            // networkidle0 so the Playfair/Inter webfonts land before print
            await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
            await page.pdf({
                path: filePath,
                format: 'A4',
                printBackground: true,
                margin: { top: '0', bottom: '0', left: '0', right: '0' }
            });
        } finally {
            await page.close().catch(() => {});
        }
    } catch (err) {
        console.error('[admin/cost-sheet] PDF render failed:', err.message);
        return res.redirect('/admin/cost-sheet/view/' + id + '?msg='
            + encodeURIComponent(userSafeError(err, 'PDF generation failed. Please try again.')));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_pdfpath');
        await client.query(
            `UPDATE private.cost_sheets SET pdf_path = $1
              WHERE cost_sheet_id = $2 AND deleted_at IS NULL`,
            [filePath, id]
        );
        await client.query('RELEASE SAVEPOINT sp_pdfpath');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // PDF exists on disk; a missing pdf_path only means re-render next time
        console.error('[admin/cost-sheet] pdf_path update failed:', err.message);
    } finally {
        client.release();
    }

    return res.download(filePath, niceName);
});

module.exports = router;
module.exports._computeSheet = computeSheet; // exposed for tests only
