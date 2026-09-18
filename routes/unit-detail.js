// =============================================================
// routes/unit-detail.js — GET /properties/:id
// 99acres listing-style detail for a single saleable property (unit).
// Read-only, any authenticated user (employees share with leads). Mounted at
// /properties AFTER unit-new/edit/delete so /new and /:id/edit still win.
// =============================================================
const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const { loadUnitView } = require('../lib/projectExtras');
const sheet = require('../lib/propertySheet');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:id', ensureAuthenticated, async (req, res) => {
    const unitId = req.params.id;
    if (!UUID_RE.test(unitId)) {
        return res.status(404).render('404', { pageTitle: 'Not Found' });
    }
    const view = await loadUnitView(unitId);
    if (!view) {
        return res.status(404).render('404', { pageTitle: 'Property Not Found' });
    }
    const u = req.session.user;
    // Owner NAME + PHONE visible to all (CAPTAIN ruling); email/notes = admin/super/HR.
    const canSeeOwnerInternal = !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'
        || (Array.isArray(u.navPerms) && u.navPerms.indexOf('properties.manage') !== -1));
    // Can this user reach the edit form? (manager gate — mirrors unit-edit)
    const canManage = !!u && (u.access_role === 'admin' || u.access_role === 'super_admin'
        || (Array.isArray(u.navPerms) && u.navPerms.indexOf('properties.manage') !== -1));

    res.render('unit-detail', {
        pageTitle: (view.unit.title || view.unit.config || 'Property') + (view.project ? ' — ' + view.project.title : ''),
        user: u,
        unit: view.unit,
        project: view.project,
        map: view.map,
        images: view.images,
        videos: view.videos,
        floorPlans: view.floorPlans,
        sheet,
        canSeeOwnerInternal,
        canManage,
    });
});

module.exports = router;
