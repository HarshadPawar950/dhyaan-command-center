// =====================================================================
// routes/admin/permissions.js — PERMISSION EDITOR (super-admin only)
// Mount: app.use('/admin', adminPermissionsRoutes)
//   GET  /admin/permissions          -> tiers × permissions matrix grid
//   POST /admin/permissions/toggle   -> grant/revoke ONE role-permission pair
//
// Grants live in private.role_permissions, keyed by ACCESS TIER
// (super_admin | admin | employee). Revoke = soft-delete (deleted_at);
// re-grant clears deleted_at. Every toggle: SAVEPOINT txn + CSRF (global)
// + history_log old->new.
//
// GUARD: the super_admin tier's grants can NEVER be revoked from the UI —
// hard-blocked server-side (belt-and-suspenders with can()'s hard bypass).
// =====================================================================
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { userSafeError } = require('../../lib/safeDbError');
const { ensureSuperAdmin } = require('../../middleware/adminAuth');
const { logFromRequest } = require('../../middleware/historyLogger');

// The three access tiers = grant subjects. (Fine 27-role grants deferred.)
const TIERS = [
    { key: 'super_admin', label: 'Super Admin', locked: true },
    { key: 'admin',       label: 'Admin',       locked: false },
    { key: 'employee',    label: 'Employee',    locked: false },
];
const TIER_KEYS = TIERS.map(t => t.key);
const ENTITY = 'role_permission';

// Fine roles are NOT hardcoded. The editor surfaces (in a separate "Fine Roles"
// section) only roles held by at least one REAL, ACTIVE human (E[0-9]{3,}) via
// private.employee_roles — so the matrix never balloons to empty columns and,
// critically, the ~25 ROLE-LOGIN-* template mappings from migration 004 are
// excluded (role-logins are excluded everywhere). A role appears here the moment
// a real person is assigned it (e.g. ticking "Team Leader" on an employee) and
// disappears when the last real holder is removed. Grants land in the SAME
// private.role_permissions table and resolve PER-PERSON via employee_roles in can().
const MAPPED_FINE_ROLES_SQL = `
    SELECT DISTINCT r.role_key, r.name, r.sort_order
      FROM private.roles r
      JOIN private.employee_roles er ON er.role_key = r.role_key
      JOIN private.employees e       ON e.employee_id = er.employee_id
     WHERE e.status = 'active'::private.employee_status
       AND e.external_id ~ '^E[0-9]{3,}$'
       AND e.email NOT LIKE '%@dhyaan.local'
       AND r.role_key NOT IN ('super_admin','admin','employee')  -- never duplicate a tier column
     ORDER BY r.sort_order`;

function cleanStr(v) {
    return (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
}

async function safe(sql, params = [], fallback = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (err) {
        console.error('[admin/permissions] query failed:', err.message);
        return fallback;
    }
}

// ---------------------------------------------------------------------
// GET /admin/permissions — the matrix.
// ---------------------------------------------------------------------
router.get('/permissions', ensureSuperAdmin, async (req, res) => {
    const permissions = await safe(
        `SELECT key, label, category FROM private.permissions
          WHERE deleted_at IS NULL
          ORDER BY category, key`
    );
    const grantRows = await safe(
        `SELECT role_key, permission_key FROM private.role_permissions
          WHERE deleted_at IS NULL`
    );

    // O(1) lookup map: "role_key|permKey" -> true
    const grantedMap = {};
    for (const g of grantRows) grantedMap[g.role_key + '|' + g.permission_key] = true;

    // group permissions by category, preserving order
    const catOrder = [];
    const byCat = {};
    for (const p of permissions) {
        if (!byCat[p.category]) { byCat[p.category] = []; catOrder.push(p.category); }
        byCat[p.category].push(p);
    }
    const categories = catOrder.map(c => ({ name: c, perms: byCat[c] }));

    // Fine roles = only those with a live employee_roles mapping (separate
    // "Fine Roles" section in the view; same toggle machinery as tiers).
    const fineRoleRows = await safe(MAPPED_FINE_ROLES_SQL);
    const fineRoles = fineRoleRows.map(r => ({
        key: r.role_key, label: r.name || r.role_key, locked: false, fine: true
    }));

    res.render('admin/permissions', {
        pageTitle: 'Permission Editor',
        user: req.session.user,
        csrfToken: req.csrfToken(),
        tiers: TIERS,
        fineRoles,
        categories,
        grantedMap,
        totalPerms: permissions.length,
        totalGrants: grantRows.length,
        flash: req.query.msg || null,
        err: req.query.err || null,
    });
});

// ---------------------------------------------------------------------
// POST /admin/permissions/toggle — grant or revoke one pair.
// ---------------------------------------------------------------------
router.post('/permissions/toggle', ensureSuperAdmin, async (req, res) => {
    const back = (kind, m) => res.redirect('/admin/permissions?' + kind + '=' + encodeURIComponent(m));

    const role_key = cleanStr(req.body.role_key);
    const permission_key = cleanStr(req.body.permission_key);
    const action = cleanStr(req.body.action);

    if (!['grant', 'revoke'].includes(action)) return back('err', 'Unknown action.');

    // Valid subject = one of the 3 tiers, OR a fine role that BOTH exists in
    // private.roles AND has at least one live employee_roles mapping (matching
    // exactly what the editor surfaces — no grants to unmapped/arbitrary roles).
    let subjectOk = TIER_KEYS.includes(role_key);
    if (!subjectOk && role_key) {
        const okRole = await safe(
            `SELECT 1 FROM private.roles r
              WHERE r.role_key = $1
                AND EXISTS (
                    SELECT 1 FROM private.employee_roles er
                      JOIN private.employees e ON e.employee_id = er.employee_id
                     WHERE er.role_key = r.role_key
                       AND e.status = 'active'::private.employee_status
                       AND e.external_id ~ '^E[0-9]{3,}$'
                       AND e.email NOT LIKE '%@dhyaan.local')
              LIMIT 1`,
            [role_key]
        );
        subjectOk = okRole.length > 0;
    }
    if (!subjectOk) return back('err', 'Unknown or unmapped role.');

    const perm = await safe(
        `SELECT key FROM private.permissions WHERE key = $1 AND deleted_at IS NULL`,
        [permission_key]
    );
    if (!perm.length) return back('err', 'Unknown permission.');

    // GUARD: super_admin grants are locked — never revocable from the UI.
    if (role_key === 'super_admin' && action === 'revoke') {
        return back('err', 'Super Admin permissions are locked and cannot be revoked.');
    }

    // Current state (for history old->new + no-op short-circuit).
    const cur = await safe(
        `SELECT deleted_at FROM private.role_permissions
          WHERE role_key = $1 AND permission_key = $2`,
        [role_key, permission_key]
    );
    const currentlyGranted = cur.length > 0 && cur[0].deleted_at === null;
    const oldVal = currentlyGranted ? 'granted' : 'revoked';
    const newVal = action === 'grant' ? 'granted' : 'revoked';
    if (oldVal === newVal) return back('msg', 'No change — already ' + newVal + '.');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_perm');
        if (action === 'grant') {
            await client.query(
                `INSERT INTO private.role_permissions (role_key, permission_key, granted_at, deleted_at)
                 VALUES ($1, $2, now(), NULL)
                 ON CONFLICT (role_key, permission_key)
                 DO UPDATE SET deleted_at = NULL, granted_at = now()`,
                [role_key, permission_key]
            );
        } else {
            await client.query(
                `UPDATE private.role_permissions SET deleted_at = now()
                  WHERE role_key = $1 AND permission_key = $2 AND deleted_at IS NULL`,
                [role_key, permission_key]
            );
        }
        await client.query('RELEASE SAVEPOINT sp_perm');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('[admin/permissions] toggle failed:', err.message);
        return back('err', userSafeError(err, 'Update failed. Please try again.'));
    }
    client.release();

    try {
        await logFromRequest(req, {
            entityType: ENTITY,
            entityId: role_key + ':' + permission_key,
            action: action,
            fieldName: 'grant',
            oldValue: oldVal,
            newValue: newVal,
            notes: (action === 'grant' ? 'Granted ' : 'Revoked ') + permission_key + ' for ' + role_key,
        });
    } catch (e) { console.warn('[admin/permissions] log failed:', e.message); }

    return back('msg', permission_key + ' ' + newVal + ' for ' + role_key + '.');
});

module.exports = router;
