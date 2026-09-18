// =====================================================================
// routes/admin/receipts.js — TOKEN RECEIPTS (admin + boss)
// Mount: app.use('/admin', adminReceiptsRoutes)
// Routes:
//   POST /admin/bookings/:id/receipt  -> issue a token receipt for a booking
//                                        (payment). Gapless number, snapshot,
//                                        SAVEPOINT txn. PDF rendered lazily.
//   GET  /admin/receipts              -> list issued receipts
//   GET  /admin/receipts/:id/pdf      -> branded A4 PDF, FROM THE SNAPSHOT ONLY
//                                        (render-once -> save -> stream frozen).
// Numbering: DHY-RCPT-<year>-#### via private.receipt_counters, incremented with
//   INSERT ... ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1 RETURNING
//   — a row lock, so concurrent issues serialize. NOT max()+1.
// Multiple receipts per booking allowed (staged token payments).
// Cost-sheet module is untouched: this file owns its OWN headless Chromium.
// =====================================================================
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');
const { logFromRequest } = require('../../middleware/historyLogger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PDF_DIR = path.join(__dirname, '..', '..', 'generated', 'receipts');
const PDF_TEMPLATE = path.join(__dirname, '..', '..', 'views', 'admin', 'receipt-pdf.ejs');

// Own shared headless Chromium (cost-sheet keeps its own — we never touch it).
let browserPromise = null;
async function getBrowser() {
    if (browserPromise) {
        try {
            const b = await browserPromise;
            if (b.connected) return b;
        } catch (err) { /* relaunch */ }
    }
    browserPromise = puppeteer.launch({ headless: true });
    return browserPromise;
}

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/receipts] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// Rupees -> Indian-English words (frozen into the snapshot at issue time so a
// printed receipt reads identically forever). Whole rupees only.
function rupeesToWords(n) {
    n = Math.round(Number(n) || 0);
    if (n === 0) return 'Zero Rupees Only';
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
        'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = (x) => x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '');
    const three = (x) => (x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + two(x % 100) : '') : two(x));
    let out = '';
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    const rest = n;
    if (crore) out += three(crore) + ' Crore ';
    if (lakh) out += three(lakh) + ' Lakh ';
    if (thousand) out += three(thousand) + ' Thousand ';
    if (rest) out += three(rest);
    return out.trim() + ' Rupees Only';
}

// ---------------------------------------------------------------------
// POST /admin/bookings/:id/receipt — issue a token receipt for a booking.
// ---------------------------------------------------------------------
router.post('/bookings/:id/receipt', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const paymentId = req.params.id;
    if (!UUID_RE.test(paymentId)) {
        req.flash('error', 'Invalid booking.');
        return res.redirect('/admin/bookings');
    }
    const amountIn = Number(req.body.amount);
    if (!req.body.amount || isNaN(amountIn) || amountIn <= 0) {
        req.flash('error', 'A valid receipt amount (above zero) is required.');
        return res.redirect('/admin/bookings');
    }
    const method = (req.body.method || '').toString().trim().slice(0, 40) || null;

    const client = await pool.connect();
    let receiptId = null, receiptNo = null;
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_receipt');

        // 1. Re-load the booking (payment) + its lead/property/builder for the snapshot.
        const payQ = await client.query(
            `SELECT p.payment_id, p.external_id, p.amount, p.method AS booking_method,
                    p.status::text AS payment_status, p.booking_stage::text AS booking_stage, p.paid_at,
                    l.name AS lead_name, COALESCE(l.phone,'') AS lead_phone,
                    pr.title AS property_title, b.name AS builder_name
               FROM private.payments p
               LEFT JOIN private.leads l      ON l.lead_id = p.lead_id
               LEFT JOIN private.projects pr ON pr.project_id = p.project_id
               LEFT JOIN private.builders b   ON b.builder_id = pr.builder_id
              WHERE p.payment_id = $1`,
            [paymentId]
        );
        if (payQ.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error', 'Booking not found.');
            return res.redirect('/admin/bookings');
        }
        const bk = payQ.rows[0];

        // 2. Gapless, concurrency-safe number (row lock via ON CONFLICT DO UPDATE).
        const year = new Date().getFullYear();
        // Counter re-keyed to PK(series, year) in migration 034 — DHY-RCPT draws
        // from its own series so it can never collide with the EXP- expense series.
        const seqQ = await client.query(
            `INSERT INTO private.receipt_counters (series, year, last_seq) VALUES ('DHY-RCPT', $1, 1)
             ON CONFLICT (series, year) DO UPDATE SET last_seq = private.receipt_counters.last_seq + 1
             RETURNING last_seq`,
            [year]
        );
        const seq = Number(seqQ.rows[0].last_seq);
        receiptNo = `DHY-RCPT-${year}-${String(seq).padStart(4, '0')}`;

        // 3. Freeze the snapshot — everything the printed receipt shows.
        const issuedAt = new Date().toISOString();
        const snapshot = {
            version: 1,
            receipt_no: receiptNo,
            seq, seq_year: year,
            issued_at: issuedAt,
            amount: Math.round(amountIn),
            amount_words: rupeesToWords(amountIn),
            method,
            booking: {
                external_id: bk.external_id,
                total_amount: Number(bk.amount) || 0,
                payment_status: bk.payment_status,
                booking_stage: bk.booking_stage,
                paid_at: bk.paid_at
            },
            lead: { name: bk.lead_name || null, phone: bk.lead_phone || null },
            property: { title: bk.property_title || null, builder_name: bk.builder_name || null },
            generated_by_name: (req.session.user && req.session.user.name) || 'Admin'
        };

        // 4. Insert the receipt (unique receipt_no + (seq_year,seq) guard the number).
        const ins = await client.query(
            `INSERT INTO private.token_receipts
                (receipt_no, seq, seq_year, payment_id, amount, method, snapshot, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
             RETURNING receipt_id`,
            [receiptNo, seq, year, paymentId, Math.round(amountIn), method,
             JSON.stringify(snapshot),
             (req.session.user && (req.session.user.employee_id || req.session.user.id)) || null]
        );
        receiptId = ins.rows[0].receipt_id;

        await client.query('RELEASE SAVEPOINT sp_receipt');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[receipts/issue] failed:', err.message);
        req.flash('error', 'Could not issue receipt — see server log.');
        return res.redirect('/admin/bookings');
    } finally {
        client.release();
    }

    try {
        await logFromRequest(req, {
            entityType: 'token_receipt', entityId: receiptId, action: 'create',
            notes: `Receipt ${receiptNo} issued — ₹${Math.round(amountIn)}`
        });
    } catch (e) { /* logging never blocks */ }

    req.flash('success', `Receipt ${receiptNo} issued (₹${Math.round(amountIn)}). Open it to download the PDF.`);
    return res.redirect('/admin/receipts');
});

// ---------------------------------------------------------------------
// GET /admin/receipts — issued receipts, newest first.
// ---------------------------------------------------------------------
router.get('/receipts', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const receipts = await safe(
        `SELECT tr.receipt_id, tr.receipt_no, tr.amount, tr.method, tr.created_at,
                tr.snapshot->'lead'->>'name'      AS lead_name,
                tr.snapshot->'property'->>'title' AS property_title,
                tr.snapshot->'booking'->>'external_id' AS booking_ref,
                (tr.pdf_path IS NOT NULL) AS has_pdf
           FROM private.token_receipts tr
          WHERE tr.deleted_at IS NULL
          ORDER BY tr.created_at DESC
          LIMIT 200`,
        [], []
    );
    const totRow = await safe(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total
           FROM private.token_receipts WHERE deleted_at IS NULL`,
        [], [{ n: 0, total: 0 }]
    );
    res.render('admin/receipts-list', {
        pageTitle: 'Token Receipts',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        receipts,
        stats: { count: totRow[0].n, total: Number(totRow[0].total) || 0 },
        // flash confirmations (routes flash under success/error; the global
        // middleware reads a different key, so pass them through explicitly).
        messages: { success: req.flash('success'), error: req.flash('error') }
    });
});

// ---------------------------------------------------------------------
// GET /admin/receipts/:id/pdf — branded A4, FROM THE SNAPSHOT ONLY.
// First download renders + saves + records pdf_path; later downloads stream.
// ---------------------------------------------------------------------
router.get('/receipts/:id/pdf', ensureAdmin, ensurePermission('bookings.manage'), async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(404).render('404', { pageTitle: 'Not Found' });

    const rows = await safe(
        `SELECT receipt_id, receipt_no, snapshot, pdf_path, created_at
           FROM private.token_receipts
          WHERE receipt_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [id], []
    );
    if (rows.length === 0) return res.status(404).render('404', { pageTitle: 'Receipt Not Found' });
    const rc = rows[0];
    const niceName = (rc.receipt_no || 'receipt').replace(/[^A-Za-z0-9_-]+/g, '_') + '.pdf';

    // already rendered once -> stream the frozen file
    if (rc.pdf_path && fs.existsSync(rc.pdf_path)) {
        return res.download(rc.pdf_path, niceName);
    }

    const filePath = path.join(PDF_DIR, rc.receipt_id + '.pdf');
    try {
        fs.mkdirSync(PDF_DIR, { recursive: true });
        const html = await ejs.renderFile(PDF_TEMPLATE, {
            snapshot: rc.snapshot,
            createdAt: rc.created_at
        });
        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
            await page.pdf({
                path: filePath, format: 'A4', printBackground: true,
                margin: { top: '0', bottom: '0', left: '0', right: '0' }
            });
        } finally {
            await page.close().catch(() => {});
        }
    } catch (err) {
        console.error('[admin/receipts] PDF render failed:', err.message);
        return res.redirect('/admin/receipts?msg=' + encodeURIComponent(userSafeError(err, 'PDF generation failed. Please try again.')));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_pdfpath');
        await client.query(
            `UPDATE private.token_receipts SET pdf_path = $1
              WHERE receipt_id = $2 AND deleted_at IS NULL`,
            [filePath, id]
        );
        await client.query('RELEASE SAVEPOINT sp_pdfpath');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin/receipts] pdf_path update failed:', err.message);
    } finally {
        client.release();
    }

    return res.download(filePath, niceName);
});

module.exports = router;
module.exports._rupeesToWords = rupeesToWords; // exposed for tests only
