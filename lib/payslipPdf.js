// =====================================================================
// lib/payslipPdf.js — payslip PDF (Puppeteer, mirrors admin/receipts pattern).
// Output: generated/payslips/<payslip_id>.pdf (generated/ is gitignored).
// pdf_path is cached ONLY when the run is 'paid' (draft/approved numbers can
// still change, so those are re-rendered fresh each request).
// =====================================================================
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const pool = require('../db');

const PDF_DIR = path.join(__dirname, '..', 'generated', 'payslips');
const TEMPLATE = path.join(__dirname, '..', 'views', 'payslip-pdf.ejs');

let browserPromise = null;
async function getBrowser() {
    if (browserPromise) { try { return await browserPromise; } catch (_) { /* relaunch */ } }
    browserPromise = puppeteer.launch({ headless: true });
    return browserPromise;
}

// Loads the payslip, returns a disk path to the PDF (rendering if needed), or null.
async function getOrRenderPayslipPdf(payslipId) {
    const rows = (await pool.query(
        `SELECT p.*, e.name AS emp_name, e.external_id, r.period_month, r.status AS run_status,
                s.pan, s.bank_account, s.bank_ifsc, s.pf_uan
           FROM private.payslips p
           JOIN private.employees e ON e.employee_id = p.employee_id
           JOIN private.payroll_runs r ON r.run_id = p.run_id
           LEFT JOIN private.salary_structure s ON s.employee_id = p.employee_id AND s.deleted_at IS NULL
          WHERE p.payslip_id = $1 AND p.deleted_at IS NULL`, [payslipId])).rows;
    if (!rows.length) return null;
    const ps = rows[0];
    if (ps.pdf_path && fs.existsSync(ps.pdf_path)) return ps.pdf_path;

    fs.mkdirSync(PDF_DIR, { recursive: true });
    const html = await ejs.renderFile(TEMPLATE, { ps });
    const browser = await getBrowser();
    const page = await browser.newPage();
    const filePath = path.join(PDF_DIR, payslipId + '.pdf');
    try {
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.pdf({ path: filePath, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } finally { await page.close().catch(() => {}); }

    if (ps.run_status === 'paid') {
        try { await pool.query(`UPDATE private.payslips SET pdf_path=$1 WHERE payslip_id=$2`, [filePath, payslipId]); } catch (_) {}
    }
    return filePath;
}

module.exports = { getOrRenderPayslipPdf };
