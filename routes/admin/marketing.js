// =====================================================================
// routes/admin/marketing.js — MARKETING SPEND & ROI (admin + boss)
// Mount: app.use('/admin', adminMarketingRoutes)
// Routes:
//   GET  /admin/marketing               -> dashboard (KPIs + per-campaign ROI)
//   GET  /admin/marketing/campaign-new  -> add campaign form
//   POST /admin/marketing/campaign-new  -> create campaign
//   GET  /admin/marketing/spend-new     -> log spend form
//   POST /admin/marketing/spend-new     -> create spend record
// Attribution chain: spend_records -> campaigns -> leads(campaign_id) -> payments(lead_id)
// Booking metrics read from private.payments (auto-activate when data exists).
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { ensureAdmin } = require('../../middleware/adminAuth');
const { ensurePermission } = require('../../middleware/permissions');

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/marketing] query failed:', err.message);
        console.error('   SQL was:', sql.substring(0, 160).replace(/\s+/g, ' '));
        return fallback;
    }
}

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
router.get('/marketing', ensureAdmin, ensurePermission('marketing.view'), async (req, res) => {

    // ---- Headline totals ----
    const totalSpendRow = await safe(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM private.spend_records`,
        [], [{ v: 0 }]
    );
    const totalSpend = Number(totalSpendRow[0].v) || 0;

    const campaignCountRow = await safe(
        `SELECT COUNT(*)::int AS c FROM private.campaigns WHERE deleted_at IS NULL`,
        [], [{ c: 0 }]
    );

    const totalLeadsRow = await safe(
        `SELECT COUNT(*)::int AS c FROM private.leads
          WHERE campaign_id IS NOT NULL AND deleted_at IS NULL`,
        [], [{ c: 0 }]
    );
    const attributedLeads = totalLeadsRow[0].c;

    // bookings & value from payments (status confirmed/received OR any if status null)
    const bookingRow = await safe(
        `SELECT COUNT(*)::int AS bookings, COALESCE(SUM(p.amount),0)::numeric AS value
           FROM private.payments p
           JOIN private.leads l ON l.lead_id = p.lead_id
          WHERE l.campaign_id IS NOT NULL`,
        [], [{ bookings: 0, value: 0 }]
    );
    const bookings = bookingRow[0].bookings;
    const bookingValue = Number(bookingRow[0].value) || 0;

    // ---- Blended metrics ----
    const cpl = attributedLeads > 0 ? (totalSpend / attributedLeads) : 0;
    const cpa = bookings > 0 ? (totalSpend / bookings) : 0;
    const roas = totalSpend > 0 ? (bookingValue / totalSpend) : 0;
    const convRate = attributedLeads > 0 ? (bookings / attributedLeads * 100) : 0;

    // ---- Per-campaign breakdown with ROI ----
    const campaigns = await safe(
        `SELECT
            c.campaign_id,
            c.name,
            c.platform,
            c.micro_market,
            c.status,
            c.monthly_budget,
            COALESCE(s.spend, 0)::numeric        AS spend,
            COALESCE(ld.leads, 0)::int           AS leads,
            COALESCE(bk.bookings, 0)::int        AS bookings,
            COALESCE(bk.value, 0)::numeric       AS booking_value
           FROM private.campaigns c
           LEFT JOIN (
             SELECT campaign_id, SUM(amount) AS spend
               FROM private.spend_records GROUP BY campaign_id
           ) s ON s.campaign_id = c.campaign_id
           LEFT JOIN (
             SELECT campaign_id, COUNT(*) AS leads
               FROM private.leads
              WHERE campaign_id IS NOT NULL AND deleted_at IS NULL
              GROUP BY campaign_id
           ) ld ON ld.campaign_id = c.campaign_id
           LEFT JOIN (
             SELECT l.campaign_id, COUNT(*) AS bookings, SUM(p.amount) AS value
               FROM private.payments p
               JOIN private.leads l ON l.lead_id = p.lead_id
              WHERE l.campaign_id IS NOT NULL
              GROUP BY l.campaign_id
           ) bk ON bk.campaign_id = c.campaign_id
          WHERE c.deleted_at IS NULL
          ORDER BY spend DESC, c.created_at DESC`,
        [], []
    );

    // compute per-row derived metrics in JS (cleaner than nested SQL)
    campaigns.forEach(c => {
        c.spend = Number(c.spend) || 0;
        c.booking_value = Number(c.booking_value) || 0;
        c.cpl = c.leads > 0 ? (c.spend / c.leads) : 0;
        c.cpa = c.bookings > 0 ? (c.spend / c.bookings) : 0;
        c.roas = c.spend > 0 ? (c.booking_value / c.spend) : 0;
    });

    res.render('admin/marketing-dashboard', {
        pageTitle: 'Marketing Spend & ROI',
        user: req.session.user,
        kpis: {
            totalSpend, campaignCount: campaignCountRow[0].c,
            attributedLeads, bookings, bookingValue,
            cpl, cpa, roas, convRate
        },
        campaigns
    });
});

// ---------------------------------------------------------------------
// ADD CAMPAIGN
// ---------------------------------------------------------------------
router.get('/marketing/campaign-new', ensureAdmin, ensurePermission('marketing.view'), async (req, res) => {
    const projects = await safe(
        `SELECT project_id, title FROM private.projects
          WHERE deleted_at IS NULL ORDER BY title LIMIT 200`,
        [], []
    );
    res.render('admin/marketing-campaign-new', {
        pageTitle: 'New Campaign',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        projects
    });
});

router.post('/marketing/campaign-new', ensureAdmin, ensurePermission('marketing.view'), async (req, res) => {
    const { name, platform, project_id, micro_market, utm_source, utm_medium,
            utm_campaign, start_date, end_date, monthly_budget } = req.body;

    if (!name || !platform) {
        req.flash('error', 'Campaign name and platform are required.');
        return res.redirect('/admin/marketing/campaign-new');
    }

    try {
        await pool.query(
            `INSERT INTO private.campaigns
                (name, platform, project_id, micro_market, utm_source, utm_medium,
                 utm_campaign, start_date, end_date, monthly_budget)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [name, platform,
             project_id || null, micro_market || null,
             utm_source || null, utm_medium || null, utm_campaign || null,
             start_date || null, end_date || null,
             monthly_budget ? Number(monthly_budget) : 0]
        );
        req.flash('success', `Campaign "${name}" created.`);
        res.redirect('/admin/marketing');
    } catch (err) {
        console.error('[marketing/campaign-new] failed:', err.message);
        req.flash('error', 'Could not create campaign — see server log.');
        res.redirect('/admin/marketing/campaign-new');
    }
});

// ---------------------------------------------------------------------
// LOG SPEND
// ---------------------------------------------------------------------
router.get('/marketing/spend-new', ensureAdmin, ensurePermission('marketing.view'), async (req, res) => {
    const campaigns = await safe(
        `SELECT campaign_id, name, platform FROM private.campaigns
          WHERE deleted_at IS NULL ORDER BY name`,
        [], []
    );
    res.render('admin/marketing-spend-new', {
        pageTitle: 'Log Spend',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        campaigns,
        preselect: req.query.campaign || ''
    });
});

router.post('/marketing/spend-new', ensureAdmin, ensurePermission('marketing.view'), async (req, res) => {
    const { campaign_id, spend_date, amount, impressions, clicks, platform_leads } = req.body;

    if (!campaign_id || !amount) {
        req.flash('error', 'Campaign and amount are required.');
        return res.redirect('/admin/marketing/spend-new');
    }

    try {
        await pool.query(
            `INSERT INTO private.spend_records
                (campaign_id, spend_date, amount, impressions, clicks, platform_leads, source)
             VALUES ($1,$2,$3,$4,$5,$6,'manual')`,
            [campaign_id,
             spend_date || new Date().toISOString().slice(0, 10),
             Number(amount) || 0,
             impressions ? Number(impressions) : 0,
             clicks ? Number(clicks) : 0,
             platform_leads ? Number(platform_leads) : 0]
        );
        req.flash('success', 'Spend logged.');
        res.redirect('/admin/marketing');
    } catch (err) {
        console.error('[marketing/spend-new] failed:', err.message);
        req.flash('error', 'Could not log spend — see server log.');
        res.redirect('/admin/marketing/spend-new');
    }
});

module.exports = router;
